import asyncio
import logging
import os
import re
import shutil
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional

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
        raise RuntimeError(f"USB mount path does not exist or is not a directory: {mount_path}")

    zip_files = [p for p in mount_path.rglob("*.zip") if p.is_file()]
    if not zip_files:
        raise RuntimeError(f"No .zip files found on USB drive: {mount_path}")

    zip_files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return [str(p) for p in zip_files]


def _copy_file(src: Path, dst: Path) -> None:
    _ensure_dir(dst.parent)
    shutil.copy2(src, dst)


def _extract_zip(zip_path: Path, dest_dir: Path) -> None:
    _ensure_dir(dest_dir)
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(dest_dir)


def _find_launcher_sh(dest_dir: Path) -> Path:
    candidates: List[Path] = []
    candidates.extend([p for p in dest_dir.glob("*.sh") if p.is_file()])
    if not candidates:
        candidates.extend([p for p in dest_dir.glob("*/*.sh") if p.is_file()])

    if len(candidates) == 0:
        raise RuntimeError("No .sh launcher found after extraction.")
    if len(candidates) > 1:
        c_list = "\n".join(str(c) for c in sorted(candidates))
        raise RuntimeError(f"Multiple .sh files found; cannot decide launcher:\n{c_list}")

    launcher = candidates[0]
    try:
        st = launcher.stat()
        launcher.chmod(st.st_mode | 0o111)
    except Exception:
        pass
    return launcher


class Plugin:
    async def settings_read(self) -> Dict[str, Any]:
        return settings.read()

    async def settings_commit(self) -> bool:
        settings.commit()
        return True

    async def settings_set(self, key: str, value: Any) -> bool:
        settings.setSetting(key, value)
        return True

    async def list_usb_mounts(self) -> List[str]:
        return _list_mount_points()

    async def detect_sd_mount(self) -> Optional[str]:
        return _find_sd_mount()

    async def list_zip_files(self, mount_path: str) -> List[str]:
        return _list_zip_files(Path(mount_path).expanduser())

    async def copy_zip_to_sd(self, zip_path: str, dest_root: str) -> Dict[str, str]:
        src_zip = Path(zip_path).expanduser()
        if not src_zip.exists() or not src_zip.is_file():
            raise RuntimeError(f"ZIP path does not exist or is not a file: {src_zip}")

        dest_root_p = Path(dest_root).expanduser()
        if not dest_root_p.exists():
            _ensure_dir(dest_root_p)

        dest_zip = dest_root_p / src_zip.name
        _copy_file(src_zip, dest_zip)
        return {"dest_zip": str(dest_zip)}

    async def install_from_zip(
        self,
        zip_path: str,
        dest_root: str,
        overwrite: bool,
        dest_folder_name: Optional[str] = None,
    ) -> Dict[str, str]:
        # Copies a ZIP to dest_root, extracts it, deletes the copied ZIP,
        # then finds the single Ren'Py launcher .sh and returns paths.
        src_zip = Path(zip_path).expanduser()
        if not src_zip.exists() or not src_zip.is_file():
            raise RuntimeError(f"ZIP path does not exist or is not a file: {src_zip}")

        dest_root_p = Path(dest_root).expanduser()
        if not dest_root_p.exists():
            _ensure_dir(dest_root_p)

        folder = dest_folder_name or _safe_folder_name(src_zip.name)
        install_dir = dest_root_p / folder

        if install_dir.exists():
            if not overwrite:
                raise RuntimeError(f"Destination already exists: {install_dir} (enable overwrite to replace)")
            shutil.rmtree(install_dir)

        _ensure_dir(install_dir)

        copied_zip = install_dir / src_zip.name
        _copy_file(src_zip, copied_zip)
        _extract_zip(copied_zip, install_dir)

        try:
            copied_zip.unlink(missing_ok=True)
        except TypeError:
            if copied_zip.exists():
                copied_zip.unlink()

        launcher = _find_launcher_sh(install_dir)
        suggested_name = folder

        return {
            "install_dir": str(install_dir),
            "launcher_sh": str(launcher),
            "suggested_name": suggested_name,
        }

    async def _main(self):
        logger.info("Ren'Py Installer backend started.")
        while True:
            await asyncio.sleep(3600)

    async def _unload(self):
        logger.info("Ren'Py Installer backend unloaded.")
