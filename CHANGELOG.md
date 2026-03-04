# Changelog

All notable changes to this project will be documented in this file.

## [0.0.18] - 2026-03-04

### Fixed
- **Root cause of React error #31 crash**: Decky selects ESMODULE_V1 loading (uses
  `import()` + calls `.default()`) when `package.json` has `"type": "module"`. Our CJS
  bundle's `module.exports = index` is a `ReferenceError` in ESM scope. Fixed by switching
  rollup output format from `"cjs"` to `"es"`, producing a proper `export default` bundle
  that ESMODULE_V1 can load correctly.
- **All backend calls silently failing**: Missing `api_version` in `plugin.json` caused
  Decky's `sandboxed_plugin.py` to default to version 0 and throw
  `"api_version 1 or newer is required to call methods with index-based arguments"` on every
  `@decky/api` `call()`. Added `"api_version": 1` to `plugin.json`.
- **Argument marshalling**: All backend `call()` wrappers were passing a single dict object
  where Python expected positional string arguments (e.g. `call("start_copy", {zip_path, dest_root})`
  instead of `call("start_copy", zip_path, dest_root)`). Fixed all wrappers to pass positional args.
- **Wrong Plugin interface**: Returned `title: JSX.Element` (old `decky-frontend-lib` field,
  silently ignored by Decky) instead of the correct shape. Removed `title`; Decky sets the
  plugin name from `plugin.json` automatically.
- **Mixed SDK generations**: Replaced `decky-frontend-lib` import for `definePlugin` with the
  correct `@decky/api` import, eliminating the bundled webpack module-scan code from DFL.
  `Navigation.NavigateBack()` (which required DFL) removed; Steam restart on Finish is
  sufficient.

## [0.0.15] - 2026-03-04

### Fixed
- `SyntaxError: unexpected token 'export'` — switched rollup output from `esm` to `cjs`;
  with `externalGlobals` already eliminating all `require()` calls for the Decky runtime
  globals, CJS produces `module.exports = ...` with zero `import`/`export`/`require`
  statements, which Decky's eval-based plugin loader can execute cleanly
- `[CRITICAL]: No plugin.json found in plugin ZIP` — Decky's ZIP installer requires plugin
  files to be inside a single top-level directory (`decky-renpy-installer/`) rather than
  at the ZIP root; fixed the packaging step in both `build:zip` and the GHA release workflow

## [0.0.14] - 2026-03-04

### Fixed
- `TypeError: Plugin._init_state() missing 1 required positional argument: 'self'` —
  Decky Loader's plugin proxy can call `_main` with the Plugin class rather than an
  instance, so `self.method()` calls inside `_main` resolve to unbound methods.
  Refactored: moved `_progress`, `_active_task`, and the copy/extract coroutines to
  module level; the Plugin class methods now read/write the module-level globals directly.
  `_init_state` is eliminated entirely.

## [0.0.13] - 2026-03-04

### Fixed
- `SyntaxError: cannot use import outside of a module` (for real this time)
  - `rollup-plugin-external-globals` must be placed *after* all transformer
    plugins (`commonjs`, `esbuild`) per its documentation; placing it first
    meant it never ran, leaving all `import` statements in the output
  - Removed the redundant `external` array — `externalGlobals` handles both
    externalization and import-to-global replacement; having both caused conflicts
  - `@decky/api` internally imports `@decky/manifest` (a Decky virtual module);
    added it to the globals map with the `plugin.json` content inlined as JSON,
    eliminating the last remaining `import` statement

## [0.0.12] - 2026-03-04

### Changed
- Renamed plugin title from "Ren'Py Installer" to "Renpy Installer" to avoid HTML
  apostrophe escaping issues in Decky's plugin list UI

## [0.0.11] - 2026-03-04

### Fixed
- `SyntaxError: cannot use import outside of a module` — Decky's plugin loader evaluates
  the bundle without a native ES module context, so top-level `import` statements are not
  allowed. Added `rollup-plugin-external-globals` to replace imports for `react`,
  `react-dom`, and `@decky/ui` with direct references to Decky's runtime globals
  (`SP_REACT`, `SP_JSX`, `SP_REACTDOM`, `DFL`), eliminating all `import` statements from
  the output. `@decky/api`, `decky-frontend-lib`, and `react-icons` are now bundled.
- Added `react-icons` as a devDependency (previously relied on it as an undeclared
  transitive dep); removed the manual type shim `src/react-icons.d.ts`

## [0.0.10] - 2026-03-04

### Fixed
- `ReferenceError: require is not defined` on plugin load — changed rollup output format from `cjs` to `esm`; Decky's browser environment has no `require`, so CJS externals were broken

## [0.0.9] - 2026-03-04

### Added
- Comprehensive backend logging (debug/info/warn/error) throughout all operations in `main.py`
- Configurable log level setting stored in plugin settings, applied at backend startup; defaults to `error`
- New backend methods: `get_log_level()` and `set_log_level(level)` for runtime log level control
- Log level dropdown in the browse screen UI (DEBUG / INFO / WARN / ERROR); changes apply to both frontend and backend immediately
- Frontend console logging (`console.debug/info/warn/error`) throughout all state transitions, API calls, and Steam client interactions, gated by the same log level

## [0.0.8] - 2026-03-04

### Changed
- Full install flow implemented end-to-end; install button is no longer disabled
- Backend: replaced `copy_zip_to_sd` / `install_from_zip` with async task-based `start_copy` / `start_extract` that stream progress via `get_progress()`; extraction now correctly handles Case A (ZIP with single top-level subfolder) and Case B (flat ZIP, folder created from zip name); ZIP deleted from SD after successful extraction
- Backend: `_find_launcher_sh` replaced by `get_launchers` which returns all `.sh` candidates and falls back to `.exe` if none found; `ensure_executable` handles chmod separately
- Frontend: state-machine UI (browse → copying → extracting → [launcher_pick] → complete / error); progress bars shown during copy and extract via `ProgressBarWithInfo`
- Frontend: "USB safe to remove" message shown after copy completes and persists during extraction
- Frontend: multiple-launcher edge case shows a selection list instead of erroring
- Frontend: `.exe` launchers automatically get Proton Experimental set via `SteamClient.Apps.SpecifyCompatTool`
- Frontend: completion screen shows "Install another game" and "Finish" buttons; Finish restarts Steam and closes the panel
- Frontend: overwrite toggle removed; destination folder collision always surfaces as an error
- Frontend: `call()` type signatures corrected to match `@decky/api` generic convention `<Args, Return>`
- Added `src/react-icons.d.ts` type shim so `typecheck` passes (react-icons is a Decky runtime dep not in package.json)

## [0.0.7] - 2026-03-03

### Fixed
- `deploy.sh`: use `--rsync-path="sudo -n rsync"` for both rsync steps so files deploy as root, avoiding permission failures caused by Decky resetting plugin directory ownership on service restart

## [0.0.6] - 2026-03-03

### Changed
- Migrate ESLint 8 → ESLint 9 flat config (`eslint.config.mjs`); replace `@typescript-eslint/eslint-plugin` + `@typescript-eslint/parser` with `typescript-eslint` v8 + `globals`; removes all deprecated subdependencies (`@humanwhocodes/*`, `glob@7`, `inflight`, `rimraf`)
- Remove stale `minimatch`/`ajv` pnpm overrides (no longer needed with ESLint 9)
- Lint script updated: `eslint . --ext .ts,.tsx` → `eslint .` (ESLint 9 flat config handles file matching)
- Add `react-icons/*` as rollup external (suppresses unresolved-dependency warning; it is a Decky runtime dep)
- Update `AGENTS.md`: deprecation warnings must be resolved; document ESLint 9 flat config and `react-icons` external rule

## [0.0.5] - 2026-03-03

### Fixed
- `deploy.sh`: auto-prepend `deck@` when no `user@` prefix given for host arg; use `sudo -n` for non-interactive systemctl restart; remove the transient `sudo mkdir` step (directory is a one-time manual setup)

## [0.0.4] - 2026-03-03

### Security
- Add `pnpm.overrides` to force patched transitive deps: `minimatch` >= 3.1.4 (GHSA-23c5-xmqv-rm74), `minimatch` >= 9.0.7 (GHSA-3ppc-4f35-3m26), `ajv` >= 6.14.0 (GHSA-2g4f-4pwh-qvx6), `rollup` >= 4.59.0 (GHSA-mw96-cpmx-2vgc)
- Bump direct `rollup` devDependency to `^4.59.0`

## [0.0.3] - 2026-03-03

### Fixed
- `deploy.sh`: restore `pnpm audit` step (using `pnpm` instead of `npm`); default audit level is `low`; `$1` overrides audit level, `$2` overrides deploy target host

## [0.0.2] - 2026-03-03

### Fixed
- `deploy.sh`: switched from `npm` to `pnpm` (project uses pnpm/pnpm-lock.yaml); removed `npm audit` step that was aborting the script due to missing `package-lock.json`; simplified to a single positional arg `[user@host]`; rsync now deploys `plugin.json`, `main.py`, and `dist/` separately so the full plugin is installed
- `src/index.tsx`: replaced all `any` types with proper types (`unknown`, `Record<string, unknown>`, `SteamClientAPI`); added `SteamClientAPI` interface for `window.SteamClient` access
- `.eslintrc.cjs`: upgraded `@typescript-eslint/no-explicit-any` from `warn` to `error` so warnings are caught as build failures

## [0.0.1] - 2026-03-03

### Added
- Initial plugin scaffold for Decky Loader
- Frontend (`src/index.tsx`): USB mount detection, ZIP file listing, SD card path configuration, overwrite toggle, stub install flow with "coming soon" state
- Backend (`main.py`): `list_usb_mounts`, `detect_sd_mount`, `list_zip_files`, `copy_zip_to_sd`, `install_from_zip`, and settings CRUD methods
- ESLint config (`.eslintrc.cjs`) with TypeScript and React rules
- MIT License (Morgan Blackthorne, Winds of Storm)
- README with dev prerequisites and build instructions
- `.gitignore` covering `node_modules/`, `dist/`, `*.zip`, `.vscode`
- GitHub Actions workflow for automated draft release zip on tag push
