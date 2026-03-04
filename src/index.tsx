import { definePlugin, Navigation } from "decky-frontend-lib";
import {
  PanelSection,
  PanelSectionRow,
  ButtonItem,
  TextField,
  ProgressBarWithInfo,
} from "@decky/ui";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { FaDownload } from "react-icons/fa";
import { call } from "@decky/api";

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
  | "launcher_pick"
  | "complete"
  | "error";

type ProgressResult = {
  operation: string;
  percent: number;
  done: boolean;
  error: string | null;
  result: Record<string, string> | null;
};

type LaunchersResult = {
  launchers: string[];
  type: "sh" | "exe" | null;
};

// --- Backend API wrappers ---
// call<Args, Return>(route, ...args) — Args is a tuple of positional args passed to Python.

async function listUsbMounts(): Promise<string[]> {
  return call<[], string[]>("list_usb_mounts");
}

async function detectSdMount(): Promise<string | null> {
  return call<[], string | null>("detect_sd_mount");
}

async function listZipFiles(mount_path: string): Promise<string[]> {
  return call<[{ mount_path: string }], string[]>("list_zip_files", { mount_path });
}

async function startCopy(zip_path: string, dest_root: string): Promise<void> {
  await call<[{ zip_path: string; dest_root: string }]>("start_copy", { zip_path, dest_root });
}

async function startExtract(zip_path: string, dest_root: string): Promise<void> {
  await call<[{ zip_path: string; dest_root: string }]>("start_extract", { zip_path, dest_root });
}

async function getProgress(): Promise<ProgressResult> {
  return call<[], ProgressResult>("get_progress");
}

async function getLaunchers(game_dir: string): Promise<LaunchersResult> {
  return call<[{ game_dir: string }], LaunchersResult>("get_launchers", { game_dir });
}

async function ensureExecutable(launcher_path: string): Promise<void> {
  await call<[{ launcher_path: string }]>("ensure_executable", { launcher_path });
}

async function loadSettings(): Promise<Record<string, unknown>> {
  return call<[], Record<string, unknown>>("settings_read");
}

async function saveSetting(key: string, value: unknown): Promise<void> {
  await call<[{ key: string; value: unknown }]>("settings_set", { key, value });
  await call<[]>("settings_commit");
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
      return { ok: false, error: "SteamClient.Apps.AddShortcut not available" };
    }
    const appId = await sc.Apps.AddShortcut(name, exe, startDir, args);
    return { ok: true, appId };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function specifyCompatTool(appId: number, toolName: string): void {
  try {
    const sc = (window as Window & { SteamClient?: SteamClientAPI }).SteamClient;
    sc?.Apps?.SpecifyCompatTool?.(appId, toolName);
  } catch {
    // Non-fatal; compat tool setting is best-effort
  }
}

function restartSteam(): void {
  try {
    const sc = (window as Window & { SteamClient?: SteamClientAPI }).SteamClient;
    sc?.User?.StartRestart?.(false);
  } catch {
    // Ignore; user can restart manually
  }
}

function basename(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? p;
}

// --- Plugin ---

export default definePlugin((_serverAPI) => {
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
    const [usbMounts, setUsbMounts] = useState<string[]>([]);
    const [usbPath, setUsbPath] = useState("");
    const [zipFiles, setZipFiles] = useState<string[]>([]);
    const [settingsBusy, setSettingsBusy] = useState(false);
    const [settingsStatus, setSettingsStatus] = useState("");

    const pollInterval = useRef<ReturnType<typeof setInterval> | null>(null);

    const stopPolling = useCallback(() => {
      if (pollInterval.current !== null) {
        clearInterval(pollInterval.current);
        pollInterval.current = null;
      }
    }, []);

    // Resolves once the backend operation completes, streaming percent updates.
    const waitForProgress = useCallback(
      (onUpdate: (pct: number) => void): Promise<ProgressResult> =>
        new Promise((resolve) => {
          stopPolling();
          pollInterval.current = setInterval(async () => {
            try {
              const p = await getProgress();
              onUpdate(p.percent);
              if (p.done) {
                stopPolling();
                resolve(p);
              }
            } catch (e) {
              stopPolling();
              resolve({
                operation: "",
                percent: 0,
                done: true,
                error: String(e),
                result: null,
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
        let hasSdSetting = false;
        try {
          const s = await loadSettings();
          if (typeof s?.sd_card_path === "string" && s.sd_card_path.length > 0) {
            setDestRoot(s.sd_card_path);
            hasSdSetting = true;
          } else if (
            typeof s?.default_dest_root === "string" &&
            s.default_dest_root.length > 0
          ) {
            setDestRoot(s.default_dest_root);
          }
        } catch {}
        if (!hasSdSetting) {
          try {
            const detected = await detectSdMount();
            if (detected) {
              setDestRoot(detected);
              await saveSetting("sd_card_path", detected);
            }
          } catch {}
        }
        try {
          const mounts = await listUsbMounts();
          setUsbMounts(mounts);
          if (mounts.length > 0) setUsbPath(mounts[0]);
        } catch {
          setUsbMounts([]);
        }
      })();
    }, []);

    // --- Browse-screen handlers ---

    const refreshZipFiles = async () => {
      if (!usbPath.trim()) {
        setSettingsStatus("No USB mount path set.");
        return;
      }
      setSettingsBusy(true);
      setSettingsStatus("Scanning USB for ZIP files…");
      try {
        const files = await listZipFiles(usbPath);
        setZipFiles(files);
        setSettingsStatus(`Found ${files.length} ZIP file(s).`);
      } catch (e) {
        setZipFiles([]);
        setSettingsStatus(`Error: ${String(e)}`);
      } finally {
        setSettingsBusy(false);
      }
    };

    const handleSaveSdPath = async () => {
      if (!destRoot.trim()) {
        setSettingsStatus("SD card path is not set.");
        return;
      }
      setSettingsBusy(true);
      try {
        await saveSetting("sd_card_path", destRoot);
        setSettingsStatus("SD card path saved.");
      } catch (e) {
        setSettingsStatus(`Error: ${String(e)}`);
      } finally {
        setSettingsBusy(false);
      }
    };

    // --- Installation flow ---

    const finishInstall = async (
      gameDir: string,
      launcherPath: string,
      lType: "sh" | "exe"
    ) => {
      const gameName = basename(gameDir);
      const exe = lType === "sh" ? "/bin/bash" : launcherPath;
      const args = lType === "sh" ? `"${launcherPath}"` : "";
      const addResult = await addShortcut(gameName, exe, gameDir, args);
      if (!addResult.ok) {
        throw new Error(`Could not add Steam shortcut: ${String(addResult.error)}`);
      }
      if (lType === "exe" && addResult.appId !== undefined) {
        specifyCompatTool(addResult.appId, "proton_experimental");
      }
      setCompletedGameName(gameName);
      setStep("complete");
    };

    const handleLauncherPick = async (launcherPath: string) => {
      try {
        await ensureExecutable(launcherPath);
        await finishInstall(pendingGameDir, launcherPath, launcherType);
      } catch (e) {
        setErrorMsg(String(e));
        setStep("error");
      }
    };

    const handleZipSelect = async (usbZipPath: string) => {
      if (!destRoot.trim()) {
        setErrorMsg("SD card destination path is not set.");
        setStep("error");
        return;
      }
      setUsbSafeMsg(false);
      try {
        // Step 2: Copy ZIP from USB to SD card
        setStep("copying");
        setProgress(0);
        await startCopy(usbZipPath, destRoot);
        const copyResult = await waitForProgress((pct) => setProgress(pct));
        if (copyResult.error) throw new Error(copyResult.error);
        const destZip = copyResult.result!.dest_zip;

        // Show "USB safe to remove" message and proceed to extraction
        setUsbSafeMsg(true);
        setStep("extracting");
        setProgress(0);
        await startExtract(destZip, destRoot);
        const extractResult = await waitForProgress((pct) => setProgress(pct));
        if (extractResult.error) throw new Error(extractResult.error);
        const gameDir = extractResult.result!.game_dir;

        // Step 5: Find launchers
        const lr = await getLaunchers(gameDir);
        if (!lr.launchers.length || !lr.type) {
          throw new Error("No .sh or .exe launcher found in the game folder.");
        }
        if (lr.launchers.length === 1) {
          await ensureExecutable(lr.launchers[0]);
          await finishInstall(gameDir, lr.launchers[0], lr.type);
        } else {
          // Multiple launchers — let the user choose
          setPendingGameDir(gameDir);
          setLaunchers(lr.launchers);
          setLauncherType(lr.type);
          setStep("launcher_pick");
        }
      } catch (e) {
        setErrorMsg(String(e));
        setStep("error");
      }
    };

    const handleInstallAnother = () => {
      setStep("browse");
      setProgress(0);
      setUsbSafeMsg(false);
      setLaunchers([]);
      setErrorMsg("");
      setCompletedGameName("");
    };

    const handleFinish = () => {
      // Restart Steam so the new shortcut appears in the library, then close the panel.
      restartSteam();
      try {
        Navigation.NavigateBack();
      } catch {
        // NavigateBack may not always succeed; fail silently
      }
    };

    // ---- RENDER ----

    if (step === "copying" || step === "extracting") {
      return (
        <PanelSection title="Ren'Py ZIP Installer">
          {usbSafeMsg && (
            <PanelSectionRow>
              <div style={{ fontSize: 12, color: "#8dba6a" }}>
                USB drive can be safely removed unless you have more games to install.
              </div>
            </PanelSectionRow>
          )}
          <PanelSectionRow>
            <ProgressBarWithInfo
              nProgress={progress}
              sOperationText={
                step === "copying" ? "Copying to SD card…" : "Extracting…"
              }
            />
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

    if (step === "complete") {
      return (
        <PanelSection title="Ren'Py ZIP Installer">
          <PanelSectionRow>
            <div style={{ fontSize: 12, color: "#8dba6a" }}>
              "{completedGameName}" added to Steam. Click Finish to restart Steam
              so it appears in your library.
            </div>
          </PanelSectionRow>
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
        <PanelSection title="Ren'Py ZIP Installer">
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

    // Browse step
    return (
      <PanelSection title="Ren'Py ZIP Installer">
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
            onClick={refreshZipFiles}
            disabled={settingsBusy || !usbPath.trim()}
          >
            Refresh ZIP list from USB
          </ButtonItem>
        </PanelSectionRow>

        <PanelSectionRow>
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            {zipFiles.length ? "Select a ZIP to install:" : "No ZIPs loaded."}
          </div>
        </PanelSectionRow>

        {zipFiles.map((p) => (
          <PanelSectionRow key={p}>
            <ButtonItem layout="below" onClick={() => handleZipSelect(p)}>
              {basename(p)}
            </ButtonItem>
          </PanelSectionRow>
        ))}

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
            onClick={handleSaveSdPath}
            disabled={settingsBusy || !destRoot.trim()}
          >
            Save SD card path
          </ButtonItem>
        </PanelSectionRow>

        {settingsStatus ? (
          <PanelSectionRow>
            <div style={{ fontSize: 12, opacity: 0.8 }}>{settingsStatus}</div>
          </PanelSectionRow>
        ) : null}
      </PanelSection>
    );
  };

  return {
    title: <div className="Title">Ren'Py Installer</div>,
    content: <Content />,
    icon: <FaDownload />,
  };
});
