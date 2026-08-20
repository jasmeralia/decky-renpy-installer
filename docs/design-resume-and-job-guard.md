# Design: resume-on-remount + single-active-job guard

Origin: Odoo task 241 (investigate navigate-away behavior) and follow-up
discussion with 239 (suffix conflict resolution). This is a locked
implementation spec — no open design questions should be resolved by
guesswork; if something genuinely isn't covered here, stop and ask rather
than improvise.

## Problem recap

1. `_active_task` (the backend copy/extract job) is module-level state,
   independent of any frontend component. It is **not** cancelled by the
   user navigating away — only by plugin `_unload()` or by a *new*
   `start_copy`/`start_extract` call, which currently cancels-and-replaces
   the in-flight job silently.
2. The frontend has no resume logic: if the component remounts, all React
   state resets to the `"browse"` step with no check for an already-running
   job.
3. The copy→extract chain is currently orchestrated in the *frontend*
   (`doInstall` in `src/index.tsx` calls `start_copy`, awaits, then calls
   `start_extract`) — not in the backend. A resumed frontend has no way to
   know it needs to trigger extraction after copy finishes.
4. Cancel-and-replace on retrigger is actively destructive for `replace`
   mode (`shutil.rmtree(game_dir)` at the start of `_extract_sync` can wipe
   a still-running or just-finished sibling job's output) and racy for
   `suffix` mode (two concurrent jobs can compute the same `_2` suffix).

## Decisions (locked)

- Collapse copy+extract into a **single backend-orchestrated job**,
  `start_install(usb_zip_path, dest_root, overwrite, replace, suffix)`,
  replacing `start_copy` and `start_extract` as public RPCs. `_copy_sync`
  and `_extract_sync` are reused unchanged; only the orchestration layer
  (`_do_copy`/`_do_extract`) is replaced by a single `_do_install`.
- Backend refuses a second `start_install` while a job is active — no more
  cancel-and-replace. It returns `{"started": False, "busy": True,
  "job_id": ..., "operation": ...}` instead of starting a new task.
- `_progress` gains two new fields: `job_id` (monotonic int, 0 = no job has
  ever run) and `request` (the original call's args, persisted for the
  lifetime of the job so a resumed frontend can rebuild its UI without
  guessing). Both are additive — every existing field keeps its name and
  meaning.
- Frontend resume covers **only the in-progress case** (`done === false`
  on mount). If a job fully completed while the frontend was gone, do
  **not** auto-continue into launcher-pick/`AddShortcut` — show a passive,
  dismissible banner instead. Rationale: `AddShortcut` and Proton-tool
  changes are user-visible Steam-library side effects; taking them without
  a fresh user gesture is out of scope for this change.
- No attempt to make the backend job actually interruptible (i.e. no
  `threading.Event`-based cooperative cancellation inside the `_copy_sync`/
  `_extract_sync` byte loops). `asyncio.Task.cancel()` still can't stop a
  running OS thread; `_unload()` keeps today's best-effort semantics. This
  is fine because the new busy-guard means nothing will *start* a second
  job while one is running — the only way to get two threads writing
  concurrently was the old cancel-and-replace behavior, which this removes.
- No changes to `check_extract_conflict` or the conflict-resolution UI
  (`"conflict"` step). It already runs before any copy starts and its
  result is already fully resolved into plain booleans before
  `start_install` is called — nothing about it needs to persist or resume.

## Non-goals (explicit — do not implement)

- True mid-copy/mid-extract cancellation.
- Auto-continuing (launcher pick, `AddShortcut`, save-link offer) for a job
  that finished entirely while the frontend was unmounted.
- Persisting anything across a full backend/plugin process restart —
  resume only covers "frontend remounted while the Decky backend process
  kept running."
- Any change to `_copy_sync`, `_extract_sync`, `_extract_member`,
  `_get_zip_top_folder`, or `check_extract_conflict` internals/signatures.

## Backend changes — `main.py`

### `_progress` shape (every key always present)

```python
{
    "job_id": int,                 # 0 = no job has run yet
    "operation": str,              # "" | "copy" | "extract"
    "percent": int,
    "bytes_done": int,
    "bytes_total": int,
    "current_file": str,
    "updated_at": float,
    "done": bool,
    "error": Optional[str],
    "result": Optional[Dict[str, str]],   # {"game_dir": ...} on success
    "request": Optional[Dict[str, Any]],  # set when a job starts, kept through done
}
```

`request` shape when present:
```python
{"usb_zip_path": str, "dest_root": str, "overwrite": bool, "replace": bool, "suffix": bool}
```

Update the module-level `_progress` initializer (currently main.py:31-41) to
include `job_id: 0` and `request: None`.

Add `_job_id_counter: int = 0` at module level and a `_next_job_id()` helper
that increments and returns it.

### `_do_install` (replaces `_do_copy` + `_do_extract`)

```python
async def _do_install(
    usb_zip_path: str, dest_root: str, overwrite: bool, replace: bool, suffix: bool
) -> None:
    global _progress
    try:
        dest_zip = await asyncio.to_thread(_copy_sync, usb_zip_path, dest_root)
        _progress.update({
            "operation": "extract", "percent": 0, "bytes_done": 0,
            "bytes_total": 0, "current_file": "", "updated_at": time.time(),
        })
        game_dir = await asyncio.wait_for(
            asyncio.to_thread(_extract_sync, dest_zip, dest_root, overwrite, replace, suffix),
            timeout=_EXTRACT_TIMEOUT_SECONDS,
        )
        _progress.update({
            "percent": 100, "done": True,
            "result": {"game_dir": game_dir}, "updated_at": time.time(),
        })
    except asyncio.TimeoutError:
        message = f"Extraction timed out after {_EXTRACT_TIMEOUT_SECONDS} seconds"
        logger.exception(message)
        _progress.update({"done": True, "error": message, "updated_at": time.time()})
    except Exception as e:
        logger.exception("Install failed: %s", e)
        _progress.update({"done": True, "error": str(e), "updated_at": time.time()})
```

Note: a copy failure must **not** attempt extraction — the `try` above
already short-circuits correctly since `_copy_sync`'s exception is caught
by the outer `except Exception`.

Remove `_do_copy` and `_do_extract` entirely (no other callers).

### `start_install` (replaces `start_copy` + `start_extract`)

```python
async def start_install(
    self, usb_zip_path: str, dest_root: str,
    overwrite: bool = False, replace: bool = False, suffix: bool = False,
) -> Dict[str, Any]:
    global _progress, _active_task
    if _active_task and not _active_task.done():
        logger.info(
            "start_install: rejected, job %d already active (%s)",
            _progress.get("job_id", 0), _progress.get("operation"),
        )
        return {
            "started": False, "busy": True,
            "job_id": _progress.get("job_id", 0),
            "operation": _progress.get("operation", ""),
        }
    job_id = _next_job_id()
    logger.info(
        "start_install: job=%d zip=%s dest=%s overwrite=%s replace=%s suffix=%s",
        job_id, usb_zip_path, dest_root, overwrite, replace, suffix,
    )
    _progress = {
        "job_id": job_id, "operation": "copy", "percent": 0,
        "bytes_done": 0, "bytes_total": 0, "current_file": "",
        "updated_at": time.time(), "done": False, "error": None, "result": None,
        "request": {
            "usb_zip_path": usb_zip_path, "dest_root": dest_root,
            "overwrite": overwrite, "replace": replace, "suffix": suffix,
        },
    }
    _active_task = asyncio.create_task(_do_install(usb_zip_path, dest_root, overwrite, replace, suffix))
    return {"started": True, "busy": False, "job_id": job_id}
```

Remove the `start_copy` and `start_extract` RPC methods from `Plugin`.

`get_progress()` needs no signature change — `dict(_progress)` already
returns whatever is in the module-level dict.

`_unload()` is unchanged.

## Frontend changes — `src/index.tsx`

### Types

```ts
type ProgressRequest = {
  usb_zip_path: string;
  dest_root: string;
  overwrite: boolean;
  replace: boolean;
  suffix: boolean;
};

type ProgressResult = {
  job_id: number;
  operation: string;
  percent: number;
  bytes_done: number;
  bytes_total: number;
  current_file?: string;
  updated_at?: number;
  done: boolean;
  error: string | null;
  result: Record<string, string> | null;
  request: ProgressRequest | null;
};

type StartInstallResult = { started: boolean; busy: boolean; job_id: number; operation?: string };
```

### API wrapper

Replace `startCopy`/`startExtract` with:

```ts
async function startInstall(
  usb_zip_path: string,
  dest_root: string,
  overwrite = false,
  replace = false,
  suffix = false,
): Promise<StartInstallResult> {
  return call<[string, string, boolean, boolean, boolean], StartInstallResult>(
    "start_install", usb_zip_path, dest_root, overwrite, replace, suffix,
  );
}
```

### `waitForProgress`

Extend the `onUpdate` callback to also pass the polled `operation` string,
so callers can flip `step` between `"copying"`/`"extracting"` as the
backend transitions mid-poll (this now happens within a single job instead
of via two separate frontend-triggered calls):

```ts
const waitForProgress = useCallback(
  (onUpdate: (pct: number, bps: number, operation: string) => void): Promise<ProgressResult> => ...
```

Every call site of `waitForProgress` updates its callback signature
accordingly.

### `awaitInstallCompletion` (new, single source of truth)

This function is the **only** place that watches a job to completion. It
is used both for a freshly-started install and for resuming/attaching to
one already in flight — it never trusts locally-held state about what job
is running; it always asks the backend first.

```ts
const awaitInstallCompletion = async (): Promise<void> => {
  const initial = await getProgress();
  if (initial.request) {
    setCurrentZipName(basename(initial.request.usb_zip_path));
  }
  setStep(initial.operation === "extract" ? "extracting" : "copying");
  setProgress(initial.percent);
  setUsbSafeMsg(initial.operation === "extract");
  operationStartTime.current = Date.now();

  const result = await waitForProgress((pct, bps, operation) => {
    setProgress(pct);
    setSpeedBytesPerSec(bps);
    setStep(operation === "extract" ? "extracting" : "copying");
    if (operation === "extract") setUsbSafeMsg(true);
  });
  if (result.error) throw new Error(result.error);
  const gameDir = result.result!.game_dir;

  const lr = await getLaunchers(gameDir);
  if (!lr.launchers.length || !lr.type) {
    throw new Error("No .sh or .exe launcher found in the game folder.");
  }
  if (lr.launchers.length === 1) {
    await ensureExecutable(lr.launchers[0]);
    await finishInstall(gameDir, lr.launchers[0], lr.type);
  } else {
    setPendingGameDir(gameDir);
    setLaunchers(lr.launchers);
    setLauncherType(lr.type);
    setStep("launcher_pick");
  }
};
```

This absorbs everything `doInstall` currently does after `startExtract`
(main.py-side already covered; on the TS side this is
`src/index.tsx:736-758`).

### `doInstall` (rewritten)

```ts
const doInstall = async (
  usbZipPath: string,
  overwrite: boolean,
  replace = false,
  suffix = false,
) => {
  try {
    const started = await startInstall(usbZipPath, destRoot, overwrite, replace, suffix);
    if (started.busy) {
      log("warn", "Install already in progress (job %d, %s) — attaching instead of starting a new one", started.job_id, started.operation);
    }
    await awaitInstallCompletion();
  } catch (e) {
    log("error", "doInstall flow failed:", e);
    setErrorMsg(String(e));
    setStep("error");
  }
};
```

`handleZipSelect`, `handleOverwrite`, `handleReplace`, `handleSuffix` stay
as they are — they already just call `doInstall` with the right flags.

### Resume-on-mount

New state: `const [unseenResult, setUnseenResult] = useState<ProgressResult | null>(null);`

At the very start of the existing mount `useEffect` (currently
`src/index.tsx:360-453`), before the settings-loading block:

```ts
try {
  const active = await getProgress();
  if (!active.done) {
    log("info", "Resuming in-progress job on mount: job_id=%d operation=%s", active.job_id, active.operation);
    void awaitInstallCompletion().catch((e) => {
      log("error", "Resumed install failed:", e);
      setErrorMsg(String(e));
      setStep("error");
    });
    return; // resumed UI takes over; skip settings/USB scan this mount
  }
  if (active.operation !== "" && (active.result || active.error)) {
    setUnseenResult(active);
  }
} catch (e) {
  log("warn", "getProgress on mount failed (non-fatal):", e);
}
```

Everything after this in the effect (settings load, SD auto-detect,
USB auto-mount, ZIP auto-scan) runs unchanged when there is no
in-progress job to resume.

### Unseen-result banner (browse screen only)

Render above the existing `mountStatus` line, only when `page === "browse"`
and `step === "browse"` and `unseenResult !== null`:

- Success (`unseenResult.error === null`): `` `A previous install of "${basename(unseenResult.request?.usb_zip_path ?? "")}" finished while you were away. It was extracted to the SD card but was not added to Steam automatically.` ``
- Failure (`unseenResult.error !== null`): `` `A previous install of "${basename(unseenResult.request?.usb_zip_path ?? "")}" failed while you were away: ${unseenResult.error}` ``

Include a "Dismiss" `ButtonItem` that calls `setUnseenResult(null)`. Do not
trigger `getLaunchers`/`finishInstall`/any Steam-affecting call from this
banner.

## Documentation updates required

- `AGENTS.md`: replace the `start_copy(...)` / `start_extract(...)` bullet
  points (lines 86 and 88) with a single `start_install(...)` entry
  documenting its signature, the busy-response shape, and the new
  `job_id`/`request` fields on `get_progress()`. Add a short note under
  "Action flow" (step 2/3 area) describing resume-on-remount and the
  unseen-result banner, since this is a real behavior change a future
  reader needs to know about.
- `CHANGELOG.md`: add an entry under `## [Unreleased]` per the repo's
  standard change workflow.

## Test plan

### Backend — `tests/backend/test_main.py`

Replace `test_plugin_start_copy_cancels_inflight_task` and
`test_plugin_start_extract_cancels_inflight_task` (they test behavior this
change deliberately removes) with:

1. `test_do_install_runs_copy_then_extract_and_reports_game_dir` — happy
   path: assert `_progress["operation"]` observed as `"copy"` then
   `"extract"`, final `done=True`, `result["game_dir"]` correct.
2. `test_do_install_stops_after_copy_failure_and_does_not_extract` —
   monkeypatch `_copy_sync` to raise; monkeypatch `_extract_sync` to raise
   `AssertionError("should not be called")` as a tripwire; assert
   `error` is set and extract was never invoked.
3. `test_do_install_reports_extract_failure` — copy succeeds,
   `_extract_sync` raises; assert `done=True`, `error` set to that
   exception's message.
4. `test_do_install_reports_extract_timeout` — same pattern as the
   existing `test_do_extract_reports_timeout`, adapted to `_do_install`.
5. `test_start_install_rejects_second_call_while_job_active` — start a
   job (with a slow/blocked `_copy_sync` via monkeypatch or a real small
   file plus a short sleep), call `start_install` again before it
   finishes; assert the second call returns
   `{"started": False, "busy": True, ...}` with the *original* `job_id`,
   and that `_progress["job_id"]` is unchanged (i.e. nothing was
   replaced).
6. `test_start_install_allows_new_job_after_previous_completes` — run a
   job to completion, call `start_install` again, assert
   `{"started": True, ...}` with an incremented `job_id`.
7. `test_get_progress_includes_request_context` — start a job, call
   `get_progress()`, assert `request` contains the exact
   `usb_zip_path`/`dest_root`/`overwrite`/`replace`/`suffix` passed in.
8. `test_job_id_starts_at_zero_and_increments_monotonically` — sanity
   check across 3 sequential jobs.

Keep every other existing test in the file unchanged
(`_copy_sync`/`_extract_sync`/conflict-check/save/mount/discovery tests
are untouched by this change).

### Frontend — `src/index.test.tsx`

Update the existing installer-flow tests (currently around
`src/index.test.tsx:646-778`) to mock `start_install` instead of
`start_copy`/`start_extract`, and to have `get_progress` mock responses
include `job_id`/`request` fields and transition `operation` from
`"copy"` to `"extract"` across polls (matching the new single-job
backend behavior) rather than being driven by two separate `call()`
invocations.

New `describe("resume on mount")` block:

1. "reattaches to an in-progress copy job on mount, follows it through
   extraction, and completes the install" — mock `get_progress` to
   return `done:false, operation:"copy", request:{...}` on the first
   poll, then `operation:"extract"`, then `done:true` with a result;
   assert the panel shows the copying screen, then extracting, then
   reaches `finishInstall`/complete without `start_install` ever being
   called.
2. "reattaches to an in-progress extract job on mount, showing the
   extracting screen and USB-safe message immediately."
3. "shows a dismissible success banner for a job that finished while
   unmounted, without calling get_launchers or AddShortcut."
4. "shows a dismissible failure banner for a job that failed while
   unmounted."
5. "performs the normal cold-start flow (settings load, USB scan) when
   no prior job exists (`operation === ""`)."

New `describe("busy guard")` block:

6. "treats a busy start_install response as an attach rather than an
   error" — mock `start_install` to return `{started:false, busy:true,
   job_id:N, operation:"extract"}`, mock `get_progress` polling to
   completion; assert no error screen and the install still completes.

## Acceptance criteria

- `pnpm run lint` clean (zero output).
- `pnpm run build` succeeds.
- `pnpm test` (both `test:frontend` and `test:backend`) passes, including
  all new tests above.
- Combined coverage stays ≥ 80% (Codecov gate from PR #51) — add tests
  for any newly-uncovered branch rather than relaxing the threshold.
- `AGENTS.md` and `CHANGELOG.md` updated per the repo's own change
  workflow (see `AGENTS.md` "Change workflow" section).
- No signature changes to `_copy_sync`, `_extract_sync`,
  `_extract_member`, `_get_zip_top_folder`, or `check_extract_conflict`.
- No git operations performed as part of implementation (branching,
  committing, pushing, and opening the PR are handled separately).
