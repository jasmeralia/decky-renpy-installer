export function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

export function formatEta(percent: number, startMs: number, nowMs = Date.now()): string {
  if (percent <= 0) return "Calculating...";
  const elapsed = nowMs - startMs;
  if (elapsed < 1500) return "Calculating...";
  const totalEst = elapsed / (percent / 100);
  const remainingMs = Math.max(0, totalEst - elapsed);
  if (remainingMs < 5000) return "< 5s remaining";
  const secs = Math.round(remainingMs / 1000);
  if (secs < 60) return `~${secs}s remaining`;
  const mins = Math.floor(secs / 60);
  const s = secs % 60;
  return s > 0 ? `~${mins}m ${s}s remaining` : `~${mins}m remaining`;
}

export function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return "";
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
}
