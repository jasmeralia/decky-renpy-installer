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
logger.setLevel(logging.ERROR)

SETTINGS_DIR = os.environ.get("DECKY_PLUGIN_SETTINGS_DIR", "/tmp")
settings = SettingsManager(name="settings", settings_directory=SETTINGS_DIR)
try:
    settings.read()
except Exception:
    pass

_LOG_LEVELS = {"debug": logging.DEBUG, "info": logging.INFO, "warn": logging.WARNING, "warning": logging.WARNING, "error": logging.ERROR}


def _apply_log_level(level_str: str) -> None:
    level = _LOG_LEVELS.get(level_str.lower(), logging.ERROR)
    logger.setLevel(level)
    logger.debug("Log level set to %s (%d)", level_str.upper(), level)


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
        logger.debug("USB mount scan found %d mount(s): %s", len(mounts), mounts)
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
                        logger.info("Detected SD card mount: %s (device %s)", mnt, device)
                        return mnt
        logger.debug("No SD card mount detected")
    except Exception as e:
        logger.exception("Failed to detect SD mount: %s", e)
    return None


def _list_zip_files(mount_path: Path) -> List[str]:
    logger.debug("Scanning for ZIP files in: %s", mount_path)
    if not mount_path.exists() or not mount_path.is_dir():
        logger.error("USB mount path does not exist or is not a directory: %s", mount_path)
        raise RuntimeError(
            f"USB mount path does not exist or is not a directory: {mount_path}"
        )
    zip_files = [p for p in mount_path.rglob("*.zip") if p.is_file()]
    if not zip_files:
        logger.warning("No .zip files found on USB drive: %s", mount_path)
        raise RuntimeError(f"No .zip files found on USB drive: {mount_path}")
    zip_files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    logger.info("Found %d ZIP file(s) on USB: %s", len(zip_files), [str(p) for p in zip_files])
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
    logger.debug("ZIP '%s' has %d top-level component(s): %s", zip_path.name, len(top_components), top_components)
    if len(top_components) == 1:
        only = next(iter(top_components))
        # Ensure there are entries *inside* the folder, not just the folder entry itself
        under = [
            n for n in names
            if n.replace("\\", "/").startswith(only + "/")
            and len(n.replace("\\", "/")) > len(only) + 1
        ]
        if under:
            logger.debug("ZIP is Case A (single top-level folder: '%s', %d entries inside)", only, len(under))
            return only
    logger.debug("ZIP is Case B (flat structure, %d top-level component(s))", len(top_components))
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
        data = settings.read()
        logger.debug("settings_read: %s", data)
        return data

    async def settings_commit(self) -> bool:
        settings.commit()
        logger.debug("settings committed")
        return True

    async def settings_set(self, key: str, value: Any) -> bool:
        settings.setSetting(key, value)
        logger.debug("settings_set: %s = %r", key, value)
        return True

    # --- Log level ---

    async def get_log_level(self) -> str:
        level_str: str = settings.getSetting("log_level", "error")
        logger.debug("get_log_level: %s", level_str)
        return level_str

    async def set_log_level(self, level: str) -> bool:
        normalized = level.lower()
        if normalized not in _LOG_LEVELS:
            logger.warning("Invalid log level '%s', ignoring", level)
            return False
        settings.setSetting("log_level", normalized)
        settings.commit()
        _apply_log_level(normalized)
        logger.info("Log level changed to %s", normalized.upper())
        return True

    # --- Discovery ---

    async def list_usb_mounts(self) -> List[str]:
        mounts = _list_mount_points()
        logger.debug("list_usb_mounts returning: %s", mounts)
        return mounts

    async def detect_sd_mount(self) -> Optional[str]:
        mount = _find_sd_mount()
        logger.debug("detect_sd_mount returning: %s", mount)
        return mount

    async def list_zip_files(self, mount_path: str) -> List[str]:
        logger.info("Listing ZIP files in: %s", mount_path)
        return _list_zip_files(Path(mount_path).expanduser())

    # --- Progress ---

    async def get_progress(self) -> Dict[str, Any]:
        self._init_state()
        p = dict(self._progress)
        logger.debug("get_progress: op=%s pct=%d done=%s error=%s", p.get("operation"), p.get("percent"), p.get("done"), p.get("error"))
        return p

    # --- Copy (USB → SD card) ---

    async def start_copy(self, zip_path: str, dest_root: str) -> Dict[str, Any]:
        self._init_state()
        logger.info("start_copy: zip_path=%s dest_root=%s", zip_path, dest_root)
        self._progress = {
            "operation": "copy",
            "percent": 0,
            "done": False,
            "error": None,
            "result": None,
        }
        if self._active_task and not self._active_task.done():
            logger.warning("Cancelling in-flight task before starting new copy")
            self._active_task.cancel()
        self._active_task = asyncio.create_task(self._do_copy(zip_path, dest_root))
        return {"started": True}

    def _copy_sync(self, zip_path: str, dest_root: str) -> str:
        src = Path(zip_path).expanduser()
        if not src.exists() or not src.is_file():
            logger.error("ZIP not found for copy: %s", src)
            raise RuntimeError(f"ZIP not found: {src}")
        dest_root_p = Path(dest_root).expanduser()
        _ensure_dir(dest_root_p)
        dst = dest_root_p / src.name
        total = src.stat().st_size
        logger.info("Copying '%s' → '%s' (%.1f MB)", src.name, dst, total / (1024 * 1024))
        copied = 0
        CHUNK = 1024 * 1024  # 1 MB
        with src.open("rb") as fsrc, dst.open("wb") as fdst:
            while True:
                chunk = fsrc.read(CHUNK)
                if not chunk:
                    break
                fdst.write(chunk)
                copied += len(chunk)
                pct = int(copied / total * 100) if total > 0 else 0
                self._progress["percent"] = pct
                logger.debug("Copy progress: %d%% (%d / %d bytes)", pct, copied, total)
        shutil.copystat(src, dst)
        logger.info("Copy complete: '%s'", dst)
        return str(dst)

    async def _do_copy(self, zip_path: str, dest_root: str) -> None:
        try:
            dest_zip = await asyncio.to_thread(self._copy_sync, zip_path, dest_root)
            self._progress.update(
                {"percent": 100, "done": True, "result": {"dest_zip": dest_zip}}
            )
            logger.info("Copy task finished: dest_zip=%s", dest_zip)
        except Exception as e:
            logger.exception("Copy failed: %s", e)
            self._progress.update({"done": True, "error": str(e)})

    # --- Extract (SD card ZIP → game folder) ---

    async def start_extract(self, zip_path: str, dest_root: str) -> Dict[str, Any]:
        self._init_state()
        logger.info("start_extract: zip_path=%s dest_root=%s", zip_path, dest_root)
        self._progress = {
            "operation": "extract",
            "percent": 0,
            "done": False,
            "error": None,
            "result": None,
        }
        if self._active_task and not self._active_task.done():
            logger.warning("Cancelling in-flight task before starting new extract")
            self._active_task.cancel()
        self._active_task = asyncio.create_task(self._do_extract(zip_path, dest_root))
        return {"started": True}

    def _extract_sync(self, zip_path: str, dest_root: str) -> str:
        zip_p = Path(zip_path).expanduser()
        dest_p = Path(dest_root).expanduser()
        logger.info("Inspecting ZIP structure: %s", zip_p.name)
        top_folder = _get_zip_top_folder(zip_p)

        with zipfile.ZipFile(zip_p, "r") as zf:
            members = zf.infolist()
            total = max(len(members), 1)
            logger.debug("ZIP has %d members", len(members))

            if top_folder:
                # Case A: all entries under a single top-level subfolder.
                # Extract at dest_root; the subfolder is created by extraction.
                game_dir = dest_p / top_folder
                logger.info("Case A: extracting with top folder '%s' → %s", top_folder, game_dir)
                if game_dir.exists():
                    logger.error("Destination folder already exists: %s", game_dir)
                    raise RuntimeError(
                        f"Folder '{top_folder}' already exists at destination: {game_dir}"
                    )
                for i, member in enumerate(members):
                    zf.extract(member, dest_p)
                    pct = int((i + 1) / total * 100)
                    self._progress["percent"] = pct
                    logger.debug("Extract progress: %d%% (member %d/%d: %s)", pct, i + 1, total, member.filename)
            else:
                # Case B: flat ZIP. Create a folder named after the ZIP file.
                folder_name = _safe_folder_name(zip_p.name)
                game_dir = dest_p / folder_name
                logger.info("Case B: flat ZIP, creating folder '%s' → %s", folder_name, game_dir)
                if game_dir.exists():
                    logger.error("Destination folder already exists: %s", game_dir)
                    raise RuntimeError(
                        f"Folder '{folder_name}' already exists at destination: {game_dir}"
                    )
                game_dir.mkdir(parents=True)
                for i, member in enumerate(members):
                    zf.extract(member, game_dir)
                    pct = int((i + 1) / total * 100)
                    self._progress["percent"] = pct
                    logger.debug("Extract progress: %d%% (member %d/%d: %s)", pct, i + 1, total, member.filename)

        logger.info("Extraction complete, game_dir=%s", game_dir)

        # Delete the ZIP from the SD card after successful extraction
        try:
            zip_p.unlink(missing_ok=True)
            logger.info("Deleted ZIP from SD card: %s", zip_p)
        except TypeError:
            if zip_p.exists():
                zip_p.unlink()
                logger.info("Deleted ZIP from SD card (legacy unlink): %s", zip_p)
        except Exception as e:
            logger.warning("Failed to delete ZIP '%s': %s", zip_p, e)

        return str(game_dir)

    async def _do_extract(self, zip_path: str, dest_root: str) -> None:
        try:
            game_dir = await asyncio.to_thread(self._extract_sync, zip_path, dest_root)
            self._progress.update(
                {"percent": 100, "done": True, "result": {"game_dir": game_dir}}
            )
            logger.info("Extract task finished: game_dir=%s", game_dir)
        except Exception as e:
            logger.exception("Extract failed: %s", e)
            self._progress.update({"done": True, "error": str(e)})

    # --- Launcher discovery ---

    async def get_launchers(self, game_dir: str) -> Dict[str, Any]:
        game_p = Path(game_dir).expanduser()
        logger.info("Searching for launchers in: %s", game_p)
        sh_files = sorted([p for p in game_p.rglob("*.sh") if p.is_file()])
        if sh_files:
            logger.info("Found %d .sh launcher(s): %s", len(sh_files), [str(p) for p in sh_files])
            return {"launchers": [str(p) for p in sh_files], "type": "sh"}
        exe_files = sorted([p for p in game_p.rglob("*.exe") if p.is_file()])
        if exe_files:
            logger.info("Found %d .exe launcher(s) (no .sh found): %s", len(exe_files), [str(p) for p in exe_files])
            return {"launchers": [str(p) for p in exe_files], "type": "exe"}
        logger.error("No .sh or .exe launcher found in game_dir: %s", game_p)
        return {"launchers": [], "type": None}

    async def ensure_executable(self, launcher_path: str) -> Dict[str, str]:
        p = Path(launcher_path).expanduser()
        logger.debug("ensure_executable: %s", p)
        try:
            old_mode = p.stat().st_mode
            p.chmod(old_mode | 0o111)
            logger.info("Set executable bit on '%s' (was %o, now %o)", p, old_mode, old_mode | 0o111)
        except Exception as e:
            logger.warning("Failed to chmod '%s': %s", p, e)
        return {"path": str(p)}

    # --- Lifecycle ---

    async def _main(self) -> None:
        self._init_state()
        # Apply saved log level on startup
        try:
            level_str = settings.getSetting("log_level", "error")
            _apply_log_level(level_str)
            logger.info("Ren'Py Installer backend started (log_level=%s)", level_str.upper())
        except Exception as e:
            logger.error("Failed to apply log level from settings: %s", e)
            logger.info("Ren'Py Installer backend started.")
        while True:
            await asyncio.sleep(3600)

    async def _unload(self) -> None:
        logger.info("Ren'Py Installer backend unloading...")
        if (
            hasattr(self, "_active_task")
            and self._active_task
            and not self._active_task.done()
        ):
            logger.warning("Cancelling in-flight task on unload")
            self._active_task.cancel()
        logger.info("Ren'Py Installer backend unloaded.")
