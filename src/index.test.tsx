import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CallHandler = (...args: unknown[]) => unknown;

const { callRoutes, callMock, openFilePickerMock } = vi.hoisted(() => {
  const routes = new Map<string, CallHandler>();
  const mockedCall = vi.fn((route: string, ...args: unknown[]) => {
    const handler = routes.get(route);
    if (!handler) {
      throw new Error(`Unmocked call route in test: ${route}`);
    }
    return Promise.resolve(handler(...args));
  });
  return {
    callRoutes: routes,
    callMock: mockedCall,
    openFilePickerMock: vi.fn(),
  };
});

function mockRoute(route: string, handler: CallHandler): void {
  callRoutes.set(route, handler);
}

vi.mock("@decky/api", () => ({
  call: (route: string, ...args: unknown[]) => callMock(route, ...args),
  openFilePicker: (...args: unknown[]) => openFilePickerMock(...args),
  definePlugin: (fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => fn(...args),
}));

interface MockPanelSectionProps {
  title?: string;
  children?: React.ReactNode;
}

interface MockRowProps {
  children?: React.ReactNode;
}

interface MockButtonItemProps {
  children?: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}

interface MockButtonElement extends HTMLButtonElement {
  testOnClick?: () => void | Promise<void>;
}

interface MockTextFieldProps {
  label?: string;
  value?: string;
  disabled?: boolean;
  onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
}

interface MockProgressProps {
  nProgress?: number;
  sOperationText?: string;
}

interface MockDropdownOption {
  data: string;
  label: string;
}

interface MockDropdownProps {
  label?: string;
  rgOptions?: MockDropdownOption[];
  selectedOption?: string;
  disabled?: boolean;
  onChange?: (option: MockDropdownOption) => void;
}

vi.mock("@decky/ui", () => ({
  PanelSection: ({ title, children }: MockPanelSectionProps) => (
    <div data-testid="panel-section" data-title={title}>{children}</div>
  ),
  PanelSectionRow: ({ children }: MockRowProps) => <div>{children}</div>,
  ButtonItem: ({ children, onClick, disabled }: MockButtonItemProps) => (
    <button
      ref={(element) => {
        if (element) (element as MockButtonElement).testOnClick = onClick;
      }}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  ),
  TextField: ({ label, value, onChange, disabled }: MockTextFieldProps) => (
    <input aria-label={label} value={value} onChange={onChange} disabled={disabled} />
  ),
  ProgressBarWithInfo: ({ nProgress, sOperationText }: MockProgressProps) => (
    <div data-testid="progress">{sOperationText} {nProgress}%</div>
  ),
  DropdownItem: ({
    label,
    rgOptions,
    selectedOption,
    disabled,
    onChange,
  }: MockDropdownProps) => (
    <select
      aria-label={label}
      value={selectedOption}
      disabled={disabled}
      onChange={(event) => {
        const option = (rgOptions ?? []).find((item) => item.data === event.target.value);
        if (option) onChange?.(option);
      }}
    >
      {(rgOptions ?? []).map((option) => (
        <option key={option.data} value={option.data}>{option.label}</option>
      ))}
    </select>
  ),
}));

vi.mock("react-icons/fa", () => ({
  FaDownload: () => <svg data-testid="icon-download" />,
}));

import pluginDefinition, { ErrorBoundary } from "./index";

interface PluginDefinition {
  name: string;
  content: React.ReactElement;
  icon: React.ReactElement;
}

interface SteamClientMock {
  Apps: {
    AddShortcut: ReturnType<typeof vi.fn>;
    SpecifyCompatTool: ReturnType<typeof vi.fn>;
  };
  User: {
    StartRestart: ReturnType<typeof vi.fn>;
  };
}

interface WindowWithSteamClient extends Window {
  SteamClient?: SteamClientMock;
}

interface ProgressResult {
  operation: string;
  percent: number;
  bytes_done: number;
  bytes_total: number;
  done: boolean;
  error: string | null;
  result: Record<string, string> | null;
}

function pluginFactory(): PluginDefinition {
  return (pluginDefinition as unknown as () => PluginDefinition)();
}

function renderPlugin(): ReturnType<typeof render> {
  return render(pluginFactory().content);
}

function callsFor(route: string): unknown[][] {
  return callMock.mock.calls.filter((callArgs) => callArgs[0] === route);
}

function getWindowWithSteamClient(): WindowWithSteamClient {
  return window as unknown as WindowWithSteamClient;
}

async function invokeButtonHandler(button: HTMLElement): Promise<void> {
  const handler = (button as MockButtonElement).testOnClick;
  if (!handler) throw new Error("Mock button has no click handler");
  await act(async () => {
    await handler();
  });
}

async function flushEffects(rounds = 12): Promise<void> {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) {
      await Promise.resolve();
    }
  });
}

async function renderSettled(): Promise<void> {
  renderPlugin();
  await waitFor(() => expect(screen.getByText(/USB mounts:/)).toBeInTheDocument());
  await waitFor(() => expect(screen.getByText(/unmounted USB partitions|Auto-mounted:/)).toBeInTheDocument());
}

function progressResult(
  operation: "copy" | "extract",
  result: Record<string, string> | null,
  overrides: Partial<ProgressResult> = {},
): ProgressResult {
  return {
    operation,
    percent: 100,
    bytes_done: 100,
    bytes_total: 100,
    done: true,
    error: null,
    result,
    ...overrides,
  };
}

function configureInstall(options: {
  launcherPaths?: string[];
  launcherType?: "sh" | "exe" | null;
  conflict?: boolean;
  conflictThrows?: boolean;
} = {}): void {
  const launcherPaths = options.launcherPaths ?? ["/games/Game/run.sh"];
  const launcherType = options.launcherType === undefined ? "sh" : options.launcherType;
  const polls = [
    progressResult("copy", { dest_zip: "/games/Game.zip" }),
    progressResult("extract", { game_dir: "/games/Game" }),
  ];
  mockRoute("check_extract_conflict", () => {
    if (options.conflictThrows) throw new Error("inspection failed");
    return {
      conflict: options.conflict ?? false,
      folder_name: "Game",
      suffix_folder_name: options.conflict ? "Game_2" : null,
    };
  });
  mockRoute("start_copy", () => ({ started: true }));
  mockRoute("start_extract", () => ({ started: true }));
  mockRoute("get_progress", () => {
    const next = polls.shift();
    if (!next) throw new Error("No progress result queued");
    return next;
  });
  mockRoute("get_launchers", () => ({ launchers: launcherPaths, type: launcherType }));
  mockRoute("ensure_executable", () => ({ path: launcherPaths[0] }));
}

async function beginInstall(zipName = "Game.zip"): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: zipName }));
  await flushEffects();
}

async function completeProgress(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  await flushEffects();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  await flushEffects();
}

beforeEach(() => {
  callRoutes.clear();
  callMock.mockClear();
  openFilePickerMock.mockReset();
  mockRoute("settings_read", () => ({}));
  mockRoute("detect_sd_mount", () => null);
  mockRoute("mount_usb_devices", () => []);
  mockRoute("list_usb_mounts", () => []);
  mockRoute("settings_set", () => true);
  mockRoute("settings_commit", () => true);
  mockRoute("set_log_level", () => true);
  getWindowWithSteamClient().SteamClient = {
    Apps: {
      AddShortcut: vi.fn().mockResolvedValue(123),
      SpecifyCompatTool: vi.fn(),
    },
    User: {
      StartRestart: vi.fn(),
    },
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  callRoutes.clear();
  delete getWindowWithSteamClient().SteamClient;
});

describe("plugin definition and initial loading", () => {
  it("returns the Decky plugin definition from the factory", () => {
    const plugin = pluginFactory();

    expect(plugin.name).toBe("Renpy Installer");
    render(plugin.icon);
    expect(screen.getByTestId("icon-download")).toBeInTheDocument();
  });

  it("restores a saved SD path and log level without SD auto-detection", async () => {
    mockRoute("settings_read", () => ({ sd_card_path: "/saved/games", log_level: "debug" }));

    await renderSettled();

    expect(screen.getByLabelText("SD card destination")).toHaveValue("/saved/games");
    expect(screen.getByLabelText("Log level")).toHaveValue("debug");
    expect(callsFor("detect_sd_mount")).toHaveLength(0);
  });

  it("uses default_dest_root when no saved SD path exists", async () => {
    mockRoute("settings_read", () => ({ default_dest_root: "/default/games" }));

    await renderSettled();

    expect(screen.getByLabelText("SD card destination")).toHaveValue("/default/games");
  });

  it("detects and persists an SD mount when settings have no destination", async () => {
    mockRoute("detect_sd_mount", () => "/run/media/deck/SD");

    await renderSettled();

    expect(screen.getByLabelText("SD card destination")).toHaveValue("/run/media/deck/SD");
    expect(callsFor("settings_set")).toContainEqual([
      "settings_set",
      "sd_card_path",
      "/run/media/deck/SD",
    ]);
    expect(callsFor("settings_commit")).toHaveLength(1);
  });

  it("keeps the hardcoded destination when SD detection returns null", async () => {
    await renderSettled();

    expect(screen.getByLabelText("SD card destination")).toHaveValue(
      "/run/media/mmcblk0p1/Games",
    );
    expect(callsFor("settings_set")).toHaveLength(0);
  });

  it("reports newly mounted and absent USB partitions", async () => {
    mockRoute("mount_usb_devices", () => ["/run/media/deck/NEW"]);
    await renderSettled();
    expect(screen.getByText("Auto-mounted: /run/media/deck/NEW")).toBeInTheDocument();

    cleanup();
    callMock.mockClear();
    mockRoute("mount_usb_devices", () => []);
    await renderSettled();
    expect(screen.getByText("No unmounted USB partitions found.")).toBeInTheDocument();
  });

  it("selects the first USB mount and scans its ZIP files", async () => {
    mockRoute("list_usb_mounts", () => ["/usb/one", "/usb/two"]);
    mockRoute("list_zip_files", (mount) => {
      expect(mount).toBe("/usb/one");
      return ["/usb/one/First.zip", "/usb/one/Second.zip"];
    });

    await renderSettled();
    await screen.findByText("Found 2 ZIP file(s).");

    expect(screen.getByLabelText("USB mount path")).toHaveValue("/usb/one");
    expect(screen.getByRole("button", { name: "First.zip" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Second.zip" })).toBeInTheDocument();
  });

  it("handles an automatic ZIP scan error without crashing", async () => {
    mockRoute("list_usb_mounts", () => ["/usb"]);
    mockRoute("list_zip_files", () => {
      throw new Error("unreadable drive");
    });

    await renderSettled();

    expect(await screen.findByText(/No ZIP files found: Error: unreadable drive/)).toBeInTheDocument();
    expect(screen.getByText("No ZIPs loaded.")).toBeInTheDocument();
  });

  it("shows no mounts and does not scan when none are available", async () => {
    await renderSettled();

    expect(screen.getByText(/USB mounts:.*None detected\./)).toBeInTheDocument();
    expect(callsFor("list_zip_files")).toHaveLength(0);
  });

  it("continues USB and SD discovery after settings_read rejects", async () => {
    mockRoute("settings_read", () => {
      throw new Error("settings damaged");
    });
    mockRoute("detect_sd_mount", () => "/sd");
    mockRoute("mount_usb_devices", () => ["/usb/new"]);
    mockRoute("list_usb_mounts", () => ["/usb/new"]);
    mockRoute("list_zip_files", () => ["/usb/new/Game.zip"]);

    await renderSettled();

    expect(screen.getByLabelText("SD card destination")).toHaveValue("/sd");
    expect(screen.getByRole("button", { name: "Game.zip" })).toBeInTheDocument();
  });
});

describe("browse screen controls", () => {
  it("refreshes USB mounts and updates status", async () => {
    await renderSettled();
    callMock.mockClear();
    mockRoute("mount_usb_devices", () => ["/usb/new"]);
    mockRoute("list_usb_mounts", () => ["/usb/new", "/usb/old"]);

    await userEvent.click(screen.getByRole("button", { name: "Refresh USB mounts" }));

    expect(await screen.findByText("Found 2 USB mount(s).")).toBeInTheDocument();
    expect(screen.getByText("Auto-mounted: /usb/new")).toBeInTheDocument();
    expect(screen.getByLabelText("USB mount path")).toHaveValue("/usb/new");
  });

  it("defensively rejects a ZIP refresh when the path is empty", async () => {
    await renderSettled();
    callMock.mockClear();
    const button = screen.getByRole("button", { name: "Refresh ZIP list from USB" });
    expect(button).toBeDisabled();

    await invokeButtonHandler(button);

    expect(screen.getByText("No USB mount path set.")).toBeInTheDocument();
    expect(callsFor("list_zip_files")).toHaveLength(0);
  });

  it("refreshes ZIPs and resets pagination to page one", async () => {
    mockRoute("list_usb_mounts", () => ["/usb"]);
    mockRoute("list_zip_files", () => Array.from({ length: 15 }, (_, index) => `/usb/Old${index}.zip`));
    await renderSettled();
    await screen.findByText(/page 1\/2/);
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText(/page 2\/2/)).toBeInTheDocument();

    mockRoute("list_zip_files", () => ["/usb/Fresh.zip"]);
    await userEvent.click(screen.getByRole("button", { name: "Refresh ZIP list from USB" }));

    expect(await screen.findByRole("button", { name: "Fresh.zip" })).toBeInTheDocument();
    expect(screen.queryByText(/page 2\/2/)).not.toBeInTheDocument();
  });

  it("validates, saves, and reports failures for the SD path", async () => {
    await renderSettled();
    const destination = screen.getByLabelText("SD card destination");
    await userEvent.clear(destination);
    callMock.mockClear();
    const saveButton = screen.getByRole("button", { name: "Save SD card path" });
    expect(saveButton).toBeDisabled();
    await invokeButtonHandler(saveButton);
    expect(screen.getByText("SD card path is not set.")).toBeInTheDocument();
    expect(callsFor("settings_set")).toHaveLength(0);

    await userEvent.type(destination, "/games");
    await userEvent.click(screen.getByRole("button", { name: "Save SD card path" }));
    expect(await screen.findByText("SD card path saved.")).toBeInTheDocument();
    expect(callsFor("settings_set")).toContainEqual(["settings_set", "sd_card_path", "/games"]);

    mockRoute("settings_set", () => {
      throw new Error("disk full");
    });
    await userEvent.click(screen.getByRole("button", { name: "Save SD card path" }));
    expect(await screen.findByText("Error: Error: disk full")).toBeInTheDocument();
  });

  it("saves a trimmed save root and can clear it", async () => {
    await renderSettled();
    const input = screen.getByLabelText("Save root folder");
    await userEvent.type(input, "  /cloud/saves  ");
    await userEvent.click(screen.getByRole("button", { name: "Save save root path" }));
    expect(await screen.findByText("Save root path saved.")).toBeInTheDocument();
    expect(callsFor("settings_set")).toContainEqual([
      "settings_set",
      "save_root_path",
      "/cloud/saves",
    ]);

    await userEvent.clear(input);
    await userEvent.click(screen.getByRole("button", { name: "Save save root path" }));
    expect(await screen.findByText("Save root path cleared.")).toBeInTheDocument();
    expect(callsFor("settings_set")).toContainEqual(["settings_set", "save_root_path", ""]);
  });

  it("persists and applies a changed log level", async () => {
    await renderSettled();

    await userEvent.selectOptions(screen.getByLabelText("Log level"), "warn");

    await waitFor(() => expect(callsFor("set_log_level")).toContainEqual(["set_log_level", "warn"]));
    expect(callsFor("settings_set")).toContainEqual(["settings_set", "log_level", "warn"]);
    expect(callsFor("settings_commit")).not.toHaveLength(0);
    expect(screen.getByLabelText("Log level")).toHaveValue("warn");
  });

  it("paginates fifteen ZIP files with correct boundaries", async () => {
    const files = Array.from({ length: 15 }, (_, index) => `/usb/Game${index + 1}.zip`);
    mockRoute("list_usb_mounts", () => ["/usb"]);
    mockRoute("list_zip_files", () => files);
    await renderSettled();
    await screen.findByText(/page 1\/2/);

    expect(screen.getByRole("button", { name: "Game1.zip" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Game10.zip" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Game11.zip" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText(/page 2\/2/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Game11.zip" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Game1.zip" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(screen.getByText(/page 1\/2/)).toBeInTheDocument();
  });

  it("uses folder pickers for USB, SD, and save paths and tolerates cancellation", async () => {
    await renderSettled();
    openFilePickerMock
      .mockResolvedValueOnce({ realpath: "/picked/usb" })
      .mockResolvedValueOnce({ realpath: "/picked/sd" })
      .mockResolvedValueOnce({ realpath: "/picked/saves" })
      .mockRejectedValueOnce(new Error("cancelled"));

    await userEvent.click(screen.getByRole("button", { name: "Browse for USB folder…" }));
    expect(screen.getByLabelText("USB mount path")).toHaveValue("/picked/usb");
    await userEvent.click(screen.getByRole("button", { name: "Browse for SD card folder…" }));
    expect(screen.getByLabelText("SD card destination")).toHaveValue("/picked/sd");
    await userEvent.click(screen.getByRole("button", { name: "Browse for save root folder..." }));
    expect(screen.getByLabelText("Save root folder")).toHaveValue("/picked/saves");
    await userEvent.click(screen.getByRole("button", { name: "Browse for USB folder…" }));
    expect(screen.getByLabelText("USB mount path")).toHaveValue("/picked/usb");
  });
});

describe("installer state and conflicts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRoute("settings_read", () => ({ sd_card_path: "/games" }));
    mockRoute("list_usb_mounts", () => ["/usb"]);
    mockRoute("list_zip_files", () => ["/usb/Game.zip"]);
  });

  it("copies, extracts, makes a shell launcher executable, and adds the shortcut", async () => {
    configureInstall();
    renderPlugin();
    await flushEffects();

    await beginInstall();
    expect(screen.getByTestId("progress")).toHaveTextContent("Copying to SD card… 0%");
    await completeProgress();

    expect(screen.getByText(/"Game" added to Steam/)).toBeInTheDocument();
    expect(callsFor("ensure_executable")).toContainEqual([
      "ensure_executable",
      "/games/Game/run.sh",
    ]);
    const steamClient = getWindowWithSteamClient().SteamClient;
    expect(steamClient?.Apps.AddShortcut).toHaveBeenCalledWith(
      "Game",
      "/games/Game/run.sh",
      "/games/Game",
      "",
    );
  });

  it("sets Proton Experimental for an exe launcher", async () => {
    configureInstall({ launcherPaths: ["/games/Game/Game.exe"], launcherType: "exe" });
    renderPlugin();
    await flushEffects();

    await beginInstall();
    await completeProgress();

    const steamClient = getWindowWithSteamClient().SteamClient;
    expect(steamClient?.Apps.SpecifyCompatTool).toHaveBeenCalledWith(123, "proton_experimental");
  });

  it("offers multiple launchers and completes with the selected one", async () => {
    configureInstall({
      launcherPaths: ["/games/Game/first.sh", "/games/Game/second.sh"],
    });
    renderPlugin();
    await flushEffects();

    await beginInstall();
    await completeProgress();
    expect(screen.getByText("Multiple launcher files found. Choose one:")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "second.sh" }));
    await flushEffects();

    expect(callsFor("ensure_executable")).toContainEqual([
      "ensure_executable",
      "/games/Game/second.sh",
    ]);
    expect(screen.getByText(/"Game" added to Steam/)).toBeInTheDocument();
  });

  it("shows an error for a game with no launcher and returns to browse", async () => {
    configureInstall({ launcherPaths: [], launcherType: null });
    renderPlugin();
    await flushEffects();

    await beginInstall();
    await completeProgress();

    expect(screen.getByText(/No \.sh or \.exe launcher found/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Refresh USB mounts" })).toBeInTheDocument();
  });

  it("surfaces an unavailable or failing AddShortcut", async () => {
    configureInstall();
    delete getWindowWithSteamClient().SteamClient;
    renderPlugin();
    await flushEffects();
    await beginInstall();
    await completeProgress();
    expect(screen.getByText(/SteamClient\.Apps\.AddShortcut not available/)).toBeInTheDocument();

    cleanup();
    callMock.mockClear();
    configureInstall();
    getWindowWithSteamClient().SteamClient = {
      Apps: {
        AddShortcut: vi.fn().mockRejectedValue(new Error("Steam failed")),
        SpecifyCompatTool: vi.fn(),
      },
      User: { StartRestart: vi.fn() },
    };
    renderPlugin();
    await flushEffects();
    await beginInstall();
    await completeProgress();
    expect(screen.getByText(/Steam failed/)).toBeInTheDocument();
  });

  it("continues installation when the conflict check throws", async () => {
    configureInstall({ conflictThrows: true });
    renderPlugin();
    await flushEffects();

    await beginInstall();

    expect(callsFor("start_copy")).toContainEqual(["start_copy", "/usb/Game.zip", "/games"]);
    await completeProgress();
    expect(screen.getByText(/"Game" added to Steam/)).toBeInTheDocument();
  });

  it.each([
    ["Overwrite (update files in place)", true, false, false],
    ["Delete and reinstall", false, true, false],
    ['Install as "Game_2"', false, false, true],
  ])("handles conflict choice %s", async (buttonName, overwrite, replace, suffix) => {
    configureInstall({ conflict: true });
    renderPlugin();
    await flushEffects();
    await beginInstall();

    expect(screen.getByText(/"Game" already exists/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: buttonName }));
    await flushEffects();
    await completeProgress();

    expect(callsFor("start_extract")).toContainEqual([
      "start_extract",
      "/games/Game.zip",
      "/games",
      overwrite,
      replace,
      suffix,
    ]);
    expect(screen.getByText(/"Game" added to Steam/)).toBeInTheDocument();
  });

  it("cancels a conflict without copying or extracting", async () => {
    configureInstall({ conflict: true });
    renderPlugin();
    await flushEffects();
    await beginInstall();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: "Game.zip" })).toBeInTheDocument();
    expect(callsFor("start_copy")).toHaveLength(0);
    expect(callsFor("start_extract")).toHaveLength(0);
  });
});

describe("save linking and completion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRoute("settings_read", () => ({ sd_card_path: "/games", save_root_path: "/saves" }));
    mockRoute("list_usb_mounts", () => ["/usb"]);
    mockRoute("list_zip_files", () => ["/usb/Game.zip"]);
    configureInstall();
  });

  async function installToSaveLink(): Promise<void> {
    renderPlugin();
    await flushEffects();
    await beginInstall();
    await completeProgress();
  }

  it("links an existing save folder and reports success", async () => {
    mockRoute("can_link_saves", () => ({ available: true, reason: "" }));
    mockRoute("list_save_folders", () => ["/saves/Alpha", "/saves/Beta"]);
    mockRoute("create_save_symlink", () => ({ created: true, skipped: false }));

    await installToSaveLink();
    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    await flushEffects();

    expect(callsFor("create_save_symlink")).toContainEqual([
      "create_save_symlink",
      "/games/Game",
      "/saves/Beta",
    ]);
    expect(screen.getByText("Linked saves to Beta.")).toBeInTheDocument();
  });

  it("shows a skipped symlink reason and still completes", async () => {
    mockRoute("can_link_saves", () => ({ available: true, reason: "" }));
    mockRoute("list_save_folders", () => ["/saves/Alpha"]);
    mockRoute("create_save_symlink", () => ({
      created: false,
      skipped: true,
      reason: "game/saves already exists.",
    }));

    await installToSaveLink();
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    await flushEffects();

    expect(screen.getByText("game/saves already exists.")).toBeInTheDocument();
    expect(screen.getByText(/"Game" added to Steam/)).toBeInTheDocument();
  });

  it("creates and links a new save folder", async () => {
    mockRoute("can_link_saves", () => ({ available: true, reason: "" }));
    mockRoute("list_save_folders", () => []);
    mockRoute("create_save_folder", (root, name) => {
      expect([root, name]).toEqual(["/saves", "New Game"]);
      return "/saves/New Game";
    });
    mockRoute("create_save_symlink", () => ({ created: true, skipped: false }));

    await installToSaveLink();
    const createButton = screen.getByRole("button", { name: "Create and link save folder" });
    expect(createButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText("New save folder"), { target: { value: "   " } });
    expect(createButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText("New save folder"), { target: { value: " New Game " } });
    expect(createButton).toBeEnabled();
    fireEvent.click(createButton);
    await flushEffects();

    expect(callsFor("create_save_folder")).toContainEqual([
      "create_save_folder",
      "/saves",
      "New Game",
    ]);
    expect(callsFor("create_save_symlink")).toContainEqual([
      "create_save_symlink",
      "/games/Game",
      "/saves/New Game",
    ]);
    expect(screen.getByText("Linked saves to New Game.")).toBeInTheDocument();
  });

  it("skips save linking by choice", async () => {
    mockRoute("can_link_saves", () => ({ available: true, reason: "" }));
    mockRoute("list_save_folders", () => ["/saves/Alpha"]);

    await installToSaveLink();
    fireEvent.click(screen.getByRole("button", { name: "Skip save link" }));

    expect(screen.getByText("Save linking skipped.")).toBeInTheDocument();
    expect(screen.getByText(/"Game" added to Steam/)).toBeInTheDocument();
  });

  it("skips unavailable save linking without listing folders", async () => {
    mockRoute("can_link_saves", () => ({ available: false, reason: "No game folder found." }));

    await installToSaveLink();

    expect(screen.getByText("No game folder found.")).toBeInTheDocument();
    expect(callsFor("list_save_folders")).toHaveLength(0);
  });

  it("treats save-link availability errors as non-fatal", async () => {
    mockRoute("can_link_saves", () => {
      throw new Error("save service unavailable");
    });

    await installToSaveLink();

    expect(screen.getByText("Error: save service unavailable")).toBeInTheDocument();
    expect(screen.getByText(/"Game" added to Steam/)).toBeInTheDocument();
  });

  it("resets for another install and restarts Steam on Finish", async () => {
    mockRoute("can_link_saves", () => ({ available: false, reason: "No game folder found." }));

    await installToSaveLink();
    fireEvent.click(screen.getByRole("button", { name: "Install another game" }));
    expect(screen.getByRole("button", { name: "Game.zip" })).toBeInTheDocument();
    expect(screen.queryByText(/added to Steam/)).not.toBeInTheDocument();

    configureInstall();
    mockRoute("can_link_saves", () => ({ available: false, reason: "No game folder found." }));
    await beginInstall();
    await completeProgress();
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(getWindowWithSteamClient().SteamClient?.User.StartRestart).toHaveBeenCalledWith(false);
  });
});

describe("error boundary", () => {
  it("renders a plugin error instead of crashing the panel", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    function ThrowingChild(): React.ReactElement {
      throw new Error("render exploded");
    }

    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    );

    expect(screen.getByText(/Plugin render error:/)).toHaveTextContent("render exploded");
  });
});
