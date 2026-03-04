You are assisting with a Decky Loader plugin (Steam Deck, Gaming Mode) named "Ren'Py Installer".

Goal:
- User plugs in USB stick containing a Ren'Py game ZIP.
- Plugin UI lets user input/select ZIP path and destination root (default setting).
- Backend copies ZIP to destination, extracts, deletes copied ZIP.
- Backend finds the single Ren'Py launcher .sh (error if none or >1) and ensures executable.
- Frontend adds a Steam Non-Steam shortcut using SteamClient APIs (prefer SteamClient.Apps.AddShortcut).
- We do NOT implement eject initially; we instead show 'safe to remove' message.

Constraints:
- Must work in Gaming Mode.
- Avoid editing shortcuts.vdf directly while Steam is running.
- Keep permissions minimal; do not require root unless absolutely necessary.

Repo layout:
- src/index.tsx: UI + calls backend via @decky/api call()
- main.py: backend methods exposed to frontend
- plugin.json/package.json: metadata
- dist/index.js: build output (generated, not committed)

Current backend methods:
- list_usb_mounts()
- detect_sd_mount()
- list_zip_files(mount_path)
- copy_zip_to_sd(zip_path, dest_root)
- settings_read/settings_set/settings_commit
- install_from_zip(zip_path, dest_root, overwrite, dest_folder_name?)

## Change workflow (required on every change)

On every change, without exception unless explicitly instructed otherwise:

1. Run lint: `npm run lint` — fix all errors before continuing.
2. Run tests if any are configured (check package.json scripts).
3. Bump the **patch** version only in both `package.json` and `plugin.json`
   (e.g. 0.0.1 → 0.0.2). Never bump major/minor unless the user asks.
4. Update `CHANGELOG.md` with a new `## [version] - YYYY-MM-DD` section
   describing what changed.
5. Update this file (`AGENTS.md`) if there are critical context changes
   (new backend methods, major architectural shifts, new constraints).
6. Commit all changes: `git add -A && git commit -m "..."`
7. Push to master: `git push origin master`
8. Create and push a version tag: `git tag v<version> && git push origin v<version>`

Pushing the tag triggers the GitHub Actions release workflow, which builds
the plugin zip and creates a draft GitHub release automatically.

## GitHub Actions

`.github/workflows/release.yml` — triggers on `v*.*.*` tag push:
- Installs deps, runs lint, builds the plugin
- Packages `plugin.json main.py dist/index.js package.json` into `decky-renpy-installer.zip`
- Deletes all previous draft releases (and their tags)
- Creates a new draft release with the zip attached
- Changelog in the release covers commits since the last **published** (non-draft) release
