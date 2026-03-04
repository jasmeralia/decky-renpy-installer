# Changelog

All notable changes to this project will be documented in this file.

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
