# Demo Control Panel

A Playwright-driven live-demo runner for the NutriBase app (bachelor defense
presentation). Extracted from `nutri-ledger/_docs_uni/presentation/demo-runner`
into its own repo so it can evolve independently of the app monorepo.

Drives real, headed Chromium instances through a scripted clinical demo
(admin → doctor → patient roles) so the presenter can click through it live.
Two front ends share the same step definitions:

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
BASE_URL=http://localhost:3000 npm run panel        # bash / zsh
```
```powershell
$env:BASE_URL='http://localhost:3000'; npm run panel # PowerShell
```

`BASE_URL` defaults to `http://localhost:3000`, and is only the *initial*
value for `npm run panel` — the web panel's header has a base-URL bar
(text field + `Set` + a `Local` quick button) that repoints the demo at any
running environment, e.g. a Railway-hosted deploy, without restarting the
process. Switching it closes any open role browsers, since a session logged
into the old environment would otherwise sit there silently pointed at the
wrong app. `npm run demo` (the terminal runner) does not have this control —
it only reads `BASE_URL` once at startup.

## Rehearsing without side effects

Two steps mutate real data / cost money: creating a visit + vitals for
Fatima, and generating an AI diet plan (an actual OpenAI call). Set
`DRY_RUN=1` to skip just those two while rehearsing:

```bash
DRY_RUN=1 npm run panel        # bash / zsh
```
```powershell
$env:DRY_RUN='1'; npm run panel # PowerShell
```

Run without `DRY_RUN` only when you actually want those effects (the real
defense, or a deliberate re-seed-and-redo).

## Screen descriptions

Each step can burn its talking point (the `say` line) onto the screen
itself, beside the role badge, while it runs — handy for following along on
a recording or screenshot without needing the panel visible. Flip the
**Descriptions: ON/OFF** toggle in the panel header to turn this on or off;
it takes effect on the very next step you run, no restart or reset needed.
Descriptions are on by default.

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

### Pause / step-through

Each instance has an independent step-through arm/disarm toggle (`Arm
step-through` in its header). Every atomic action inside a step's `run()` is
wrapped in `act(label, fn)`; while armed, execution blocks *after* the action
completes and stays blocked until the presenter clicks `Continue →` — which
advances past exactly that one action and re-arms for the next `act()` call.
So arming it once stops you at every logical action in sequence (open a
page, type a search, press enter, click a result — each its own beat) rather
than only the first breakpoint you happen to catch before it disarms itself.
Disarming mid-block releases the current action immediately, running the
rest of the step unattended.

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

- **Secondary-monitor auto-positioning.** Deliberately skipped — instances
  launch maximized on whatever monitor Windows opens them on, and you drag
  them to the second monitor by hand. No monitor-geometry detection/config
  was built.
