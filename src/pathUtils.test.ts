import { describe, expect, it, vi } from "vitest";
import { basename, formatEta, formatSpeed } from "./pathUtils";

describe("pathUtils", () => {
  it("returns the final component for POSIX and Windows paths", () => {
    expect(basename("/run/media/deck/USB/Game.zip")).toBe("Game.zip");
    expect(basename("C:\\Games\\Game.zip")).toBe("Game.zip");
  });

  it("formats ETA while progress is unknown or early", () => {
    expect(formatEta(0, 1_000, 5_000)).toBe("Calculating...");
    expect(formatEta(50, 1_000, 2_000)).toBe("Calculating...");
  });

  it("formats ETA after enough progress has elapsed", () => {
    expect(formatEta(50, 0, 10_000)).toBe("~10s remaining");
    expect(formatEta(99, 0, 10_000)).toBe("< 5s remaining");
  });

  it("uses Date.now by default", () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    expect(formatEta(50, 0)).toBe("~10s remaining");
    vi.restoreAllMocks();
  });

  it("formats transfer speed", () => {
    expect(formatSpeed(0)).toBe("");
    expect(formatSpeed(512 * 1024)).toBe("512 KB/s");
    expect(formatSpeed(2.5 * 1024 * 1024)).toBe("2.5 MB/s");
  });
});
