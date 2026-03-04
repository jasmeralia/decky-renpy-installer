import asyncio
import logging
import os
import re
import shutil
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from settings import SettingsManager  # provided by decky-loader runtime

logger = logging.getLogger("renpy-installer")
logger.setLevel(logging.INFO)

SETTINGS_DIR = os.environ.get("DECKY_PLUGIN_SETTINGS_DIR", "/tmp")
settings = SettingsManager(name="settings", settings_directory=SETTINGS_DIR)
try:
    settings.read()
except Exception:
    pass


def _safe_folder_name(name: str) -> str:
    name = re.sub(r"\.zip$", "", name, flags=re.IGNORECASE)
    name = re.sub(r"[^a-zA-Z0-9 _-]+", "", name).strip()
    return name or "RenPyGame"


def _ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def _list_mount_points() -> List[str]:
    mounts: List[str] = []
    try:
        with open("/proc/mounts", "r", encoding="utf-8") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2:
                    mnt = parts[1]
                    if mnt.startswith("/run/media/deck/"):
                        mounts.append(mnt)
    except Exception as e:
        logger.exception("Failed to read /proc/mounts: %s", e)
    return sorted(set(mounts))


def _find_sd_mount() -> Optional[str]:
    try:
        with open("/proc/mounts", "r", encoding="utf-8") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2:
                    device = parts[0]
                    mnt = parts[1]
                    if device.startswith("/dev/mmcblk") and mnt.startswith("/run/media/"):
                        return mnt
    except Exception as e:
        logger.exception("Failed to detect SD mount: %s", e)
    return None


def _list_zip_files(mount_path: Path) -> List[str]:
    if not mount_path.exists() or not mount_path.is_dir():
        raise RuntimeError(
            f"USB mount path does not exist or is not a directory: {mount_path}"
        )
    zip_files = [p for p in mount_path.rglob("*.zip") if p.is_file()]
    if not zip_files:
        raise RuntimeError(f"No .zip files found on USB drive: {mount_path}")
    zip_files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return [str(p) for p in zip_files]


def _get_zip_top_folder(zip_path: Path) -> Optional[str]:
    """Return the single top-level subfolder name if all ZIP entries live under it, else None."""
    with zipfile.ZipFile(zip_path, "r") as zf:
        names = zf.namelist()
    top_components: Set[str] = set()
    for name in names:
        normalized = name.replace("\\", "/").strip("/")
        if normalized:
            top_components.add(normalized.split("/")[0])
    if len(top_components) == 1:
        only = next(iter(top_components))
        # Ensure there are entries *inside* the folder, not just the folder entry itself
        under = [
            n for n in names
            if n.replace("\\", "/").startswith(only + "/")
            and len(n.replace("\\", "/")) > len(only) + 1
        ]
        if under:
            return only
    return None


class Plugin:
    def _init_state(self) -> None:
        if not hasattr(self, "_progress"):
            self._progress: Dict[str, Any] = {
                "operation": "",
                "percent": 0,
                "done": True,
                "error": None,
                "result": None,
            }
        if not hasattr(self, "_active_task"):
            self._active_task: Optional[asyncio.Task] = None  # type: ignore[assignment]

    # --- Settings ---

    async def settings_read(self) -> Dict[str, Any]:
        return settings.read()

    async def settings_commit(self) -> bool:
        settings.commit()
        return True

    async def settings_set(self, key: str, value: Any) -> bool:
        settings.setSetting(key, value)
        return True

    # --- Discovery ---

    async def list_usb_mounts(self) -> List[str]:
        return _list_mount_points()

    async def detect_sd_mount(self) -> Optional[str]:
        return _find_sd_mount()

    async def list_zip_files(self, mount_path: str) -> List[str]:
        return _list_zip_files(Path(mount_path).expanduser())

    # --- Progress ---

    async def get_progress(self) -> Dict[str, Any]:
        self._init_state()
        return dict(self._progress)

    # --- Copy (USB → SD card) ---

    async def start_copy(self, zip_path: str, dest_root: str) -> Dict[str, Any]:
        self._init_state()
        self._progress = {
            "operation": "copy",
            "percent": 0,
            "done": False,
            "error": None,
            "result": None,
        }
        if self._active_task and not self._active_task.done():
            self._active_task.cancel()
        self._active_task = asyncio.create_task(self._do_copy(zip_path, dest_root))
        return {"started": True}

    def _copy_sync(self, zip_path: str, dest_root: str) -> str:
        src = Path(zip_path).expanduser()
        if not src.exists() or not src.is_file():
            raise RuntimeError(f"ZIP not found: {src}")
        dest_root_p = Path(dest_root).expanduser()
        _ensure_dir(dest_root_p)
        dst = dest_root_p / src.name
        total = src.stat().st_size
        copied = 0
        CHUNK = 1024 * 1024  # 1 MB
        with src.open("rb") as fsrc, dst.open("wb") as fdst:
            while True:
                chunk = fsrc.read(CHUNK)
                if not chunk:
                    break
                fdst.write(chunk)
                copied += len(chunk)
                self._progress["percent"] = int(copied / total * 100) if total > 0 else 0
        shutil.copystat(src, dst)
        return str(dst)

    async def _do_copy(self, zip_path: str, dest_root: str) -> None:
        try:
            dest_zip = await asyncio.to_thread(self._copy_sync, zip_path, dest_root)
            self._progress.update(
                {"percent": 100, "done": True, "result": {"dest_zip": dest_zip}}
            )
        except Exception as e:
            logger.exception("Copy failed: %s", e)
            self._progress.update({"done": True, "error": str(e)})

    # --- Extract (SD card ZIP → game folder) ---

    async def start_extract(self, zip_path: str, dest_root: str) -> Dict[str, Any]:
        self._init_state()
        self._progress = {
            "operation": "extract",
            "percent": 0,
            "done": False,
            "error": None,
            "result": None,
        }
        if self._active_task and not self._active_task.done():
            self._active_task.cancel()
        self._active_task = asyncio.create_task(self._do_extract(zip_path, dest_root))
        return {"started": True}

    def _extract_sync(self, zip_path: str, dest_root: str) -> str:
        zip_p = Path(zip_path).expanduser()
        dest_p = Path(dest_root).expanduser()
        top_folder = _get_zip_top_folder(zip_p)

        with zipfile.ZipFile(zip_p, "r") as zf:
            members = zf.infolist()
            total = max(len(members), 1)

            if top_folder:
                # Case A: all entries under a single top-level subfolder.
                # Extract at dest_root; the subfolder is created by extraction.
                game_dir = dest_p / top_folder
                if game_dir.exists():
                    raise RuntimeError(
                        f"Folder '{top_folder}' already exists at destination: {game_dir}"
                    )
                for i, member in enumerate(members):
                    zf.extract(member, dest_p)
                    self._progress["percent"] = int((i + 1) / total * 100)
            else:
                # Case B: flat ZIP. Create a folder named after the ZIP file.
                folder_name = _safe_folder_name(zip_p.name)
                game_dir = dest_p / folder_name
                if game_dir.exists():
                    raise RuntimeError(
                        f"Folder '{folder_name}' already exists at destination: {game_dir}"
                    )
                game_dir.mkdir(parents=True)
                for i, member in enumerate(members):
                    zf.extract(member, game_dir)
                    self._progress["percent"] = int((i + 1) / total * 100)

        # Delete the ZIP from the SD card after successful extraction
        try:
            zip_p.unlink(missing_ok=True)
        except TypeError:
            if zip_p.exists():
                zip_p.unlink()

        return str(game_dir)

    async def _do_extract(self, zip_path: str, dest_root: str) -> None:
        try:
            game_dir = await asyncio.to_thread(self._extract_sync, zip_path, dest_root)
            self._progress.update(
                {"percent": 100, "done": True, "result": {"game_dir": game_dir}}
            )
        except Exception as e:
            logger.exception("Extract failed: %s", e)
            self._progress.update({"done": True, "error": str(e)})

    # --- Launcher discovery ---

    async def get_launchers(self, game_dir: str) -> Dict[str, Any]:
        game_p = Path(game_dir).expanduser()
        sh_files = sorted([p for p in game_p.rglob("*.sh") if p.is_file()])
        if sh_files:
            return {"launchers": [str(p) for p in sh_files], "type": "sh"}
        exe_files = sorted([p for p in game_p.rglob("*.exe") if p.is_file()])
        if exe_files:
            return {"launchers": [str(p) for p in exe_files], "type": "exe"}
        return {"launchers": [], "type": None}

    async def ensure_executable(self, launcher_path: str) -> Dict[str, str]:
        p = Path(launcher_path).expanduser()
        try:
            p.chmod(p.stat().st_mode | 0o111)
        except Exception:
            pass
        return {"path": str(p)}

    # --- Lifecycle ---

    async def _main(self) -> None:
        self._init_state()
        logger.info("Ren'Py Installer backend started.")
        while True:
            await asyncio.sleep(3600)

    async def _unload(self) -> None:
        if (
            hasattr(self, "_active_task")
            and self._active_task
            and not self._active_task.done()
        ):
            self._active_task.cancel()
        logger.info("Ren'Py Installer backend unloaded.")
