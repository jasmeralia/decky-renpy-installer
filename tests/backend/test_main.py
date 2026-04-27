import importlib
import json
import sys
import types
import zipfile
from pathlib import Path
from types import SimpleNamespace


class FakeSettingsManager:
    def __init__(self, name: str, settings_directory: str):
        self.data = {}

    def read(self):
        return dict(self.data)

    def getSetting(self, key, default=None):
        return self.data.get(key, default)

    def setSetting(self, key, value):
        self.data[key] = value

    def commit(self):
        return None


def load_main():
    fake_settings = types.ModuleType("settings")
    fake_settings.SettingsManager = FakeSettingsManager
    sys.modules["settings"] = fake_settings
    sys.modules.pop("main", None)
    return importlib.import_module("main")


def make_zip(path: Path, entries: dict[str, bytes]) -> None:
    with zipfile.ZipFile(path, "w") as zf:
        for name, content in entries.items():
            zf.writestr(name, content)


def make_zip_with_modes(path: Path, entries: dict[str, tuple[bytes, int]]) -> None:
    with zipfile.ZipFile(path, "w") as zf:
        for name, (content, mode) in entries.items():
            info = zipfile.ZipInfo(name)
            info.external_attr = mode << 16
            zf.writestr(info, content)


def test_zip_top_folder_detects_single_folder(tmp_path: Path):
    main = load_main()
    zip_path = tmp_path / "game.zip"
    make_zip(zip_path, {"Game/game/script.rpy": b"data", "Game/launcher.sh": b"#!/bin/sh\n"})

    assert main._get_zip_top_folder(zip_path) == "Game"


def test_extract_flat_zip_creates_folder_and_deletes_zip(tmp_path: Path):
    main = load_main()
    zip_path = tmp_path / "Flat Game.zip"
    make_zip(zip_path, {"game/script.rpy": b"data", "launcher.sh": b"#!/bin/sh\n"})
    dest_root = tmp_path / "dest"
    dest_root.mkdir()

    game_dir = Path(main._extract_sync(str(zip_path), str(dest_root)))

    assert game_dir == dest_root / "Flat Game"
    assert (game_dir / "game" / "script.rpy").read_bytes() == b"data"
    assert (game_dir / "launcher.sh").exists()
    assert not zip_path.exists()


def test_extract_makes_all_regular_files_executable(tmp_path: Path):
    main = load_main()
    zip_path = tmp_path / "ProjektPassion-0.17-pc.zip"
    make_zip(
        zip_path,
        {
            "ProjektPassion-0.17-pc/ProjektPassion.sh": b"#!/bin/sh\n",
            "ProjektPassion-0.17-pc/libpy2-linux-x86_64/ProjektPassion": b"binary",
            "ProjektPassion-0.17-pc/game/script.rpy": b"data",
        },
    )
    dest_root = tmp_path / "dest"
    dest_root.mkdir()

    game_dir = Path(main._extract_sync(str(zip_path), str(dest_root)))

    assert (game_dir / "ProjektPassion.sh").stat().st_mode & 0o111
    assert (game_dir / "libpy2-linux-x86_64" / "ProjektPassion").stat().st_mode & 0o111
    assert (game_dir / "game" / "script.rpy").stat().st_mode & 0o111


def test_extract_normalizes_crlf_shell_scripts_only(tmp_path: Path):
    main = load_main()
    zip_path = tmp_path / "Game.zip"
    make_zip(
        zip_path,
        {
            "Game/run.sh": b"#!/bin/sh\r\necho ok\r\n",
            "Game/notes.txt": b"line 1\r\nline 2\r\n",
        },
    )
    dest_root = tmp_path / "dest"
    dest_root.mkdir()

    game_dir = Path(main._extract_sync(str(zip_path), str(dest_root)))

    assert (game_dir / "run.sh").read_bytes() == b"#!/bin/sh\necho ok\n"
    assert (game_dir / "notes.txt").read_bytes() == b"line 1\r\nline 2\r\n"


def test_extract_preserves_existing_mode_bits_when_adding_executable(tmp_path: Path):
    main = load_main()
    zip_path = tmp_path / "Game.zip"
    make_zip_with_modes(
        zip_path,
        {
            "Game/run.sh": (b"#!/bin/sh\n", 0o640),
            "Game/already-executable": (b"binary", 0o755),
        },
    )
    dest_root = tmp_path / "dest"
    dest_root.mkdir()

    game_dir = Path(main._extract_sync(str(zip_path), str(dest_root)))

    assert (game_dir / "run.sh").stat().st_mode & 0o777 == 0o751
    assert (game_dir / "already-executable").stat().st_mode & 0o777 == 0o755


def test_executable_tree_skips_symlinks(tmp_path: Path):
    main = load_main()
    game_dir = tmp_path / "Game"
    target = tmp_path / "outside"
    game_dir.mkdir()
    target.write_text("outside")
    (game_dir / "outside-link").symlink_to(target)

    changed = main._ensure_executable_tree(game_dir)

    assert changed == 0
    assert target.stat().st_mode & 0o111 == 0


def test_extract_existing_folder_errors_and_keeps_zip(tmp_path: Path):
    main = load_main()
    zip_path = tmp_path / "Game.zip"
    make_zip(zip_path, {"Game/launcher.sh": b"#!/bin/sh\n"})
    dest_root = tmp_path / "dest"
    (dest_root / "Game").mkdir(parents=True)

    try:
        main._extract_sync(str(zip_path), str(dest_root))
    except RuntimeError as exc:
        assert "already exists" in str(exc)
    else:
        raise AssertionError("expected RuntimeError")

    assert zip_path.exists()


def test_launcher_discovery_prefers_sh(tmp_path: Path):
    main = load_main()
    game_dir = tmp_path / "Game"
    game_dir.mkdir()
    (game_dir / "run.exe").write_text("exe")
    (game_dir / "run.sh").write_text("#!/bin/sh\n")

    result = importlib.import_module("asyncio").run(main.Plugin().get_launchers(str(game_dir)))

    assert result["type"] == "sh"
    assert result["launchers"] == [str(game_dir / "run.sh")]


def test_save_symlink_created_and_existing_saves_skipped(tmp_path: Path):
    main = load_main()
    game_dir = tmp_path / "Game"
    save_folder = tmp_path / "Dropbox" / "Saves" / "Game"
    (game_dir / "game").mkdir(parents=True)
    save_folder.mkdir(parents=True)

    created = main._create_save_symlink(game_dir, save_folder)
    skipped = main._create_save_symlink(game_dir, save_folder)

    assert created["created"] is True
    assert (game_dir / "game" / "saves").resolve() == save_folder
    assert skipped["skipped"] is True


def test_create_save_folder_creates_immediate_child(tmp_path: Path):
    main = load_main()
    save_root = tmp_path / "Saves"
    save_root.mkdir()

    created = Path(main._create_save_folder(save_root, "New Game"))

    assert created == save_root / "New Game"
    assert created.is_dir()


def test_create_save_folder_rejects_nested_or_invalid_names(tmp_path: Path):
    main = load_main()
    save_root = tmp_path / "Saves"
    save_root.mkdir()

    for folder_name in ("", ".", "..", "../Other", "Nested/Game", "Nested\\Game"):
        try:
            main._create_save_folder(save_root, folder_name)
        except RuntimeError:
            pass
        else:
            raise AssertionError(f"expected RuntimeError for {folder_name!r}")


def test_discover_usb_partitions_from_lsblk(monkeypatch):
    main = load_main()
    payload = {
        "blockdevices": [
            {
                "name": "sda",
                "path": "/dev/sda",
                "type": "disk",
                "tran": "usb",
                "rm": True,
                "fstype": None,
                "label": None,
                "mountpoints": [],
                "children": [
                    {
                        "name": "sda1",
                        "path": "/dev/sda1",
                        "type": "part",
                        "tran": None,
                        "rm": False,
                        "fstype": "exfat",
                        "label": "USB",
                        "mountpoints": ["/run/media/deck/USB"],
                    }
                ],
            },
            {
                "name": "mmcblk0p1",
                "path": "/dev/mmcblk0p1",
                "type": "part",
                "tran": None,
                "rm": False,
                "fstype": "ext4",
                "label": "SD",
                "mountpoints": ["/run/media/deck/SD"],
            },
        ]
    }

    def fake_run(*_args, **_kwargs):
        return SimpleNamespace(returncode=0, stdout=json.dumps(payload), stderr="")

    monkeypatch.setattr(main.subprocess, "run", fake_run)

    partitions = main._discover_usb_partitions()

    assert [p.path for p in partitions] == ["/dev/sda1"]
    assert partitions[0].mountpoints == ["/run/media/deck/USB"]
