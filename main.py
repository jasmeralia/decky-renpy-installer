import asyncio
import glob
import json
import logging
import os
import re
import shutil
import subprocess
import zipfile
from pathlib import Path
import time
from dataclasses import dataclass
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

# Module-level state — avoids self.method() binding issues with Decky Loader's
# plugin proxy, which can call _main with the class rather than an instance.
_progress: Dict[str, Any] = {
    "operation": "",
    "percent": 0,
    "bytes_done": 0,
    "bytes_total": 0,
    "current_file": "",
    "updated_at": time.time(),
    "done": True,
    "error": None,
    "result": None,
}
_active_task: Optional[asyncio.Task] = None  # type: ignore[type-arg]
_EXTRACT_TIMEOUT_SECONDS = 7200


@dataclass(frozen=True)
class UsbPartition:
    path: str
    label: str
    mountpoints: List[str]


def _set_progress(**updates: Any) -> None:
    _progress.update(updates)
    _progress["updated_at"] = time.time()


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


def _get_mounted_devices() -> Set[str]:
    """Return the set of device paths currently mounted (e.g. {'/dev/sda1'})."""
    devices: Set[str] = set()
    try:
        with open("/proc/mounts", "r", encoding="utf-8") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 1:
                    devices.add(parts[0])
    except Exception as e:
        logger.exception("Failed to read /proc/mounts for device list: %s", e)
    return devices



def _get_partition_label(dev: str) -> str:
    """Return the filesystem label for a block device, or its base name as fallback."""
    try:
        result = subprocess.run(
            ["lsblk", "-no", "LABEL", dev],
            capture_output=True, text=True, timeout=5,
        )
        label = result.stdout.strip()
        if label:
            return label
    except Exception:
        pass
    # Fallback: use device base name (e.g. "sda1")
    return os.path.basename(dev)


def _flatten_lsblk_devices(devices: List[Dict[str, Any]], parent_usb: bool = False) -> List[Dict[str, Any]]:
    flattened: List[Dict[str, Any]] = []
    for dev in devices:
        is_usb = parent_usb or dev.get("tran") == "usb" or dev.get("rm") is True or dev.get("rm") == 1
        item = dict(dev)
        item["_parent_usb"] = is_usb
        flattened.append(item)
        children = dev.get("children")
        if isinstance(children, list):
            flattened.extend(_flatten_lsblk_devices(children, is_usb))
    return flattened


def _discover_usb_partitions() -> List[UsbPartition]:
    """Return removable USB filesystem partitions from lsblk metadata."""
    try:
        result = subprocess.run(
            ["lsblk", "-J", "-o", "NAME,PATH,TYPE,TRAN,RM,FSTYPE,LABEL,MOUNTPOINTS"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception as e:
        logger.warning("[mount-diag] lsblk discovery failed: %s", e)
        return []
    if result.returncode != 0:
        logger.warning("[mount-diag] lsblk discovery failed rc=%d stderr=%r", result.returncode, result.stderr.strip())
        return []
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as e:
        logger.warning("[mount-diag] Could not parse lsblk JSON: %s", e)
        return []

    blockdevices = data.get("blockdevices", [])
    if not isinstance(blockdevices, list):
        return []

    partitions: List[UsbPartition] = []
    for dev in _flatten_lsblk_devices(blockdevices):
        if dev.get("type") not in ("part", "crypt"):
            continue
        if not dev.get("_parent_usb"):
            continue
        if not dev.get("fstype"):
            continue
        path = dev.get("path")
        if not isinstance(path, str) or not path.startswith("/dev/"):
            continue
        raw_mounts = dev.get("mountpoints")
        mountpoints = [m for m in raw_mounts if isinstance(m, str) and m] if isinstance(raw_mounts, list) else []
        label = dev.get("label") if isinstance(dev.get("label"), str) and dev.get("label") else os.path.basename(path)
        partitions.append(UsbPartition(path=path, label=label, mountpoints=mountpoints))
    logger.warning("[mount-diag] lsblk USB partitions=%s", partitions)
    return partitions


def _mount_usb_devices() -> List[str]:
    """Mount any unmounted USB partitions via sudo mount.

    Scans /dev/sd* for partition block devices (e.g. /dev/sda1) that are not
    yet present in /proc/mounts, then mounts each one under /run/media/deck/.

    Uses ``sudo -n mount`` directly rather than udisksctl because Decky's
    plugin_loader runs outside the desktop session, which prevents udisks2's
    polkit authorization from succeeding.  The ``deck`` user on SteamOS has
    passwordless sudo.

    Returns a list of mount paths for devices that were successfully mounted.
    """
    # Use WARNING level for mount diagnostics so they always appear in logs
    # regardless of the user's log level setting.
    logger.warning("[mount-diag] uid=%d euid=%d user=%s",
                   os.getuid(), os.geteuid(), os.environ.get("USER", "(unset)"))

    mounted = _get_mounted_devices()
    discovered = _discover_usb_partitions()
    partition_paths = [p.path for p in discovered]
    if discovered:
        partitions = partition_paths
    else:
        partitions = sorted(glob.glob("/dev/sd[a-z]*[0-9]"))
    logger.warning("[mount-diag] partitions=%s, already mounted removable=%s",
                   partitions, [d for d in mounted if d in partitions])

    if not partitions:
        logger.warning("[mount-diag] No /dev/sd* partitions found — no USB drives to mount")
        return []

    newly_mounted: List[str] = []
    for dev in partitions:
        if dev in mounted:
            logger.warning("[mount-diag] Skipping %s — already mounted", dev)
            continue

        discovered_part = next((p for p in discovered if p.path == dev), None)
        label = discovered_part.label if discovered_part else _get_partition_label(dev)
        mount_point = f"/run/media/deck/{label}"
        logger.warning("[mount-diag] Mounting %s → %s (label=%r)", dev, mount_point, label)

        try:
            # Create the mount point directory
            subprocess.run(
                ["sudo", "-n", "mkdir", "-p", mount_point],
                capture_output=True, text=True, timeout=5,
            )
            result = subprocess.run(
                ["sudo", "-n", "mount", dev, mount_point],
                capture_output=True, text=True, timeout=15,
            )
            logger.warning("[mount-diag] %s → rc=%d stdout=%r stderr=%r",
                           dev, result.returncode, result.stdout.strip(), result.stderr.strip())
            if result.returncode == 0:
                newly_mounted.append(mount_point)
            else:
                logger.warning("[mount-diag] mount failed for %s (rc=%d): %s",
                               dev, result.returncode, result.stderr.strip())
        except subprocess.TimeoutExpired:
            logger.warning("[mount-diag] mount timed out for %s", dev)
        except Exception as e:
            logger.warning("[mount-diag] unexpected error mounting %s: %s", dev, e)
    return newly_mounted


def _list_mount_points() -> List[str]:
    """Return mount points for USB storage devices only.

    On Steam Deck, both USB drives and the SD card mount under /run/media/deck/.
    We distinguish them by device: USB storage uses /dev/sd* while the SD card
    uses /dev/mmcblk*.  Only /dev/sd* entries are returned here.
    """
    discovered = _discover_usb_partitions()
    mounts: List[str] = []
    for partition in discovered:
        mounts.extend(partition.mountpoints)
    if mounts:
        logger.debug("USB mount scan found %d lsblk mount(s): %s", len(mounts), mounts)
    else:
        logger.debug("No lsblk USB mounts found, falling back to /proc/mounts scan")
    try:
        with open("/proc/mounts", "r", encoding="utf-8") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2:
                    device, mnt = parts[0], parts[1]
                    if device.startswith("/dev/sd") and mnt.startswith("/run/media/"):
                        mounts.append(mnt)
        logger.debug("USB mount scan found %d mount(s): %s", len(mounts), mounts)
    except Exception as e:
        logger.exception("Failed to read /proc/mounts: %s", e)
    live: List[str] = []
    for mnt in sorted(set(mounts)):
        try:
            os.listdir(mnt)
            live.append(mnt)
        except OSError as e:
            logger.warning("Skipping stale mount point %s (%s)", mnt, e)
    return live


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
    zip_files: List[Path] = []
    for root, _dirs, files in os.walk(str(mount_path)):
        for name in files:
            if name.lower().endswith(".zip"):
                zip_files.append(Path(root) / name)
    if not zip_files:
        logger.warning("No .zip files found on USB drive: %s", mount_path)
        raise RuntimeError(f"No .zip files found on USB drive: {mount_path}")

    def _mtime(p: Path) -> float:
        try:
            return p.stat().st_mtime
        except OSError:
            return 0.0

    zip_files.sort(key=_mtime, reverse=True)
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


def _copy_sync(zip_path: str, dest_root: str) -> str:
    global _progress
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
    _set_progress(bytes_total=total, bytes_done=0, current_file=src.name)
    with src.open("rb") as fsrc, dst.open("wb") as fdst:
        while True:
            chunk = fsrc.read(CHUNK)
            if not chunk:
                break
            fdst.write(chunk)
            copied += len(chunk)
            pct = int(copied / total * 100) if total > 0 else 0
            _set_progress(percent=pct, bytes_done=copied)
            logger.debug("Copy progress: %d%% (%d / %d bytes)", pct, copied, total)
    shutil.copystat(src, dst)
    logger.info("Copy complete: '%s'", dst)
    return str(dst)


async def _do_copy(zip_path: str, dest_root: str) -> None:
    global _progress
    try:
        dest_zip = await asyncio.to_thread(_copy_sync, zip_path, dest_root)
        _progress.update({"percent": 100, "done": True, "result": {"dest_zip": dest_zip}})
        logger.info("Copy task finished: dest_zip=%s", dest_zip)
    except Exception as e:
        logger.exception("Copy failed: %s", e)
        _progress.update({"done": True, "error": str(e)})


def _safe_extract_target(base_dir: Path, member_name: str) -> Path:
    normalized = member_name.replace("\\", "/")
    target = (base_dir / normalized).resolve()
    base = base_dir.resolve()
    if target != base and base not in target.parents:
        raise RuntimeError(f"ZIP member escapes destination: {member_name}")
    return target


def _extract_member(zf: zipfile.ZipFile, member: zipfile.ZipInfo, base_dir: Path) -> int:
    target = _safe_extract_target(base_dir, member.filename)
    if member.is_dir():
        target.mkdir(parents=True, exist_ok=True)
        return 0
    target.parent.mkdir(parents=True, exist_ok=True)
    copied = 0
    with zf.open(member, "r") as src, target.open("wb") as dst:
        while True:
            chunk = src.read(1024 * 1024)
            if not chunk:
                break
            dst.write(chunk)
            copied += len(chunk)
            yield copied
    mode = (member.external_attr >> 16) & 0o777
    if mode:
        try:
            target.chmod(mode)
        except OSError:
            logger.debug("Could not apply ZIP mode %o to %s", mode, target)


def _extract_sync(zip_path: str, dest_root: str) -> str:
    global _progress
    zip_p = Path(zip_path).expanduser()
    dest_p = Path(dest_root).expanduser()
    logger.info("Inspecting ZIP structure: %s", zip_p.name)
    top_folder = _get_zip_top_folder(zip_p)

    with zipfile.ZipFile(zip_p, "r") as zf:
        members = zf.infolist()
        total_bytes = max(sum(m.file_size for m in members), 1)
        logger.debug("ZIP has %d members, %d uncompressed bytes", len(members), total_bytes)
        _set_progress(bytes_total=total_bytes, bytes_done=0, current_file="")
        extracted_bytes = 0

        if top_folder:
            # Case A: all entries under a single top-level subfolder.
            game_dir = dest_p / top_folder
            logger.info("Case A: extracting with top folder '%s' → %s", top_folder, game_dir)
            if game_dir.exists():
                logger.error("Destination folder already exists: %s", game_dir)
                raise RuntimeError(
                    f"Folder '{top_folder}' already exists at destination: {game_dir}"
                )
            for member in members:
                _set_progress(current_file=member.filename)
                member_done = 0
                for member_done in _extract_member(zf, member, dest_p):
                    pct = int((extracted_bytes + member_done) / total_bytes * 100)
                    _set_progress(percent=pct, bytes_done=extracted_bytes + member_done)
                extracted_bytes += member.file_size
                pct = int(extracted_bytes / total_bytes * 100)
                _set_progress(percent=pct, bytes_done=extracted_bytes)
                logger.debug("Extract progress: %d%% (%d / %d bytes, %s)", pct, extracted_bytes, total_bytes, member.filename)
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
            for member in members:
                _set_progress(current_file=member.filename)
                member_done = 0
                for member_done in _extract_member(zf, member, game_dir):
                    pct = int((extracted_bytes + member_done) / total_bytes * 100)
                    _set_progress(percent=pct, bytes_done=extracted_bytes + member_done)
                extracted_bytes += member.file_size
                pct = int(extracted_bytes / total_bytes * 100)
                _set_progress(percent=pct, bytes_done=extracted_bytes)
                logger.debug("Extract progress: %d%% (%d / %d bytes, %s)", pct, extracted_bytes, total_bytes, member.filename)

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


async def _do_extract(zip_path: str, dest_root: str) -> None:
    global _progress
    try:
        game_dir = await asyncio.wait_for(
            asyncio.to_thread(_extract_sync, zip_path, dest_root),
            timeout=_EXTRACT_TIMEOUT_SECONDS,
        )
        _progress.update({"percent": 100, "done": True, "result": {"game_dir": game_dir}, "updated_at": time.time()})
        logger.info("Extract task finished: game_dir=%s", game_dir)
    except asyncio.TimeoutError:
        message = f"Extraction timed out after {_EXTRACT_TIMEOUT_SECONDS} seconds"
        logger.exception(message)
        _progress.update({"done": True, "error": message, "updated_at": time.time()})
    except Exception as e:
        logger.exception("Extract failed: %s", e)
        _progress.update({"done": True, "error": str(e), "updated_at": time.time()})


def _list_save_folders(save_root: Path) -> List[str]:
    if not save_root.exists() or not save_root.is_dir():
        raise RuntimeError(f"Save root does not exist or is not a directory: {save_root}")
    folders = [str(p) for p in sorted(save_root.iterdir(), key=lambda p: p.name.lower()) if p.is_dir()]
    return folders


def _create_save_symlink(game_dir: Path, save_folder: Path) -> Dict[str, Any]:
    game_subdir = game_dir / "game"
    if not game_subdir.exists() or not game_subdir.is_dir():
        return {"created": False, "skipped": True, "reason": "No game folder found."}
    if not save_folder.exists() or not save_folder.is_dir():
        raise RuntimeError(f"Save folder does not exist or is not a directory: {save_folder}")
    saves_path = game_subdir / "saves"
    if saves_path.exists() or saves_path.is_symlink():
        return {"created": False, "skipped": True, "reason": "game/saves already exists."}
    saves_path.symlink_to(save_folder, target_is_directory=True)
    return {"created": True, "skipped": False, "path": str(saves_path), "target": str(save_folder)}


def _can_link_saves(game_dir: Path) -> Dict[str, Any]:
    game_subdir = game_dir / "game"
    saves_path = game_subdir / "saves"
    if not game_subdir.exists() or not game_subdir.is_dir():
        return {"available": False, "reason": "No game folder found."}
    if saves_path.exists() or saves_path.is_symlink():
        return {"available": False, "reason": "game/saves already exists."}
    return {"available": True, "reason": ""}


class Plugin:
    # --- Settings ---

    async def settings_read(self) -> Dict[str, Any]:
        try:
            data = settings.read()
        except Exception:
            data = {}
        if not isinstance(data, dict):
            data = {}
        # Ensure individually-set keys are included even if read() returns stale data
        for key in ("log_level", "sd_card_path", "default_dest_root", "save_root_path"):
            val = settings.getSetting(key, None)
            if val is not None:
                data[key] = val
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

    async def mount_usb_devices(self) -> List[str]:
        """Mount any unmounted USB partitions and return newly-mounted paths."""
        logger.info("Auto-mounting unmounted USB devices...")
        newly = await asyncio.to_thread(_mount_usb_devices)
        logger.info("Auto-mount complete: %d new mount(s): %s", len(newly), newly)
        return newly

    async def list_zip_files(self, mount_path: str) -> List[str]:
        logger.info("Listing ZIP files in: %s", mount_path)
        return _list_zip_files(Path(mount_path).expanduser())

    # --- Progress ---

    async def get_progress(self) -> Dict[str, Any]:
        p = dict(_progress)
        logger.debug("get_progress: op=%s pct=%d done=%s error=%s", p.get("operation"), p.get("percent"), p.get("done"), p.get("error"))
        return p

    # --- Copy (USB → SD card) ---

    async def start_copy(self, zip_path: str, dest_root: str) -> Dict[str, Any]:
        global _progress, _active_task
        logger.info("start_copy: zip_path=%s dest_root=%s", zip_path, dest_root)
        _progress = {
            "operation": "copy",
            "percent": 0,
            "bytes_done": 0,
            "bytes_total": 0,
            "current_file": "",
            "updated_at": time.time(),
            "done": False,
            "error": None,
            "result": None,
        }
        if _active_task and not _active_task.done():
            logger.warning("Cancelling in-flight task before starting new copy")
            _active_task.cancel()
        _active_task = asyncio.create_task(_do_copy(zip_path, dest_root))
        return {"started": True}

    # --- Extract (SD card ZIP → game folder) ---

    async def start_extract(self, zip_path: str, dest_root: str) -> Dict[str, Any]:
        global _progress, _active_task
        logger.info("start_extract: zip_path=%s dest_root=%s", zip_path, dest_root)
        _progress = {
            "operation": "extract",
            "percent": 0,
            "bytes_done": 0,
            "bytes_total": 0,
            "current_file": "",
            "updated_at": time.time(),
            "done": False,
            "error": None,
            "result": None,
        }
        if _active_task and not _active_task.done():
            logger.warning("Cancelling in-flight task before starting new extract")
            _active_task.cancel()
        _active_task = asyncio.create_task(_do_extract(zip_path, dest_root))
        return {"started": True}

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

    async def list_save_folders(self, save_root: str) -> List[str]:
        logger.info("Listing save folders in: %s", save_root)
        return _list_save_folders(Path(save_root).expanduser())

    async def create_save_symlink(self, game_dir: str, save_folder: str) -> Dict[str, Any]:
        logger.info("Creating save symlink for game_dir=%s save_folder=%s", game_dir, save_folder)
        return _create_save_symlink(Path(game_dir).expanduser(), Path(save_folder).expanduser())

    async def can_link_saves(self, game_dir: str) -> Dict[str, Any]:
        logger.info("Checking save symlink availability for game_dir=%s", game_dir)
        return _can_link_saves(Path(game_dir).expanduser())

    # --- Lifecycle ---

    async def _main(self) -> None:
        # Apply saved log level on startup
        try:
            level_str = settings.getSetting("log_level", "error")
            _apply_log_level(level_str)
            logger.info("Renpy Installer backend started (log_level=%s)", level_str.upper())
        except Exception as e:
            logger.error("Failed to apply log level from settings: %s", e)
            logger.info("Renpy Installer backend started.")
        while True:
            await asyncio.sleep(3600)

    async def _unload(self) -> None:
        global _active_task
        logger.info("Renpy Installer backend unloading...")
        if _active_task and not _active_task.done():
            logger.warning("Cancelling in-flight task on unload")
            _active_task.cancel()
        logger.info("Renpy Installer backend unloaded.")
