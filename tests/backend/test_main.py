import asyncio
import builtins
import importlib
import io
import json
import logging
import os
import subprocess
import sys
import types
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest


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


def test_extract_top_folder_with_suffix_uses_next_available_name(tmp_path: Path):
    main = load_main()
    zip_path = tmp_path / "Game.zip"
    make_zip(zip_path, {"Game/launcher.sh": b"#!/bin/sh\n", "Game/game/script.rpy": b"data"})
    dest_root = tmp_path / "dest"
    (dest_root / "Game").mkdir(parents=True)
    (dest_root / "Game_2").mkdir()

    game_dir = Path(main._extract_sync(str(zip_path), str(dest_root), suffix=True))

    assert game_dir == dest_root / "Game_3"
    assert (game_dir / "launcher.sh").exists()
    assert (game_dir / "game" / "script.rpy").read_bytes() == b"data"
    assert not (game_dir / "Game").exists()
    assert not zip_path.exists()


def test_extract_flat_zip_with_suffix_preserves_existing_folder(tmp_path: Path):
    main = load_main()
    zip_path = tmp_path / "Flat Game.zip"
    make_zip(zip_path, {"launcher.sh": b"#!/bin/sh\n"})
    dest_root = tmp_path / "dest"
    existing = dest_root / "Flat Game"
    existing.mkdir(parents=True)
    (existing / "keep.txt").write_text("existing")

    game_dir = Path(main._extract_sync(str(zip_path), str(dest_root), suffix=True))

    assert game_dir == dest_root / "Flat Game_2"
    assert (game_dir / "launcher.sh").exists()
    assert (existing / "keep.txt").read_text() == "existing"


def test_extract_suffix_choice_still_uses_suffix_if_conflict_disappears(tmp_path: Path):
    main = load_main()
    zip_path = tmp_path / "Game.zip"
    make_zip(zip_path, {"Game/launcher.sh": b"#!/bin/sh\n"})
    dest_root = tmp_path / "dest"
    dest_root.mkdir()

    game_dir = Path(main._extract_sync(str(zip_path), str(dest_root), suffix=True))

    assert game_dir == dest_root / "Game_2"
    assert (game_dir / "launcher.sh").exists()
    assert not (dest_root / "Game").exists()


def test_conflict_check_returns_next_available_suffix(tmp_path: Path):
    main = load_main()
    zip_path = tmp_path / "Game.zip"
    make_zip(zip_path, {"Game/launcher.sh": b"#!/bin/sh\n"})
    dest_root = tmp_path / "dest"
    (dest_root / "Game").mkdir(parents=True)
    (dest_root / "Game_2").mkdir()

    result = asyncio.run(main.Plugin().check_extract_conflict(str(zip_path), str(dest_root)))

    assert result == {
        "conflict": True,
        "folder_name": "Game",
        "suffix_folder_name": "Game_3",
    }


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


@pytest.mark.parametrize(
    ("level", "expected"),
    [
        ("debug", logging.DEBUG),
        ("info", logging.INFO),
        ("warn", logging.WARNING),
        ("error", logging.ERROR),
        ("unexpected", logging.ERROR),
    ],
)
def test_apply_log_level_uses_expected_logging_level(level: str, expected: int):
    main = load_main()

    main._apply_log_level(level)

    assert main.logger.level == expected


def test_get_partition_label_uses_lsblk_and_falls_back(monkeypatch):
    main = load_main()
    results = iter(
        [
            SimpleNamespace(stdout="MY USB\n"),
            SimpleNamespace(stdout="\n"),
        ]
    )
    monkeypatch.setattr(main.subprocess, "run", lambda *_args, **_kwargs: next(results))

    assert main._get_partition_label("/dev/sda1") == "MY USB"
    assert main._get_partition_label("/dev/sdb2") == "sdb2"

    monkeypatch.setattr(
        main.subprocess,
        "run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("lsblk unavailable")),
    )
    assert main._get_partition_label("/dev/sdc3") == "sdc3"


def test_mount_usb_devices_handles_mounted_success_failure_and_timeout(monkeypatch):
    main = load_main()
    partitions = [
        main.UsbPartition("/dev/sda1", "mounted", []),
        main.UsbPartition("/dev/sdb1", "success", []),
        main.UsbPartition("/dev/sdc1", "failure", []),
        main.UsbPartition("/dev/sdd1", "timeout", []),
    ]
    monkeypatch.setattr(main, "_discover_usb_partitions", lambda: partitions)
    monkeypatch.setattr(main, "_get_mounted_devices", lambda: {"/dev/sda1"})
    calls = []

    def fake_run(args, **_kwargs):
        device = args[-2]
        calls.append(device)
        if device == "/dev/sdb1":
            return SimpleNamespace(
                returncode=0,
                stdout="Mounted /dev/sdb1 at /run/media/deck/USB.\n",
                stderr="",
            )
        if device == "/dev/sdc1":
            return SimpleNamespace(returncode=1, stdout="", stderr="denied")
        raise subprocess.TimeoutExpired(args, 15)

    monkeypatch.setattr(main.subprocess, "run", fake_run)

    assert main._mount_usb_devices() == ["/run/media/deck/USB"]
    assert calls == ["/dev/sdb1", "/dev/sdc1", "/dev/sdd1"]


def test_mount_usb_devices_returns_early_without_partitions(monkeypatch):
    main = load_main()
    monkeypatch.setattr(main, "_discover_usb_partitions", lambda: [])
    monkeypatch.setattr(main, "_get_mounted_devices", lambda: set())
    monkeypatch.setattr(main.glob, "glob", lambda _pattern: [])
    run = monkeypatch.setattr(
        main.subprocess,
        "run",
        lambda *_args, **_kwargs: pytest.fail("mount command should not run"),
    )

    assert main._mount_usb_devices() == []
    assert run is None


def test_list_mount_points_merges_lsblk_and_proc_and_filters_stale(monkeypatch, tmp_path: Path):
    main = load_main()
    lsblk_mount = tmp_path / "lsblk"
    proc_mount = "/run/media/deck/PROC"
    stale_mount = tmp_path / "stale"
    lsblk_mount.mkdir()
    monkeypatch.setattr(
        main,
        "_discover_usb_partitions",
        lambda: [main.UsbPartition("/dev/sda1", "USB", [str(lsblk_mount), str(stale_mount)])],
    )
    real_open = builtins.open

    def fake_open(path, *args, **kwargs):
        if path == "/proc/mounts":
            return io.StringIO(
                f"/dev/sdb1 {proc_mount} exfat rw 0 0\n"
                f"/dev/mmcblk0p1 {tmp_path}/sd ext4 rw 0 0\n"
            )
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", fake_open)
    real_listdir = os.listdir

    def fake_listdir(path):
        if path == str(stale_mount):
            raise OSError("stale")
        if path == proc_mount:
            return []
        return real_listdir(path)

    monkeypatch.setattr(main.os, "listdir", fake_listdir)

    assert main._list_mount_points() == sorted([str(lsblk_mount), proc_mount])


@pytest.mark.parametrize(
    ("contents", "expected"),
    [
        ("/dev/mmcblk0p1 /run/media/deck/SD ext4 rw 0 0\n", "/run/media/deck/SD"),
        ("/dev/sda1 /run/media/deck/USB exfat rw 0 0\n", None),
    ],
)
def test_find_sd_mount_from_proc(monkeypatch, contents: str, expected: str | None):
    main = load_main()
    real_open = builtins.open

    def fake_open(path, *args, **kwargs):
        if path == "/proc/mounts":
            return io.StringIO(contents)
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", fake_open)

    assert main._find_sd_mount() == expected


def test_list_zip_files_validates_and_sorts_by_mtime(tmp_path: Path):
    main = load_main()
    missing = tmp_path / "missing"
    empty = tmp_path / "empty"
    empty.mkdir()

    with pytest.raises(RuntimeError, match="does not exist"):
        main._list_zip_files(missing)
    with pytest.raises(RuntimeError, match="No .zip files"):
        main._list_zip_files(empty)

    older = empty / "Older.ZIP"
    newer = empty / "newer.zip"
    ignored = empty / "notes.txt"
    older.write_bytes(b"old")
    newer.write_bytes(b"new")
    ignored.write_text("not a zip")
    os.utime(older, (100, 100))
    os.utime(newer, (200, 200))

    assert main._list_zip_files(empty) == [str(newer), str(older)]


def test_copy_sync_copies_bytes_and_updates_progress(tmp_path: Path):
    main = load_main()
    source = tmp_path / "source" / "Game.zip"
    destination = tmp_path / "destination"
    source.parent.mkdir()
    source.write_bytes(b"zip bytes" * 200_000)

    copied = Path(main._copy_sync(str(source), str(destination)))

    assert copied.read_bytes() == source.read_bytes()
    assert main._progress["percent"] == 100
    assert main._progress["bytes_done"] == main._progress["bytes_total"] == source.stat().st_size


def test_copy_sync_and_do_copy_report_missing_source(monkeypatch, tmp_path: Path):
    main = load_main()
    missing = tmp_path / "missing.zip"

    async def synchronous_to_thread(function, *args):
        return function(*args)

    monkeypatch.setattr(main.asyncio, "to_thread", synchronous_to_thread)

    with pytest.raises(RuntimeError, match="ZIP not found"):
        main._copy_sync(str(missing), str(tmp_path / "dest"))

    main._progress = {"done": False, "error": None}
    asyncio.run(main._do_copy(str(missing), str(tmp_path / "dest")))
    assert main._progress["done"] is True
    assert "ZIP not found" in main._progress["error"]


def test_do_copy_success_sets_result(monkeypatch, tmp_path: Path):
    main = load_main()
    source = tmp_path / "Game.zip"
    source.write_bytes(b"contents")
    destination = tmp_path / "dest"
    main._progress = {"done": False, "error": None}

    async def synchronous_to_thread(function, *args):
        return function(*args)

    monkeypatch.setattr(main.asyncio, "to_thread", synchronous_to_thread)

    asyncio.run(main._do_copy(str(source), str(destination)))

    assert main._progress["done"] is True
    assert main._progress["percent"] == 100
    assert main._progress["result"] == {"dest_zip": str(destination / source.name)}


def test_do_extract_reports_timeout(monkeypatch, tmp_path: Path):
    main = load_main()

    async def timeout_wait_for(_awaitable, timeout):
        _awaitable.close()
        assert timeout == 0.01
        raise asyncio.TimeoutError

    monkeypatch.setattr(main, "_EXTRACT_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(main.asyncio, "wait_for", timeout_wait_for)
    main._progress = {"done": False, "error": None}
    asyncio.run(main._do_extract("game.zip", str(tmp_path)))
    assert main._progress["done"] is True
    assert main._progress["error"] == "Extraction timed out after 0.01 seconds"


def test_do_extract_reports_generic_error(monkeypatch, tmp_path: Path):
    main = load_main()

    def fail_extract(*_args):
        raise RuntimeError("broken archive")

    async def synchronous_to_thread(function, *args):
        return function(*args)

    monkeypatch.setattr(main.asyncio, "to_thread", synchronous_to_thread)
    monkeypatch.setattr(main, "_extract_sync", fail_extract)
    main._progress = {"done": False, "error": None}
    asyncio.run(main._do_extract("game.zip", str(tmp_path)))
    assert main._progress["done"] is True
    assert main._progress["error"] == "broken archive"


def test_save_folder_helpers_validate_and_sort(tmp_path: Path):
    main = load_main()
    missing = tmp_path / "missing"
    with pytest.raises(RuntimeError, match="does not exist"):
        main._list_save_folders(missing)

    save_root = tmp_path / "Saves"
    save_root.mkdir()
    (save_root / "zeta").mkdir()
    (save_root / "Alpha").mkdir()
    (save_root / "file.txt").write_text("ignore")
    assert main._list_save_folders(save_root) == [
        str(save_root / "Alpha"),
        str(save_root / "zeta"),
    ]

    existing = save_root / "Existing"
    existing.mkdir()
    assert main._create_save_folder(save_root, "Existing") == str(existing)
    blocker = save_root / "Blocked"
    blocker.write_text("file")
    with pytest.raises(RuntimeError, match="not a directory"):
        main._create_save_folder(save_root, "Blocked")


def test_save_symlink_and_availability_branches(tmp_path: Path):
    main = load_main()
    game_dir = tmp_path / "Game"
    save_folder = tmp_path / "Saves"
    save_folder.mkdir()

    assert main._create_save_symlink(game_dir, save_folder) == {
        "created": False,
        "skipped": True,
        "reason": "No game folder found.",
    }
    assert main._can_link_saves(game_dir)["available"] is False

    (game_dir / "game").mkdir(parents=True)
    with pytest.raises(RuntimeError, match="Save folder does not exist"):
        main._create_save_symlink(game_dir, tmp_path / "missing-save")
    assert main._can_link_saves(game_dir) == {"available": True, "reason": ""}

    (game_dir / "game" / "saves").mkdir()
    assert main._create_save_symlink(game_dir, save_folder)["reason"] == "game/saves already exists."
    assert main._can_link_saves(game_dir)["reason"] == "game/saves already exists."


def test_plugin_settings_and_log_level_methods(monkeypatch):
    main = load_main()
    plugin = main.Plugin()
    main.settings.data = {
        "log_level": "debug",
        "sd_card_path": "/fresh/sd",
    }
    monkeypatch.setattr(
        main.settings,
        "read",
        lambda: {"log_level": "error", "sd_card_path": "/stale/sd", "other": 3},
    )

    settings = asyncio.run(plugin.settings_read())
    assert settings == {"log_level": "debug", "sd_card_path": "/fresh/sd", "other": 3}
    assert asyncio.run(plugin.settings_set("save_root_path", "/saves")) is True
    assert main.settings.data["save_root_path"] == "/saves"
    assert asyncio.run(plugin.settings_commit()) is True
    assert asyncio.run(plugin.get_log_level()) == "debug"

    assert asyncio.run(plugin.set_log_level("INFO")) is True
    assert main.settings.data["log_level"] == "info"
    assert main.logger.level == logging.INFO
    assert asyncio.run(plugin.set_log_level("verbose")) is False
    assert main.settings.data["log_level"] == "info"


def test_plugin_settings_read_recovers_from_bad_read(monkeypatch):
    main = load_main()
    monkeypatch.setattr(main.settings, "read", lambda: (_ for _ in ()).throw(OSError("bad settings")))
    main.settings.data["default_dest_root"] = "/games"

    assert asyncio.run(main.Plugin().settings_read()) == {"default_dest_root": "/games"}


def test_plugin_discovery_and_progress_wrappers(monkeypatch, tmp_path: Path):
    main = load_main()
    plugin = main.Plugin()
    monkeypatch.setattr(main, "_list_mount_points", lambda: ["/usb"])
    monkeypatch.setattr(main, "_find_sd_mount", lambda: "/sd")
    monkeypatch.setattr(main, "_mount_usb_devices", lambda: ["/new-usb"])

    async def synchronous_to_thread(function, *args):
        return function(*args)

    monkeypatch.setattr(main.asyncio, "to_thread", synchronous_to_thread)
    zip_path = tmp_path / "Game.zip"
    zip_path.write_bytes(b"zip")
    main._progress = {"operation": "copy", "percent": 42}

    assert asyncio.run(plugin.list_usb_mounts()) == ["/usb"]
    assert asyncio.run(plugin.detect_sd_mount()) == "/sd"
    assert asyncio.run(plugin.mount_usb_devices()) == ["/new-usb"]
    assert asyncio.run(plugin.list_zip_files(str(tmp_path))) == [str(zip_path)]
    progress = asyncio.run(plugin.get_progress())
    progress["percent"] = 99
    assert main._progress["percent"] == 42


def test_plugin_start_copy_cancels_inflight_task(tmp_path: Path):
    main = load_main()

    async def scenario():
        started = []

        async def blocking_copy(zip_path, _dest_root):
            started.append(zip_path)
            await asyncio.sleep(3600)

        main._do_copy = blocking_copy
        plugin = main.Plugin()
        first_result = await plugin.start_copy("first.zip", str(tmp_path))
        first_task = main._active_task
        await asyncio.sleep(0)
        second_result = await plugin.start_copy("second.zip", str(tmp_path))
        second_task = main._active_task
        await asyncio.sleep(0)
        assert first_result == second_result == {"started": True}
        assert first_task.cancelled()
        assert main._progress["operation"] == "copy"
        assert started == ["first.zip", "second.zip"]
        second_task.cancel()
        await asyncio.sleep(0)

    asyncio.run(scenario())


def test_plugin_conflict_checks_top_folder_and_flat_zip(tmp_path: Path):
    main = load_main()
    plugin = main.Plugin()
    dest = tmp_path / "dest"
    dest.mkdir()
    nested_zip = tmp_path / "Nested.zip"
    flat_zip = tmp_path / "Flat Game.zip"
    make_zip(nested_zip, {"Nested/run.sh": b"run"})
    make_zip(flat_zip, {"run.sh": b"run", "game/script.rpy": b"script"})
    (dest / "Nested").mkdir()

    assert asyncio.run(plugin.check_extract_conflict(str(nested_zip), str(dest))) == {
        "conflict": True,
        "folder_name": "Nested",
        "suffix_folder_name": "Nested_2",
    }
    assert asyncio.run(plugin.check_extract_conflict(str(flat_zip), str(dest))) == {
        "conflict": False,
        "folder_name": "Flat Game",
        "suffix_folder_name": None,
    }


def test_plugin_start_extract_cancels_inflight_task(tmp_path: Path):
    main = load_main()

    async def scenario():
        calls = []

        async def blocking_extract(zip_path, dest_root, overwrite, replace, suffix):
            calls.append((zip_path, dest_root, overwrite, replace, suffix))
            await asyncio.sleep(3600)

        main._do_extract = blocking_extract
        plugin = main.Plugin()
        await plugin.start_extract("first.zip", str(tmp_path), True, False)
        first_task = main._active_task
        await asyncio.sleep(0)
        result = await plugin.start_extract("second.zip", str(tmp_path), False, False, True)
        second_task = main._active_task
        await asyncio.sleep(0)
        assert result == {"started": True}
        assert first_task.cancelled()
        assert main._progress["operation"] == "extract"
        assert calls == [
            ("first.zip", str(tmp_path), True, False, False),
            ("second.zip", str(tmp_path), False, False, True),
        ]
        second_task.cancel()
        await asyncio.sleep(0)

    asyncio.run(scenario())


def test_plugin_launcher_and_executable_methods(tmp_path: Path):
    main = load_main()
    plugin = main.Plugin()
    sh_game = tmp_path / "sh-game"
    exe_game = tmp_path / "exe-game"
    empty_game = tmp_path / "empty-game"
    for folder in (sh_game, exe_game, empty_game):
        folder.mkdir()
    sh_launcher = sh_game / "run.sh"
    sh_launcher.write_text("#!/bin/sh\n")
    (sh_game / "ignored.exe").write_text("exe")
    exe_launcher = exe_game / "run.exe"
    exe_launcher.write_text("exe")

    assert asyncio.run(plugin.get_launchers(str(sh_game)))["type"] == "sh"
    assert asyncio.run(plugin.get_launchers(str(exe_game))) == {
        "launchers": [str(exe_launcher)],
        "type": "exe",
    }
    assert asyncio.run(plugin.get_launchers(str(empty_game))) == {"launchers": [], "type": None}

    sh_launcher.chmod(0o600)
    assert asyncio.run(plugin.ensure_executable(str(sh_launcher))) == {"path": str(sh_launcher)}
    assert sh_launcher.stat().st_mode & 0o111
    missing = tmp_path / "missing.sh"
    assert asyncio.run(plugin.ensure_executable(str(missing))) == {"path": str(missing)}


def test_plugin_save_wrappers(tmp_path: Path):
    main = load_main()
    plugin = main.Plugin()
    save_root = tmp_path / "Saves"
    game_dir = tmp_path / "Game"
    save_root.mkdir()
    (save_root / "Existing").mkdir()
    (game_dir / "game").mkdir(parents=True)

    assert asyncio.run(plugin.list_save_folders(str(save_root))) == [str(save_root / "Existing")]
    created = asyncio.run(plugin.create_save_folder(str(save_root), "New"))
    assert created == str(save_root / "New")
    assert asyncio.run(plugin.can_link_saves(str(game_dir))) == {"available": True, "reason": ""}
    linked = asyncio.run(plugin.create_save_symlink(str(game_dir), created))
    assert linked["created"] is True
    assert (game_dir / "game" / "saves").resolve() == Path(created)


@pytest.mark.parametrize("settings_fails", [False, True])
def test_plugin_main_applies_log_level_and_stops_on_cancellation(monkeypatch, settings_fails: bool):
    main = load_main()
    if settings_fails:
        monkeypatch.setattr(
            main.settings,
            "getSetting",
            lambda *_args: (_ for _ in ()).throw(OSError("settings unavailable")),
        )
    else:
        main.settings.data["log_level"] = "debug"

    async def cancel_sleep(_seconds):
        raise asyncio.CancelledError

    monkeypatch.setattr(main.asyncio, "sleep", cancel_sleep)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(main.Plugin()._main())

    assert main.logger.level == (logging.ERROR if settings_fails else logging.DEBUG)


def test_plugin_unload_cancels_active_task_and_handles_none():
    main = load_main()

    async def scenario():
        async def wait_forever():
            await asyncio.sleep(3600)

        task = asyncio.create_task(wait_forever())
        main._active_task = task
        await main.Plugin()._unload()
        await asyncio.sleep(0)
        assert task.cancelled()

        main._active_task = None
        await main.Plugin()._unload()

        done_task = asyncio.create_task(asyncio.sleep(0))
        await done_task
        main._active_task = done_task
        await main.Plugin()._unload()
        assert done_task.done()

    asyncio.run(scenario())
