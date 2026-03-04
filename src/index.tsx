import { definePlugin } from "decky-frontend-lib";
import { PanelSection, PanelSectionRow, ButtonItem, TextField, ToggleField, showModal, ConfirmModal, Spinner } from "@decky/ui";
import React, { useEffect, useMemo, useState } from "react";
import { FaDownload } from "react-icons/fa";
import { call } from "@decky/api";

type InstallRequest = {
  zip_path: string;
  dest_root: string;
  dest_folder_name?: string;
  overwrite: boolean;
};

type InstallResult = {
  install_dir: string;
  launcher_sh: string;
  suggested_name: string;
};

async function installFromZip(req: InstallRequest): Promise<InstallResult> {
  return await call<InstallResult>("install_from_zip", req);
}

async function listUsbMounts(): Promise<string[]> {
  return await call<string[]>("list_usb_mounts", {});
}

async function detectSdMount(): Promise<string | null> {
  return await call<string | null>("detect_sd_mount", {});
}

async function listZipFiles(mount_path: string): Promise<string[]> {
  return await call<string[]>("list_zip_files", { mount_path });
}

async function copyZipToSd(zip_path: string, dest_root: string): Promise<{ dest_zip: string }> {
  return await call<{ dest_zip: string }>("copy_zip_to_sd", { zip_path, dest_root });
}

async function loadSettings(): Promise<Record<string, any>> {
  return await call<Record<string, any>>("settings_read", {});
}

async function saveSetting(key: string, value: any): Promise<void> {
  await call("settings_set", { key, value });
  await call("settings_commit", {});
}

function tryAddShortcut(name: string, exe: string, startDir: string, args: string): { ok: boolean; appId?: number; error?: any } {
  try {
    const sc: any = (window as any).SteamClient;
    if (!sc?.Apps?.AddShortcut) {
      return { ok: false, error: "SteamClient.Apps.AddShortcut not available." };
    }
    const appId = sc.Apps.AddShortcut(name, exe, startDir, args);
    return { ok: true, appId };
  } catch (e) {
    return { ok: false, error: e };
  }
}

export default definePlugin((_serverAPI) => {
  const Content: React.FC = () => {
    const [zipPath, setZipPath] = useState<string>("");
    const [destRoot, setDestRoot] = useState<string>("/run/media/mmcblk0p1/Games");
    const [overwrite, setOverwrite] = useState<boolean>(false);
    const [busy, setBusy] = useState<boolean>(false);
    const [usbMounts, setUsbMounts] = useState<string[]>([]);
    const [usbPath, setUsbPath] = useState<string>("");
    const [zipFiles, setZipFiles] = useState<string[]>([]);
    const [status, setStatus] = useState<string>("");

    useEffect(() => {
      (async () => {
        let hasSdSetting = false;
        try {
          const s = await loadSettings();
          if (typeof s?.sd_card_path === "string" && s.sd_card_path.length > 0) {
            setDestRoot(s.sd_card_path);
            hasSdSetting = true;
          } else if (typeof s?.default_dest_root === "string" && s.default_dest_root.length > 0) {
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
          if (mounts.length > 0) {
            setUsbPath(mounts[0]);
          }
        } catch {
          setUsbMounts([]);
        }
      })();
    }, []);

    const refreshZipFiles = async () => {
      if (!usbPath.trim()) {
        setStatus("No USB mount path set.");
        return;
      }
      setBusy(true);
      setStatus("Scanning USB for ZIP files…");
      try {
        const files = await listZipFiles(usbPath);
        setZipFiles(files);
        setStatus(`Found ${files.length} ZIP file(s).`);
      } catch (e) {
        setZipFiles([]);
        setStatus(`Error: ${String(e)}`);
      } finally {
        setBusy(false);
      }
    };

    const chooseZip = async (path: string) => {
      if (!path) return;
      if (!destRoot.trim()) {
        setStatus("SD card path is not set.");
        return;
      }
      setBusy(true);
      setStatus("Copying ZIP to SD card…");
      try {
        const res = await copyZipToSd(path, destRoot);
        setZipPath(res.dest_zip);
        setStatus(`Copied to SD card: ${res.dest_zip}`);
      } catch (e) {
        setStatus(`Error: ${String(e)}`);
      } finally {
        setBusy(false);
      }
    };

    const canInstall = useMemo(() => zipPath.trim().length > 0 && destRoot.trim().length > 0 && !busy, [zipPath, destRoot, busy]);
    const installEnabled = false;

    const saveSdPath = async () => {
      if (!destRoot.trim()) {
        setStatus("SD card path is not set.");
        return;
      }
      setBusy(true);
      try {
        await saveSetting("sd_card_path", destRoot);
        setStatus("SD card path saved.");
      } catch (e) {
        setStatus(`Error: ${String(e)}`);
      } finally {
        setBusy(false);
      }
    };

    const runInstall = async () => {
      if (!installEnabled) {
        setStatus("Install/extract is disabled for now.");
        return;
      }

      const proceed = await new Promise<boolean>((resolve) => {
        showModal(
          <ConfirmModal
            strTitle="Install Ren'Py game?"
            strDescription={`ZIP: ${zipPath}\nDestination: ${destRoot}\nOverwrite: ${overwrite ? "Yes" : "No"}`}
            strOKButtonText="Install"
            strCancelButtonText="Cancel"
            onOK={() => resolve(true)}
            onCancel={() => resolve(false)}
          />
        );
      });

      if (!proceed) return;

      setBusy(true);
      setStatus("Copying and extracting…");
      try {
        await saveSetting("sd_card_path", destRoot);

        const result = await installFromZip({ zip_path: zipPath, dest_root: destRoot, overwrite });

        setStatus("Adding shortcut to Steam…");
        const exe = "/bin/bash";
        const args = `"${result.launcher_sh}"`;
        const add = tryAddShortcut(result.suggested_name, exe, result.install_dir, args);

        if (!add.ok) {
          setStatus(`Installed, but could not add shortcut: ${String(add.error)}`);
          return;
        }

        setStatus("Done. You can now safely remove the USB drive.");
      } catch (e) {
        setStatus(`Error: ${String(e)}`);
      } finally {
        setBusy(false);
      }
    };

    return (
      <PanelSection title="Ren'Py ZIP Installer">
        <PanelSectionRow>
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            USB mounts detected: {usbMounts.length ? usbMounts.join(", ") : "None detected (or permission denied)."}
          </div>
        </PanelSectionRow>

        <PanelSectionRow>
          <TextField label="USB mount path" description="Detected USB drive path." value={usbPath} onChange={(e) => setUsbPath(e.target.value)} disabled={busy} />
        </PanelSectionRow>

        <PanelSectionRow>
          <ButtonItem layout="below" onClick={refreshZipFiles} disabled={busy || !usbPath.trim()}>
            Refresh ZIP list from USB
          </ButtonItem>
        </PanelSectionRow>

        <PanelSectionRow>
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            ZIP files (newest first): {zipFiles.length ? "Select one to copy." : "None loaded."}
          </div>
        </PanelSectionRow>

        {zipFiles.map((path) => (
          <PanelSectionRow key={path}>
            <ButtonItem layout="below" onClick={() => chooseZip(path)} disabled={busy}>
              {path}
            </ButtonItem>
          </PanelSectionRow>
        ))}

        <PanelSectionRow>
          <div style={{ fontSize: 12, opacity: 0.8 }}>Selected ZIP (copied to SD): {zipPath || "None"}</div>
        </PanelSectionRow>

        <PanelSectionRow>
          <TextField
            label="SD card path"
            description="Editable path stored in plugin settings."
            value={destRoot}
            onChange={(e) => setDestRoot(e.target.value)}
            disabled={busy}
          />
        </PanelSectionRow>

        <PanelSectionRow>
          <ButtonItem layout="below" onClick={saveSdPath} disabled={busy || !destRoot.trim()}>
            Save SD card path
          </ButtonItem>
        </PanelSectionRow>

        <PanelSectionRow>
          <ToggleField label="Overwrite if destination exists" checked={overwrite} onChange={(v) => setOverwrite(v)} disabled={busy} />
        </PanelSectionRow>

        <PanelSectionRow>
          <ButtonItem layout="below" onClick={runInstall} disabled={!canInstall || !installEnabled}>
            {busy ? <Spinner /> : <FaDownload />} Install (coming soon)
          </ButtonItem>
        </PanelSectionRow>

        <PanelSectionRow>
          <div style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{status}</div>
        </PanelSectionRow>
      </PanelSection>
    );
  };

  return {
    title: <div className="Title">Ren'Py Installer</div>,
    content: <Content />,
    icon: <FaDownload />,
  };
});
