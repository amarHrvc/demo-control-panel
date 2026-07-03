# Demo Control Panel

A Playwright-driven live-demo runner for the NutriBase app (bachelor defense
presentation). Extracted from `nutri-ledger/_docs_uni/presentation/demo-runner`
into its own repo so it can evolve independently of the app monorepo.

Drives real, headed Chromium instances through a scripted clinical demo
(admin → doctor → patient roles) so the presenter can click through it live,
or record it. Two front ends share the same step definitions:

- **`npm run panel`** — a local web control panel (`http://localhost:4949`)
  with one button per step, clickable independently and out of order.
- **`npm run demo`** — a terminal script that runs the same steps in order,
  advancing on Enter.

## Setup

```bash
npm install
npm run install-browser   # first time only, downloads Chromium
```

The target app (NutriBase frontend + backend) must be running separately —
this repo only drives a browser against it, it doesn't host it.

```bash
BASE_URL=http://localhost:3000 npm run panel
```

`BASE_URL` defaults to `http://localhost:3000`.

## Rehearsing without side effects

Two steps mutate real data / cost money: creating a visit + vitals for
Fatima, and generating an AI diet plan (an actual OpenAI call). Set
`DRY_RUN=1` to skip just those two while rehearsing:

```bash
DRY_RUN=1 npm run panel
```

Run without `DRY_RUN` only when you actually want those effects (the real
defense, or a deliberate re-seed-and-redo).

## Architecture

- **`steps.ts`** — single source of truth. Each step declares which role
  `instance` it belongs to (`admin` / `doctor` / `patient`), an optional
  human-readable `requires` note (not enforced — the panel is free-for-all,
  you can click any step in any order), and a `run()` that returns a
  `Partial<DemoState>` patch. The patch is only merged into that instance's
  state by the caller **after** `run()` resolves successfully — a step that
  throws partway through never leaves stale/partial state behind.
- **`server.ts`** — owns up to three independent, persistent Chromium
  instances (one per role, since each needs its own login session), each
  launched maximized (`--start-maximized`, `viewport: null`) so you can drag
  it to a second monitor once and leave it. Exposes `/api/steps`,
  `/api/instances`, and per-instance open/pause/reset endpoints.
- **`demo.ts`** — thin terminal wrapper around the same `steps.ts`, useful as
  a fallback if the web panel misbehaves mid-presentation.
- **`public/`** — the panel's static UI: one section per role instance
  (Open/Focus, Pause, Reset), a teleprompter banner that pops up each step's
  talking point in large text, and per-step run/result cards.

### Visual instance tagging

Each instance's page gets a colored inset frame + corner badge (red=admin,
blue=doctor, green=patient) injected via `page.addInitScript()`, so the
three windows are distinguishable at a glance — useful once you're running
three maximized Chromium windows across two monitors.

**Gotcha (already fixed, don't reintroduce it):** `tagInstanceWindow()` in
`steps.ts` passes a raw *script string* to `addInitScript()`, not a function.
Passing a function is normally supported by Playwright — it serializes the
function via `.toString()` — but `tsx`'s esbuild transform injects a
`__name(...)` helper call into named functions/arrows (for stack-trace name
preservation) that only exists in the Node runtime. Once that stringified
source is injected into the browser, `__name` is undefined there and the
whole script throws immediately, silently, before ever creating the
frame/badge. Keep this as a plain string.

### Pause / checkpoints

Each instance has an independent pause flag (`Pause` button in its header).
A handful of steps call `checkpoint()` at natural narrative breaks (after a
search demo, before a dialog submit, before a final confirm click) — while
paused, execution blocks there until resumed. This is coarse by design (no
per-micro-action step-through, no speed multiplier) per a deliberate
scope call: good enough to catch your breath or freeze mid-step without
rebuilding every step into individually resumable micro-actions.

### Window focus

There's no reliable programmatic "bring this window to the front" on
Windows — `page.bringToFront()` only activates the tab inside the browser,
not the OS-level window, because Windows' foreground-lock restriction
blocks background processes from stealing focus from whatever you're
currently clicked into. The "Focus window" button still calls
`bringToFront()` as a harmless best effort, but don't rely on it — that's
why the colored frame/badge tagging exists instead: you can tell instances
apart by sight without needing focus-stealing to work at all.

## Deferred / not yet built

- **Video recording.** Playwright supports this natively
  (`context({ recordVideo: { dir, size } })`, one `.webm` finalized per page
  on close) and fits the "shoot small clips, redo just the broken one" idea
  well: each instance's page becomes a "take," and a `New Take` action would
  close the current page (finalizing its video) and open a fresh one in the
  same context — cookies/login persist at the context level, so no
  re-login needed between takes. Not implemented yet; revisit when ready to
  actually record.
- **Secondary-monitor auto-positioning.** Deliberately skipped — instances
  launch maximized on whatever monitor Windows opens them on, and you drag
  them to the second monitor by hand. No monitor-geometry detection/config
  was built.
