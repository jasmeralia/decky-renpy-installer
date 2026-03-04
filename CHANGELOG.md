# Changelog

All notable changes to this project will be documented in this file.

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
