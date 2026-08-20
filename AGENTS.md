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
   - If it does → offer overwrite, delete-and-reinstall, install alongside with
     the next available numbered suffix (`_2`, `_3`, etc.), or cancel.
   - If it does not → extract the ZIP into the destination root (subfolder is created
     by extraction), then cd into that new subfolder.

   **Case B — ZIP contents are flat (no single top-level subfolder):**
   - Derive the target folder name as the ZIP filename minus the `.zip` extension.
   - Check whether a folder with that name already exists at the destination root.
   - If it does → offer the same conflict choices as Case A.
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
- check_extract_conflict(zip_path, dest_root) — reports the target folder conflict and next available suffixed name
- start_extract(zip_path, dest_root, overwrite=False, replace=False, suffix=False) — starts async extraction with Case A/B and conflict-resolution logic; deletes ZIP on success; returns immediately
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
4. Add what changed to the `## [Unreleased]` section of `CHANGELOG.md`.
   Do **not** invent a version heading — CI assigns the version number at merge
   time, so it is not knowable while the branch is open.
5. Update this file (`AGENTS.md`) if there are critical context changes
   (new backend methods, major architectural shifts, new constraints).
6. Commit all changes on a feature branch: `git checkout -b <type>/<short-desc>`,
   then `git add -A && git commit -m "..."`
7. Push the branch and open a PR: `git push -u origin <branch>` then `gh pr create`
8. Merge with `gh pr merge --squash`, then `git checkout master && git pull`

**Never push directly to master, and never create or push a version tag by
hand.** CI owns both. Pushing a tag manually races the `create-tag` job and
makes it fail on a duplicate ref.

### Versioning

The `version` field in `package.json` and `plugin.json` is a permanent `0.0.0`
placeholder — **do not bump it**. The real version comes from the release tag
and is written into both files by `scripts/write_version.mjs` during the release
job, immediately before the zip is built (Decky reads the version out of
`plugin.json`, so the shipped zip must carry it).

A consequence: a local `./deploy.sh` build reports version `0.0.0` in Decky.
That is expected and correctly identifies it as a dev build.

## GitHub Actions

`.github/workflows/ci.yml` — pull requests only: audit, lint, test, build.

`.github/workflows/release.yml` — pushes to `master`, `v*.*.*` tag pushes, and
`workflow_dispatch`. Every merge to master (including auto-merged Dependabot
PRs) publishes a new draft release. Jobs:

- `resolve` — runs `scripts/release_info.py` to decide `is_release`,
  `create_tag`, and `tag_name`. On a master push the tag is the next patch after
  the newest `vX.Y.Z` tag. If HEAD is already tagged it resolves to
  `is_release=false`, so a run can't double-release the same commit.
- `lint-and-test` — audit, lint, test, build. Gates everything below it.
- `create-tag` — creates the tag via `gh api .../git/refs` using the default
  `github.token`.
- `release` — checks out the tag, stamps the version, builds, zips
  `plugin.json main.py dist/index.js package.json`, and creates a **draft**
  release with `gh release create --generate-notes`.

Release notes are generated by GitHub from merged PR titles. The old
`git log`-derived changelog was removed: it keyed off the last *published*
release, and since every release here is a draft, it always regenerated the
entire history.

Tag creation uses `github.token` rather than a PAT, which is safe because the
tag and the release are produced in the **same run** — nothing depends on the
tag push firing a second workflow. (Refs created with `GITHUB_TOKEN` do not
trigger workflows; that is also what prevents an infinite release loop.)

Dependabot auto-merge (`.github/workflows/dependabot-auto-merge.yml`) does need
a real PAT in the `DEPENDABOT_MERGE_TOKEN` **Dependabot** secret (not an Actions
secret — `pull_request` runs on Dependabot branches receive Dependabot secrets).
A merge performed by `GITHUB_TOKEN` would not trigger `release.yml` at all.
