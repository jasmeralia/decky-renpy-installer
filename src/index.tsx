import { call, definePlugin, openFilePicker } from "@decky/api";

// FileSelectionType is a const enum in @decky/api — erased by tsc but not by esbuild,
// so it has no runtime presence in the dist. Use the numeric values directly.
const FileSelectionType = { FILE: 0, FOLDER: 1 } as const;
import {
  PanelSection,
  PanelSectionRow,
  ButtonItem,
  TextField,
  ProgressBarWithInfo,
  DropdownItem,
  SingleDropdownOption,
} from "@decky/ui";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { FaDownload } from "react-icons/fa";
import { basename, formatEta, formatSpeed } from "./pathUtils";

// --- Error Boundary (debug: catches render errors so they don't crash Decky) ---

type ErrorBoundaryState = { hasError: boolean; error: string };

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: "" };
  }

  static getDerivedStateFromError(e: unknown): ErrorBoundaryState {
    return { hasError: true, error: String(e) };
  }

  render() {
    if (this.state.hasError) {
      return React.createElement(
        "div",
        { style: { fontSize: 11, color: "#e67e6a", padding: 8, whiteSpace: "pre-wrap" } },
        "Plugin render error:\n" + this.state.error,
      );
    }
    return this.props.children;
  }
}

// --- Logger ---

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

let _logLevel: LogLevel = "error";

const LOG_LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function log(level: LogLevel, ...args: unknown[]): void {
  if (LOG_LEVEL_RANK[level] < LOG_LEVEL_RANK[_logLevel]) return;
  const prefix = `[renpy-installer][${level.toUpperCase()}]`;
  switch (level) {
    case "debug": console.debug(prefix, ...args); break;
    case "info":  console.info(prefix, ...args);  break;
    case "warn":  console.warn(prefix, ...args);  break;
    case "error": console.error(prefix, ...args); break;
  }
}

// --- Types ---

type SteamClientAPI = {
  Apps?: {
    AddShortcut?: (
      name: string,
      exe: string,
      startDir: string,
      args: string
    ) => Promise<number>;
    SpecifyCompatTool?: (appId: number, toolName: string) => void;
  };
  User?: {
    StartRestart?: (force: boolean) => void;
  };
};

type Step =
  | "browse"
  | "copying"
  | "extracting"
  | "conflict"
  | "launcher_pick"
  | "save_link"
  | "complete"
  | "error";

type ProgressRequest = {
  usb_zip_path: string;
  dest_root: string;
  overwrite: boolean;
  replace: boolean;
  suffix: boolean;
};

type ProgressResult = {
  job_id: number;
  operation: string;
  percent: number;
  bytes_done: number;
  bytes_total: number;
  current_file?: string;
  updated_at?: number;
  done: boolean;
  error: string | null;
  result: Record<string, string> | null;
  request: ProgressRequest | null;
};

type StartInstallResult = { started: boolean; busy: boolean; job_id: number; operation?: string };

type LaunchersResult = {
  launchers: string[];
  type: "sh" | "exe" | null;
};

type CanLinkSavesResult = {
  available: boolean;
  reason: string;
};

type CreateSaveSymlinkResult = {
  created: boolean;
  skipped: boolean;
  reason?: string;
  path?: string;
  target?: string;
};

// --- Backend API wrappers ---
// call<Args, Return>(route, ...args) — Args is a tuple of positional args passed to Python.

async function listUsbMounts(): Promise<string[]> {
  return call<[], string[]>("list_usb_mounts");
}

async function detectSdMount(): Promise<string | null> {
  return call<[], string | null>("detect_sd_mount");
}

async function mountUsbDevices(): Promise<string[]> {
  return call<[], string[]>("mount_usb_devices");
}

async function listZipFiles(mount_path: string): Promise<string[]> {
  return call<[string], string[]>("list_zip_files", mount_path);
}

type ConflictResult = {
  conflict: boolean;
  folder_name: string;
  suffix_folder_name: string | null;
};

async function checkExtractConflict(zip_path: string, dest_root: string): Promise<ConflictResult> {
  return call<[string, string], ConflictResult>("check_extract_conflict", zip_path, dest_root);
}

async function startInstall(
  usb_zip_path: string,
  dest_root: string,
  overwrite = false,
  replace = false,
  suffix = false,
): Promise<StartInstallResult> {
  return call<[string, string, boolean, boolean, boolean], StartInstallResult>(
    "start_install",
    usb_zip_path,
    dest_root,
    overwrite,
    replace,
    suffix,
  );
}

async function getProgress(): Promise<ProgressResult> {
  return call<[], ProgressResult>("get_progress");
}

async function getLaunchers(game_dir: string): Promise<LaunchersResult> {
  return call<[string], LaunchersResult>("get_launchers", game_dir);
}

async function ensureExecutable(launcher_path: string): Promise<void> {
  await call<[string]>("ensure_executable", launcher_path);
}

async function listSaveFolders(save_root: string): Promise<string[]> {
  return call<[string], string[]>("list_save_folders", save_root);
}

async function createSaveFolder(save_root: string, folder_name: string): Promise<string> {
  return call<[string, string], string>("create_save_folder", save_root, folder_name);
}

async function createSaveSymlink(
  game_dir: string,
  save_folder: string
): Promise<CreateSaveSymlinkResult> {
  return call<[string, string], CreateSaveSymlinkResult>("create_save_symlink", game_dir, save_folder);
}

async function canLinkSaves(game_dir: string): Promise<CanLinkSavesResult> {
  return call<[string], CanLinkSavesResult>("can_link_saves", game_dir);
}

async function loadSettings(): Promise<Record<string, unknown>> {
  return call<[], Record<string, unknown>>("settings_read");
}

async function saveSetting(key: string, value: unknown): Promise<void> {
  await call<[string, unknown]>("settings_set", key, value);
  await call<[]>("settings_commit");
}

async function backendSetLogLevel(level: string): Promise<boolean> {
  return call<[string], boolean>("set_log_level", level);
}

// --- Steam client helpers ---

async function addShortcut(
  name: string,
  exe: string,
  startDir: string,
  args: string
): Promise<{ ok: boolean; appId?: number; error?: unknown }> {
  try {
    const sc = (window as Window & { SteamClient?: SteamClientAPI }).SteamClient;
    if (!sc?.Apps?.AddShortcut) {
      log("error", "SteamClient.Apps.AddShortcut not available");
      return { ok: false, error: "SteamClient.Apps.AddShortcut not available" };
    }
    log("info", "Adding Steam shortcut:", name, exe, startDir, args);
    const appId = await sc.Apps.AddShortcut(name, exe, startDir, args);
    log("info", "Steam shortcut added, appId:", appId);
    return { ok: true, appId };
  } catch (e) {
    log("error", "addShortcut failed:", e);
    return { ok: false, error: e };
  }
}

function specifyCompatTool(appId: number, toolName: string): void {
  try {
    const sc = (window as Window & { SteamClient?: SteamClientAPI }).SteamClient;
    sc?.Apps?.SpecifyCompatTool?.(appId, toolName);
    log("info", "Set compat tool for appId", appId, "→", toolName);
  } catch (e) {
    log("warn", "specifyCompatTool failed (non-fatal):", e);
  }
}

function restartSteam(): void {
  try {
    const sc = (window as Window & { SteamClient?: SteamClientAPI }).SteamClient;
    sc?.User?.StartRestart?.(false);
    log("info", "Steam restart requested");
  } catch (e) {
    log("warn", "restartSteam failed (non-fatal):", e);
  }
}

// --- Plugin ---

export default definePlugin(() => {
  const Content: React.FC = () => {
    const [step, setStep] = useState<Step>("browse");
    const [progress, setProgress] = useState(0);
    const [usbSafeMsg, setUsbSafeMsg] = useState(false);
    const [launchers, setLaunchers] = useState<string[]>([]);
    const [launcherType, setLauncherType] = useState<"sh" | "exe">("sh");
    const [pendingGameDir, setPendingGameDir] = useState("");
    const [completedGameName, setCompletedGameName] = useState("");
    const [errorMsg, setErrorMsg] = useState("");
    const [destRoot, setDestRoot] = useState("/run/media/mmcblk0p1/Games");
    const [saveRoot, setSaveRoot] = useState("");
    const [saveFolders, setSaveFolders] = useState<string[]>([]);
    const [saveGameDir, setSaveGameDir] = useState("");
    const [saveLinkStatus, setSaveLinkStatus] = useState("");
    const [newSaveFolderName, setNewSaveFolderName] = useState("");
    const [usbMounts, setUsbMounts] = useState<string[]>([]);
    const [usbPath, setUsbPath] = useState("");
    const [zipFiles, setZipFiles] = useState<string[]>([]);
    const [page, setPage] = useState<"browse" | "settings">("browse");
    const [settingsBusy, setSettingsBusy] = useState(false);
    const [zipPage, setZipPage] = useState(0);
    const [browseStatus, setBrowseStatus] = useState("");
    const [settingsStatus, setSettingsStatus] = useState("");
    const [mountStatus, setMountStatus] = useState("");
    const [logLevel, setLogLevel] = useState<LogLevel>("error");
    const [unseenResult, setUnseenResult] = useState<ProgressResult | null>(null);

    const [currentZipName, setCurrentZipName] = useState("");
    const [conflictFolderName, setConflictFolderName] = useState("");
    const [suffixFolderName, setSuffixFolderName] = useState("");
    const [pendingUsbZipPath, setPendingUsbZipPath] = useState("");
    const [speedBytesPerSec, setSpeedBytesPerSec] = useState(0);
    const pollInterval = useRef<ReturnType<typeof setInterval> | null>(null);
    const operationStartTime = useRef<number | null>(null);
    const prevSpeedBytes = useRef(0);
    const prevSpeedTime = useRef(0);

    const stopPolling = useCallback(() => {
      if (pollInterval.current !== null) {
        log("debug", "Stopping progress poll interval");
        clearInterval(pollInterval.current);
        pollInterval.current = null;
      }
    }, []);

    // Resolves once the backend operation completes, streaming percent + speed updates.
    const waitForProgress = useCallback(
      (onUpdate: (pct: number, bps: number, operation: string) => void): Promise<ProgressResult> =>
        new Promise((resolve) => {
          stopPolling();
          prevSpeedBytes.current = 0;
          prevSpeedTime.current = Date.now();
          log("debug", "Starting progress poll interval (500ms)");
          pollInterval.current = setInterval(async () => {
            try {
              const p = await getProgress();
              log("debug", "Progress poll:", p.operation, p.percent + "%", p.done ? "(done)" : "");
              const now = Date.now();
              const dt = (now - prevSpeedTime.current) / 1000;
              let bps = 0;
              if (dt > 0 && p.bytes_total > 0) {
                bps = Math.max(0, (p.bytes_done - prevSpeedBytes.current) / dt);
                prevSpeedBytes.current = p.bytes_done;
                prevSpeedTime.current = now;
              }
              onUpdate(p.percent, bps, p.operation);
              if (p.done) {
                stopPolling();
                if (p.error) {
                  log("error", "Backend operation failed:", p.error);
                } else {
                  log("info", "Backend operation completed:", p.operation, "result:", p.result);
                }
                resolve(p);
              }
            } catch (e) {
              log("error", "getProgress poll threw:", e);
              stopPolling();
              resolve({
                job_id: 0,
                operation: "",
                percent: 0,
                bytes_done: 0,
                bytes_total: 0,
                done: true,
                error: String(e),
                result: null,
                request: null,
              });
            }
          }, 500);
        }),
      [stopPolling]
    );

    // Stop any in-flight poll when the component unmounts
    useEffect(() => () => stopPolling(), [stopPolling]);

    // Load settings and detect mounts on mount
    useEffect(() => {
      (async () => {
        try {
          const active = await getProgress();
          if (!active.done) {
            log("info", "Resuming in-progress job on mount: job_id=%d operation=%s", active.job_id, active.operation);
            void awaitInstallCompletion().catch((e) => {
              log("error", "Resumed install failed:", e);
              setErrorMsg(String(e));
              setStep("error");
            });
            return;
          }
          if (active.operation !== "" && (active.result || active.error)) {
            setUnseenResult(active);
          }
        } catch (e) {
          log("warn", "getProgress on mount failed (non-fatal):", e);
        }
        log("debug", "Loading settings and detecting mounts...");
        let hasSdSetting = false;
        try {
          const s = await loadSettings();
          log("debug", "Loaded settings:", s);

          // Apply saved log level
          if (typeof s?.log_level === "string" && s.log_level.length > 0) {
            const savedLevel = s.log_level as LogLevel;
            if (LOG_LEVELS.includes(savedLevel)) {
              _logLevel = savedLevel;
              setLogLevel(savedLevel);
              log("info", "Log level restored from settings:", savedLevel);
            }
          }

          if (typeof s?.sd_card_path === "string" && s.sd_card_path.length > 0) {
            setDestRoot(s.sd_card_path);
            hasSdSetting = true;
            log("debug", "Loaded sd_card_path from settings:", s.sd_card_path);
          } else if (
            typeof s?.default_dest_root === "string" &&
            s.default_dest_root.length > 0
          ) {
            setDestRoot(s.default_dest_root);
            log("debug", "Loaded default_dest_root from settings:", s.default_dest_root);
          }
          if (typeof s?.save_root_path === "string" && s.save_root_path.length > 0) {
            setSaveRoot(s.save_root_path);
            log("debug", "Loaded save_root_path from settings:", s.save_root_path);
          }
        } catch (e) {
          log("warn", "Failed to load settings:", e);
        }
        if (!hasSdSetting) {
          try {
            log("debug", "No SD path in settings, auto-detecting...");
            const detected = await detectSdMount();
            if (detected) {
              log("info", "Auto-detected SD card mount:", detected);
              setDestRoot(detected);
              await saveSetting("sd_card_path", detected);
            } else {
              log("warn", "SD card auto-detection returned null");
            }
          } catch (e) {
            log("warn", "detectSdMount failed:", e);
          }
        }
        // Auto-mount any unmounted USB partitions before listing
        try {
          const newlyMounted = await mountUsbDevices();
          if (newlyMounted.length > 0) {
            log("info", "Auto-mounted USB devices:", newlyMounted);
            setMountStatus(`Auto-mounted: ${newlyMounted.join(", ")}`);
          } else {
            log("info", "No new USB devices to mount");
            setMountStatus("No unmounted USB partitions found.");
          }
        } catch (e) {
          log("warn", "mountUsbDevices failed (non-fatal):", e);
          setMountStatus(`Mount error: ${String(e)}`);
        }
        try {
          const mounts = await listUsbMounts();
          log("info", "USB mounts found:", mounts);
          setUsbMounts(mounts);
          if (mounts.length > 0) {
            setUsbPath(mounts[0]);
            // Use local variable — usbPath state is still "" at this point
            setSettingsBusy(true);
            setBrowseStatus("Scanning USB for ZIP files…");
            try {
              const files = await listZipFiles(mounts[0]);
              log("info", "Auto-scan found ZIP files:", files);
              setZipFiles(files);
              setZipPage(0);
              setBrowseStatus(`Found ${files.length} ZIP file(s).`);
            } catch (e) {
              log("warn", "Auto-scan listZipFiles failed:", e);
              setZipFiles([]);
              setBrowseStatus(`No ZIP files found: ${String(e)}`);
            } finally {
              setSettingsBusy(false);
            }
          }
        } catch (e) {
          log("warn", "listUsbMounts failed:", e);
          setUsbMounts([]);
        }
      })();
    }, []);

    // --- Browse-screen handlers ---

    const refreshZipFiles = async () => {
      if (!usbPath.trim()) {
        log("warn", "refreshZipFiles called with empty usbPath");
        setBrowseStatus("No USB mount path set.");
        return;
      }
      log("info", "Scanning USB for ZIP files:", usbPath);
      setSettingsBusy(true);
      setBrowseStatus("Scanning USB for ZIP files…");
      try {
        const files = await listZipFiles(usbPath);
        log("info", "Found ZIP files:", files);
        setZipFiles(files);
        setZipPage(0);
        setBrowseStatus(`Found ${files.length} ZIP file(s).`);
      } catch (e) {
        log("error", "listZipFiles failed:", e);
        setZipFiles([]);
        setBrowseStatus(`Error: ${String(e)}`);
      } finally {
        setSettingsBusy(false);
      }
    };

    const refreshUsbMounts = async () => {
      log("info", "Refreshing USB mounts");
      setSettingsBusy(true);
      setBrowseStatus("Refreshing USB mounts...");
      try {
        const newlyMounted = await mountUsbDevices();
        const mounts = await listUsbMounts();
        setUsbMounts(mounts);
        if (!usbPath && mounts.length > 0) {
          setUsbPath(mounts[0]);
        }
        setMountStatus(
          newlyMounted.length > 0
            ? `Auto-mounted: ${newlyMounted.join(", ")}`
            : "No unmounted USB partitions found.",
        );
        setBrowseStatus(`Found ${mounts.length} USB mount(s).`);
      } catch (e) {
        log("error", "refreshUsbMounts failed:", e);
        setBrowseStatus(`Mount error: ${String(e)}`);
      } finally {
        setSettingsBusy(false);
      }
    };

    const handleSaveSdPath = async () => {
      if (!destRoot.trim()) {
        log("warn", "handleSaveSdPath called with empty destRoot");
        setSettingsStatus("SD card path is not set.");
        return;
      }
      log("info", "Saving SD card path:", destRoot);
      setSettingsBusy(true);
      try {
        await saveSetting("sd_card_path", destRoot);
        log("info", "SD card path saved");
        setSettingsStatus("SD card path saved.");
      } catch (e) {
        log("error", "saveSetting(sd_card_path) failed:", e);
        setSettingsStatus(`Error: ${String(e)}`);
      } finally {
        setSettingsBusy(false);
      }
    };

    const handleBrowseUsb = async () => {
      log("info", "Opening file picker for USB folder");
      try {
        const res = await openFilePicker(
          FileSelectionType.FOLDER,
          usbPath.trim() || "/run/media/",
          false,
          true,
        );
        log("info", "USB folder selected:", res.realpath);
        setUsbPath(res.realpath);
      } catch (e) {
        log("warn", "USB folder picker cancelled or failed:", e);
      }
    };

    const handleBrowseSd = async () => {
      log("info", "Opening file picker for SD card destination");
      try {
        const res = await openFilePicker(
          FileSelectionType.FOLDER,
          destRoot.trim() || "/run/media/",
          false,
          true,
        );
        log("info", "SD card folder selected:", res.realpath);
        setDestRoot(res.realpath);
      } catch (e) {
        log("warn", "SD card folder picker cancelled or failed:", e);
      }
    };

    const handleBrowseSaveRoot = async () => {
      log("info", "Opening file picker for save root folder");
      try {
        const res = await openFilePicker(
          FileSelectionType.FOLDER,
          saveRoot.trim() || "/home/deck/",
          false,
          true,
        );
        log("info", "Save root folder selected:", res.realpath);
        setSaveRoot(res.realpath);
      } catch (e) {
        log("warn", "Save root picker cancelled or failed:", e);
      }
    };

    const handleSaveSaveRoot = async () => {
      log("info", "Saving save root path:", saveRoot);
      setSettingsBusy(true);
      try {
        await saveSetting("save_root_path", saveRoot.trim());
        setSettingsStatus(saveRoot.trim() ? "Save root path saved." : "Save root path cleared.");
      } catch (e) {
        log("error", "saveSetting(save_root_path) failed:", e);
        setSettingsStatus(`Error: ${String(e)}`);
      } finally {
        setSettingsBusy(false);
      }
    };

    const handleLogLevelChange = async (option: SingleDropdownOption) => {
      const level = option.data as LogLevel;
      _logLevel = level;
      setLogLevel(level);
      try {
        await saveSetting("log_level", level);
        await backendSetLogLevel(level);
        log("info", "Log level updated to:", level);
      } catch (e) {
        log("warn", "handleLogLevelChange failed:", e);
      }
    };

    // --- Installation flow ---

    const offerSaveLinkOrComplete = async (gameDir: string, gameName: string) => {
      if (!saveRoot.trim()) {
        setStep("complete");
        return;
      }
      try {
        const availability = await canLinkSaves(gameDir);
        if (!availability.available) {
          log("info", "Save link skipped:", availability.reason);
          setSaveLinkStatus(availability.reason);
          setStep("complete");
          return;
        }
        const folders = await listSaveFolders(saveRoot);
        if (folders.length === 0) {
          log("info", "Save root has no folders:", saveRoot);
          setSaveLinkStatus("No save folders found.");
        }
        setSaveGameDir(gameDir);
        setSaveFolders(folders);
        setNewSaveFolderName("");
        setSaveLinkStatus("");
        setCompletedGameName(gameName);
        setStep("save_link");
      } catch (e) {
        log("warn", "Save link offer failed; continuing to completion:", e);
        setSaveLinkStatus(String(e));
        setStep("complete");
      }
    };

    const finishInstall = async (
      gameDir: string,
      launcherPath: string,
      lType: "sh" | "exe"
    ) => {
      const gameName = basename(gameDir);
      const exe = launcherPath;
      const args = "";
      log("info", "finishInstall: gameName=%s exe=%s startDir=%s type=%s", gameName, exe, gameDir, lType);
      const addResult = await addShortcut(gameName, exe, gameDir, args);
      if (!addResult.ok) {
        throw new Error(`Could not add Steam shortcut: ${String(addResult.error)}`);
      }
      if (lType === "exe" && addResult.appId !== undefined) {
        log("info", "Launcher is .exe — setting Proton Experimental for appId:", addResult.appId);
        specifyCompatTool(addResult.appId, "proton_experimental");
      }
      setCompletedGameName(gameName);
      log("info", "Installation complete for:", gameName);
      await offerSaveLinkOrComplete(gameDir, gameName);
    };

    const handleSaveFolderPick = async (saveFolder: string) => {
      try {
        const result = await createSaveSymlink(saveGameDir, saveFolder);
        if (result.created) {
          setSaveLinkStatus(`Linked saves to ${basename(saveFolder)}.`);
        } else if (result.skipped) {
          setSaveLinkStatus(result.reason ?? "Save linking skipped.");
        }
        setStep("complete");
      } catch (e) {
        log("error", "createSaveSymlink failed:", e);
        setErrorMsg(String(e));
        setStep("error");
      }
    };

    const handleCreateSaveFolder = async () => {
      const folderName = newSaveFolderName.trim();
      if (!folderName) {
        setSaveLinkStatus("Enter a save folder name.");
        return;
      }
      try {
        const saveFolder = await createSaveFolder(saveRoot, folderName);
        log("info", "Created save folder:", saveFolder);
        await handleSaveFolderPick(saveFolder);
      } catch (e) {
        log("error", "createSaveFolder failed:", e);
        setSaveLinkStatus(String(e));
      }
    };

    const handleSkipSaveLink = () => {
      log("info", "User skipped save linking");
      setSaveLinkStatus("Save linking skipped.");
      setStep("complete");
    };

    const handleLauncherPick = async (launcherPath: string) => {
      log("info", "User picked launcher:", launcherPath);
      try {
        await ensureExecutable(launcherPath);
        await finishInstall(pendingGameDir, launcherPath, launcherType);
      } catch (e) {
        log("error", "handleLauncherPick failed:", e);
        setErrorMsg(String(e));
        setStep("error");
      }
    };

    const awaitInstallCompletion = async (): Promise<void> => {
      const initial = await getProgress();
      if (initial.request) {
        setCurrentZipName(basename(initial.request.usb_zip_path));
      }
      setStep(initial.operation === "extract" ? "extracting" : "copying");
      setProgress(initial.percent);
      setUsbSafeMsg(initial.operation === "extract");
      operationStartTime.current = Date.now();

      const result = await waitForProgress((pct, bps, operation) => {
        setProgress(pct);
        setSpeedBytesPerSec(bps);
        setStep(operation === "extract" ? "extracting" : "copying");
        if (operation === "extract") setUsbSafeMsg(true);
      });
      if (result.error) throw new Error(result.error);
      const gameDir = result.result!.game_dir;

      const lr = await getLaunchers(gameDir);
      if (!lr.launchers.length || !lr.type) {
        throw new Error("No .sh or .exe launcher found in the game folder.");
      }
      if (lr.launchers.length === 1) {
        await ensureExecutable(lr.launchers[0]);
        await finishInstall(gameDir, lr.launchers[0], lr.type);
      } else {
        setPendingGameDir(gameDir);
        setLaunchers(lr.launchers);
        setLauncherType(lr.type);
        setStep("launcher_pick");
      }
    };

    const doInstall = async (
      usbZipPath: string,
      overwrite: boolean,
      replace = false,
      suffix = false,
    ) => {
      try {
        const started = await startInstall(usbZipPath, destRoot, overwrite, replace, suffix);
        if (started.busy) {
          log("warn", "Install already in progress (job %d, %s) — attaching instead of starting a new one", started.job_id, started.operation);
        }
        await awaitInstallCompletion();
      } catch (e) {
        log("error", "doInstall flow failed:", e);
        setErrorMsg(String(e));
        setStep("error");
      }
    };

    const handleZipSelect = async (usbZipPath: string) => {
      if (!destRoot.trim()) {
        log("error", "handleZipSelect: destRoot is empty");
        setErrorMsg("SD card destination path is not set.");
        setStep("error");
        return;
      }
      log("info", "handleZipSelect: zip=%s dest=%s", usbZipPath, destRoot);
      setCurrentZipName(basename(usbZipPath));
      setUsbSafeMsg(false);
      try {
        const conflict = await checkExtractConflict(usbZipPath, destRoot);
        if (conflict.conflict) {
          log("info", "Destination folder already exists: %s", conflict.folder_name);
          setConflictFolderName(conflict.folder_name);
          setSuffixFolderName(conflict.suffix_folder_name ?? `${conflict.folder_name}_2`);
          setPendingUsbZipPath(usbZipPath);
          setStep("conflict");
          return;
        }
      } catch (e) {
        log("warn", "checkExtractConflict failed (non-fatal), proceeding:", e);
      }
      await doInstall(usbZipPath, false);
    };

    const handleOverwrite = () => {
      log("info", "User chose overwrite for:", conflictFolderName);
      void doInstall(pendingUsbZipPath, true, false);
    };

    const handleReplace = () => {
      log("info", "User chose delete-and-reinstall for:", conflictFolderName);
      void doInstall(pendingUsbZipPath, false, true);
    };

    const handleSuffix = () => {
      log("info", "User chose suffixed install for:", conflictFolderName);
      void doInstall(pendingUsbZipPath, false, false, true);
    };

    const handleConflictCancel = () => {
      log("info", "User cancelled conflict, returning to browse");
      setStep("browse");
    };

    const handleInstallAnother = () => {
      log("info", "User clicked 'Install another game', resetting to browse");
      setPage("browse");
      setStep("browse");
      setProgress(0);
      setUsbSafeMsg(false);
      setLaunchers([]);
      setErrorMsg("");
      setCompletedGameName("");
      setSaveFolders([]);
      setSaveGameDir("");
      setSaveLinkStatus("");
    };

    const handleFinish = () => {
      log("info", "User clicked Finish, restarting Steam");
      // Restart Steam so the new shortcut appears in the library.
      restartSteam();
    };

    // ---- RENDER ----

    if (step === "copying" || step === "extracting") {
      return (
        <PanelSection title="Renpy ZIP Installer">
          {usbSafeMsg && (
            <PanelSectionRow>
              <div style={{ fontSize: 12, color: "#8dba6a" }}>
                USB drive can be safely removed unless you have more games to install.
              </div>
            </PanelSectionRow>
          )}
          {currentZipName ? (
            <PanelSectionRow>
              <div style={{ fontSize: 12, opacity: 0.9, fontWeight: "bold" }}>
                {currentZipName}
              </div>
            </PanelSectionRow>
          ) : null}
          <PanelSectionRow>
            <ProgressBarWithInfo
              nProgress={progress}
              sOperationText={
                step === "copying" ? "Copying to SD card…" : "Extracting…"
              }
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <div style={{ fontSize: 12, opacity: 0.7 }}>
              {operationStartTime.current !== null
                ? [
                    formatEta(progress, operationStartTime.current),
                    formatSpeed(speedBytesPerSec),
                  ].filter(Boolean).join(" • ")
                : ""}
            </div>
          </PanelSectionRow>
        </PanelSection>
      );
    }

    if (step === "conflict") {
      return (
        <PanelSection title="Renpy ZIP Installer">
          <PanelSectionRow>
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              "{conflictFolderName}" already exists at the destination.
            </div>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={handleOverwrite}>
              Overwrite (update files in place)
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={handleReplace}>
              Delete and reinstall
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={handleSuffix}>
              Install as "{suffixFolderName}"
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={handleConflictCancel}>
              Cancel
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      );
    }

    if (step === "launcher_pick") {
      return (
        <PanelSection title="Choose Launcher">
          <PanelSectionRow>
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              Multiple launcher files found. Choose one:
            </div>
          </PanelSectionRow>
          {launchers.map((p) => (
            <PanelSectionRow key={p}>
              <ButtonItem layout="below" onClick={() => handleLauncherPick(p)}>
                {basename(p)}
              </ButtonItem>
            </PanelSectionRow>
          ))}
        </PanelSection>
      );
    }

    if (step === "save_link") {
      return (
        <PanelSection title="Link Saves">
          <PanelSectionRow>
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              Choose a save folder to link for "{completedGameName}".
            </div>
          </PanelSectionRow>
          {saveFolders.map((p) => (
            <PanelSectionRow key={p}>
              <ButtonItem layout="below" onClick={() => handleSaveFolderPick(p)}>
                {basename(p)}
              </ButtonItem>
            </PanelSectionRow>
          ))}
          <PanelSectionRow>
            <TextField
              label="New save folder"
              value={newSaveFolderName}
              onChange={(e) => setNewSaveFolderName(e.target.value)}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              onClick={handleCreateSaveFolder}
              disabled={!newSaveFolderName.trim()}
            >
              Create and link save folder
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={handleSkipSaveLink}>
              Skip save link
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      );
    }

    if (step === "complete") {
      return (
        <PanelSection title="Renpy ZIP Installer">
          <PanelSectionRow>
            <div style={{ fontSize: 12, color: "#8dba6a" }}>
              "{completedGameName}" added to Steam. Click Finish to restart Steam
              so it appears in your library.
            </div>
          </PanelSectionRow>
          {saveLinkStatus ? (
            <PanelSectionRow>
              <div style={{ fontSize: 12, opacity: 0.8 }}>{saveLinkStatus}</div>
            </PanelSectionRow>
          ) : null}
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={handleInstallAnother}>
              Install another game
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={handleFinish}>
              Finish
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      );
    }

    if (step === "error") {
      return (
        <PanelSection title="Renpy ZIP Installer">
          <PanelSectionRow>
            <div style={{ fontSize: 12, color: "#e67e6a", whiteSpace: "pre-wrap" }}>
              {errorMsg}
            </div>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => setStep("browse")}>
              Back
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      );
    }

    const logLevelOptions: SingleDropdownOption[] = LOG_LEVELS.map((l) => ({
      data: l,
      label: l.toUpperCase(),
    }));

    if (page === "settings") {
      return (
        <PanelSection title="Settings">
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => setPage("browse")}>
              Back to installer
            </ButtonItem>
          </PanelSectionRow>

          <PanelSectionRow>
            <TextField
              label="SD card destination"
              description="Games folder on SD card."
              value={destRoot}
              onChange={(e) => setDestRoot(e.target.value)}
              disabled={settingsBusy}
            />
          </PanelSectionRow>

          <PanelSectionRow>
            <ButtonItem
              layout="below"
              onClick={handleBrowseSd}
              disabled={settingsBusy}
            >
              Browse for SD card folder…
            </ButtonItem>
          </PanelSectionRow>

          <PanelSectionRow>
            <ButtonItem
              layout="below"
              onClick={handleSaveSdPath}
              disabled={settingsBusy || !destRoot.trim()}
            >
              Save SD card path
            </ButtonItem>
          </PanelSectionRow>

          <PanelSectionRow>
            <TextField
              label="Save root folder"
              description="Optional folder containing per-game save folders."
              value={saveRoot}
              onChange={(e) => setSaveRoot(e.target.value)}
              disabled={settingsBusy}
            />
          </PanelSectionRow>

          <PanelSectionRow>
            <ButtonItem
              layout="below"
              onClick={handleBrowseSaveRoot}
              disabled={settingsBusy}
            >
              Browse for save root folder...
            </ButtonItem>
          </PanelSectionRow>

          <PanelSectionRow>
            <ButtonItem
              layout="below"
              onClick={handleSaveSaveRoot}
              disabled={settingsBusy}
            >
              Save save root path
            </ButtonItem>
          </PanelSectionRow>

          <PanelSectionRow>
            <DropdownItem
              label="Log level"
              description="Backend and frontend logging verbosity."
              rgOptions={logLevelOptions}
              selectedOption={logLevel}
              onChange={handleLogLevelChange}
              disabled={settingsBusy}
            />
          </PanelSectionRow>

          {settingsStatus ? (
            <PanelSectionRow>
              <div style={{ fontSize: 12, opacity: 0.8 }}>{settingsStatus}</div>
            </PanelSectionRow>
          ) : null}
        </PanelSection>
      );
    }

    // Browse step
    return (
      <PanelSection title="Renpy ZIP Installer">
        {page === "browse" && step === "browse" && unseenResult !== null ? (
          <>
            <PanelSectionRow>
              <div style={{ fontSize: 12, opacity: 0.8 }}>
                {unseenResult.error === null
                  ? `A previous install of "${basename(unseenResult.request?.usb_zip_path ?? "")}" finished while you were away. It was extracted to the SD card but was not added to Steam automatically.`
                  : `A previous install of "${basename(unseenResult.request?.usb_zip_path ?? "")}" failed while you were away: ${unseenResult.error}`}
              </div>
            </PanelSectionRow>
            <PanelSectionRow>
              <ButtonItem layout="below" onClick={() => setUnseenResult(null)}>
                Dismiss
              </ButtonItem>
            </PanelSectionRow>
          </>
        ) : null}
        {mountStatus ? (
          <PanelSectionRow>
            <div style={{ fontSize: 11, opacity: 0.7 }}>{mountStatus}</div>
          </PanelSectionRow>
        ) : null}
        <PanelSectionRow>
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            USB mounts:{" "}
            {usbMounts.length ? usbMounts.join(", ") : "None detected."}
          </div>
        </PanelSectionRow>

        <PanelSectionRow>
          <TextField
            label="USB mount path"
            value={usbPath}
            onChange={(e) => setUsbPath(e.target.value)}
            disabled={settingsBusy}
          />
        </PanelSectionRow>

        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={handleBrowseUsb}
            disabled={settingsBusy}
          >
            Browse for USB folder…
          </ButtonItem>
        </PanelSectionRow>

        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={refreshUsbMounts}
            disabled={settingsBusy}
          >
            Refresh USB mounts
          </ButtonItem>
        </PanelSectionRow>

        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={refreshZipFiles}
            disabled={settingsBusy || !usbPath.trim()}
          >
            Refresh ZIP list from USB
          </ButtonItem>
        </PanelSectionRow>

        {(() => {
          const ZIP_PAGE_SIZE = 10;
          const zipPageCount = Math.ceil(zipFiles.length / ZIP_PAGE_SIZE);
          const zipPageFiles = zipFiles.slice(
            zipPage * ZIP_PAGE_SIZE,
            (zipPage + 1) * ZIP_PAGE_SIZE
          );
          return (
            <>
              <PanelSectionRow>
                <div style={{ fontSize: 12, opacity: 0.8 }}>
                  {zipFiles.length
                    ? zipPageCount > 1
                      ? `Select a ZIP to install (page ${zipPage + 1}/${zipPageCount}):`
                      : "Select a ZIP to install:"
                    : "No ZIPs loaded."}
                </div>
              </PanelSectionRow>

              {zipPageFiles.map((p) => (
                <PanelSectionRow key={p}>
                  <ButtonItem layout="below" onClick={() => handleZipSelect(p)}>
                    {basename(p)}
                  </ButtonItem>
                </PanelSectionRow>
              ))}

              {zipPageCount > 1 && (
                <PanelSectionRow>
                  <ButtonItem
                    layout="below"
                    onClick={() => setZipPage((pg) => Math.max(0, pg - 1))}
                    disabled={zipPage === 0}
                  >
                    Previous page
                  </ButtonItem>
                </PanelSectionRow>
              )}
              {zipPageCount > 1 && (
                <PanelSectionRow>
                  <ButtonItem
                    layout="below"
                    onClick={() =>
                      setZipPage((pg) => Math.min(zipPageCount - 1, pg + 1))
                    }
                    disabled={zipPage >= zipPageCount - 1}
                  >
                    Next page
                  </ButtonItem>
                </PanelSectionRow>
              )}
            </>
          );
        })()}

        <PanelSectionRow>
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            Install to: {destRoot.trim() || "(not set — open Settings)"}
          </div>
        </PanelSectionRow>

        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => setPage("settings")}>
            Settings
          </ButtonItem>
        </PanelSectionRow>

        {browseStatus ? (
          <PanelSectionRow>
            <div style={{ fontSize: 12, opacity: 0.8 }}>{browseStatus}</div>
          </PanelSectionRow>
        ) : null}
      </PanelSection>
    );
  };

  return {
    name: "Renpy Installer",
    content: (
      <ErrorBoundary>
        <Content />
      </ErrorBoundary>
    ),
    icon: <FaDownload />,
  };
});
