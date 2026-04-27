You are assisting with a Decky Loader plugin (Steam Deck, Gaming Mode) named "Ren'Py Installer".

Goal:
Provide a UI flow to install a game ZIP from a USB drive to the SD card and register it as a Steam non-Steam shortcut.

Action flow (in order):

1. **Select ZIP** — User picks a ZIP file from the USB drive via the plugin UI.

2. **Copy to SD card** — Backend copies the ZIP to the SD card root set in plugin options.
   Show a progress bar during copy.
   On completion, show a message: "USB drive can be safely removed unless you have more
   games to install." No buttons yet; installation continues automatically.

3. **Inspect ZIP structure** — Examine the ZIP on the SD card to determine if all contents
   live under a single top-level subfolder.

   **Case A — ZIP has a single top-level subfolder:**
   - Check whether that subfolder name already exists at the destination root.
   - If it does → surface an error (do not crash Decky) and stop.
   - If it does not → extract the ZIP into the destination root (subfolder is created
     by extraction), then cd into that new subfolder.

   **Case B — ZIP contents are flat (no single top-level subfolder):**
   - Derive the target folder name as the ZIP filename minus the `.zip` extension.
   - Check whether a folder with that name already exists at the destination root.
   - If it does → surface an error (do not crash Decky) and stop.
   - If it does not → create the folder, then extract the ZIP into the destination root
     so contents land inside the new folder (extract with dest = destination root,
     folder already present), then cd into that folder.

   Show a progress bar during extraction.

4. **Delete ZIP** — After successful extraction in either case, delete the ZIP file from
   the SD card.

5. **Find launcher** — Inside the new game folder:
   - Look for files ending in `.sh`.
     - If exactly one is found, ensure it is executable and use it.
     - If more than one is found, present the user with a selection list and use whichever
       they pick (make it executable). This is an edge case and not expected in practice.
   - If no `.sh` found, look for files ending in `.exe`; apply the same single/multiple logic.
   - If neither extension yields any files → surface an error (do not crash Decky) and stop.

6. **Add to Steam** — Add the found launcher as a non-Steam shortcut using
   `SteamClient.Apps.AddShortcut` (preferred).
   - For `.exe` launchers, also set the Steam compatibility tool to **Proton Experimental**
     (a future plugin setting may allow choosing a different default Proton version).
   - Do NOT edit `shortcuts.vdf` directly while Steam is running.

7. **Restart Steam if necessary** — Restart Steam so the new non-Steam game appears in the
   library. Only restart if required to make the shortcut visible.

8. **Completion UI** — Once the game has been successfully added to Steam, show two buttons:
   - **"Install another game"** — resets the UI back to the ZIP selection step.
   - **"Finish"** — closes the Decky panel.

Constraints:
- Must work in Gaming Mode.
- Avoid editing shortcuts.vdf directly while Steam is running.
- Keep permissions minimal; do not require root unless absolutely necessary.
- Do NOT write to any binary files without explicit user permission.
- The USB device is **read-only** from the plugin's perspective — never write, delete, or modify anything on it.

Repo layout:
- src/index.tsx: UI + calls backend via @decky/api call()
- main.py: backend methods exposed to frontend
- plugin.json/package.json: metadata
- dist/index.js: build output (generated, not committed)
- eslint.config.mjs: ESLint 9 flat config (typescript-eslint v8)

Code quality rules:
- All ESLint warnings are treated as errors (@typescript-eslint/no-explicit-any: error)
- No `any` types — use `unknown`, specific interfaces, or typed generics
- `react-icons` is in devDependencies and is bundled into the output (NOT external)
- Only `react`, `react-dom`, and `@decky/ui` are external; they are replaced with Decky's runtime globals (`SP_REACT`, `SP_JSX`/`SP_REACTDOM`, `DFL`) via `rollup-plugin-external-globals`
- `@decky/api` and `react-icons` are bundled (not external); `decky-frontend-lib` has been removed
- Deprecation warnings must be resolved; if a dep is deprecated, upgrade it or add a pnpm override

Current backend methods:
- mount_usb_devices() — auto-mounts unmounted /dev/sd* partitions via udisksctl; returns list of newly-mounted paths
- list_usb_mounts()
- detect_sd_mount()
- list_zip_files(mount_path)
- start_copy(zip_path, dest_root) — starts async chunked copy; returns immediately
- start_extract(zip_path, dest_root) — starts async extraction with Case A/B logic; deletes ZIP on success; returns immediately
- get_progress() — polls current op: {operation, percent, done, error, result}
- get_launchers(game_dir) — returns {launchers: [...paths], type: "sh"|"exe"|null}
- ensure_executable(launcher_path) — chmod +x
- list_save_folders(save_root) — returns immediate subfolders under the configured save root
- can_link_saves(game_dir) — returns whether `<game_dir>/game/saves` can be created safely
- create_save_folder(save_root, folder_name) — creates an immediate child folder under the configured save root
- create_save_symlink(game_dir, save_folder) — creates `<game_dir>/game/saves` symlink if absent
- get_log_level() — returns current log level string ("debug"|"info"|"warn"|"error")
- set_log_level(level) — sets log level in settings, applies immediately, returns bool
- settings_read/settings_set/settings_commit

Frontend uses SteamClient directly (no backend wrapper needed) for:
- SteamClient.Apps.AddShortcut(name, exe, startDir, args) → Promise<appId>
- SteamClient.Apps.SpecifyCompatTool(appId, "proton_experimental") — set Proton for .exe
- SteamClient.User.StartRestart(false) — restart Steam on Finish (no NavigateBack; panel closes with Steam restart)

Frontend also uses `openFilePicker(FileSelectionType.FOLDER, ...)` from `@decky/api` for:
- "Browse for USB folder…" button — lets user override auto-detected USB mount path
- "Browse for SD card folder…" button — lets user override auto-detected SD card path

## Change workflow (required on every change)

On every change, without exception unless explicitly instructed otherwise:

1. Run lint: `pnpm run lint` — fix all errors before continuing. Warnings are treated as errors; the lint script must exit clean with zero output.
2. Run build: `pnpm run build` — must succeed with no errors before continuing.
3. Run tests: `pnpm test` — runs Vitest frontend tests and pytest backend tests.
4. Bump the **patch** version only in both `package.json` and `plugin.json`
   (e.g. 0.0.1 → 0.0.2). Never bump major/minor unless the user asks.
5. Update `CHANGELOG.md` with a new `## [version] - YYYY-MM-DD` section
   describing what changed.
6. Update this file (`AGENTS.md`) if there are critical context changes
   (new backend methods, major architectural shifts, new constraints).
7. Commit all changes: `git add -A && git commit -m "..."`
8. Push to master: `git push origin master`
9. Create and push a version tag: `git tag v<version> && git push origin v<version>`

Pushing the tag triggers the GitHub Actions release workflow, which builds
the plugin zip and creates a draft GitHub release automatically.

## GitHub Actions

`.github/workflows/release.yml` — triggers on `v*.*.*` tag push:
- Installs deps, runs lint, builds the plugin
- Packages `plugin.json main.py dist/index.js package.json` into `decky-renpy-installer.zip`
- Creates a new draft release with the zip attached
- Preserves previous releases and tags; do not delete old drafts automatically
- Changelog in the release covers commits since the last **published** (non-draft) release
