# Ren'Py Installer (Decky plugin scaffold)

Starter scaffold for a Decky Loader plugin that:
- copies a ZIP from USB to a destination root (SD/internal),
- extracts it,
- deletes the copied ZIP,
- finds the Ren'Py launcher `.sh`,
- adds a Steam Non-Steam shortcut (frontend uses `SteamClient.Apps.AddShortcut` when available).

Eject is intentionally **not** implemented in this scaffold.

## Dev prerequisites
- Node.js 16.14+ (or newer)
- `pnpm` (v9 is commonly used with Decky templates)

## Commands
```bash
pnpm i
pnpm run build
```

Output: `dist/index.js` (Decky expects this path)

## Files
- `src/index.tsx` — UI + backend calls + shortcut creation
- `main.py` — backend methods (copy/extract/delete + settings)
- `plugin.json` — Decky metadata
