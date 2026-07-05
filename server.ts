/**
 * NutriBase live demo — web control panel.
 *
 * One persistent Chromium instance PER ROLE (admin / doctor / patient),
 * since each role needs its own login session. Steps are triggered
 * independently by button click, not forced into order — each carries a
 * "requires" note (shown in the UI) but nothing is disabled.
 *
 * Setup:
 *   npm install
 *   npm run install-browser   (first time only)
 *
 * Run (make sure the app is up: composer run dev / pnpm run dev):
 *   npm run panel
 *   DRY_RUN=1 npm run panel
 *
 * Then open http://localhost:4949. Each instance opens maximized on launch —
 * drag it to your second monitor once and leave it there.
 */

import express from 'express'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'
import { buildSteps, emptyState, tagInstanceWindow, installVisualCues, setPageCaption, setBaseUrl, BASE_URL, INSTANCE_IDS, type DemoState, type InstanceId } from './steps.ts'

const PANEL_PORT = Number(process.env.PANEL_PORT ?? 4949)
const PUBLIC_DIR = fileURLToPath(new URL('./public', import.meta.url))

/**
 * Playwright only accepts slowMo at browser-launch time, so changing this only
 * takes effect for instances opened (or reset) afterward; it can't retroactively
 * slow down an already-open instance.
 */
let slowMoMs = Number(process.env.SLOWMO ?? 150)

/** Whether the on-page "say" caption is burned into each step's screen. Independent of recording. */
let descriptionsEnabled = true

const app = express()
app.use(express.static(PUBLIC_DIR))
app.use(express.json())

interface Instance {
  browser: Browser
  context: BrowserContext
  page: Page
  state: DemoState
  /** Step-through mode armed/disarmed — while armed, act() blocks after every action. */
  paused: boolean
  /** Label of the action just completed, while blocked waiting for Continue. Null when not blocked. */
  waitingLabel: string | null
  /** Resolves the current block. Set only while actually waiting; null otherwise. */
  resumeResolver: (() => void) | null
}

const instances = new Map<InstanceId, Instance>()
const steps = buildSteps()

async function closeInstance(instance: Instance): Promise<void> {
  await instance.browser.close().catch(() => {})
}

async function ensureInstance(id: InstanceId): Promise<Instance> {
  const existing = instances.get(id)
  if (existing && !existing.page.isClosed()) return existing

  const browser = await chromium.launch({ headless: false, slowMo: slowMoMs, args: ['--start-maximized'] })
  const context = await browser.newContext({ viewport: null })
  const page = await context.newPage()
  await tagInstanceWindow(page, id)
  await installVisualCues(page)
  // Land on a real start point instead of a blank tab: the dashboard if this browser already
  // carries a valid session (unlikely right after a fresh launch), or wherever the app's auth
  // guard redirects otherwise (login) — same behavior as reset.
  await page.goto(`${BASE_URL}/dashboard/home`).catch(() => {})
  const instance: Instance = {
    browser,
    context,
    page,
    state: emptyState(),
    paused: false,
    waitingLabel: null,
    resumeResolver: null
  }
  instances.set(id, instance)
  return instance
}

/**
 * Runs one atomic step action, then — if step-through is armed — blocks until
 * /continue releases it. Unlike a plain pause flag, this re-arms itself: each
 * act() call is its own checkpoint, so staying armed stops you at every one
 * in sequence rather than only the first one you happen to catch.
 */
async function act<T>(instance: Instance, label: string, fn: () => Promise<T>): Promise<T> {
  const result = await fn()
  if (instance.paused) {
    instance.waitingLabel = label
    await new Promise<void>(resolve => {
      instance.resumeResolver = resolve
    })
  }
  return result
}

app.get('/api/steps', (_req, res) => {
  res.json(
    steps.map(s => ({
      id: s.id,
      instance: s.instance,
      segment: s.segment,
      title: s.title,
      say: s.say,
      requires: s.requires
    }))
  )
})

app.get('/api/instances', (_req, res) => {
  res.json(
    INSTANCE_IDS.map(id => {
      const inst = instances.get(id)
      return {
        id,
        open: !!inst && !inst.page.isClosed(),
        url: inst && !inst.page.isClosed() ? inst.page.url() : null,
        paused: inst?.paused ?? false,
        waitingLabel: inst?.waitingLabel ?? null,
        state: inst?.state ?? emptyState()
      }
    })
  )
})

app.post('/api/instances/:id/open', async (req, res) => {
  const id = req.params.id as InstanceId
  if (!INSTANCE_IDS.includes(id)) {
    res.status(404).json({ ok: false, error: 'Unknown instance' })
    return
  }
  const instance = await ensureInstance(id)
  await instance.page.bringToFront() // launches if closed, focuses the OS window if already open
  res.json({ ok: true })
})

app.post('/api/instances/:id/pause', async (req, res) => {
  const id = req.params.id as InstanceId
  const inst = instances.get(id)
  if (!inst) {
    res.status(400).json({ ok: false, error: 'Instance not open yet' })
    return
  }
  inst.paused = typeof req.body?.paused === 'boolean' ? req.body.paused : !inst.paused
  // Disarming mid-block releases it immediately instead of leaving the step frozen forever.
  if (!inst.paused && inst.resumeResolver) {
    inst.resumeResolver()
    inst.resumeResolver = null
    inst.waitingLabel = null
  }
  res.json({ ok: true, paused: inst.paused })
})

app.post('/api/instances/:id/continue', async (req, res) => {
  const id = req.params.id as InstanceId
  const inst = instances.get(id)
  if (!inst || !inst.resumeResolver) {
    res.status(400).json({ ok: false, error: 'Not currently waiting' })
    return
  }
  inst.resumeResolver()
  inst.resumeResolver = null
  inst.waitingLabel = null
  res.json({ ok: true })
})

app.post('/api/instances/:id/reset', async (req, res) => {
  const id = req.params.id as InstanceId
  const existing = instances.get(id)
  if (existing) {
    await closeInstance(existing)
    instances.delete(id)
  }
  await ensureInstance(id)
  res.json({ ok: true })
})

app.get('/api/descriptions', (_req, res) => {
  res.json({ enabled: descriptionsEnabled })
})

app.post('/api/descriptions', (req, res) => {
  const enabled = req.body?.enabled
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ ok: false, error: 'enabled (boolean) is required' })
    return
  }
  descriptionsEnabled = enabled
  res.json({ ok: true, enabled: descriptionsEnabled })
})

app.get('/api/slowmo', (_req, res) => {
  res.json({ slowMo: slowMoMs })
})

app.post('/api/slowmo', (req, res) => {
  const ms = req.body?.slowMo
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    res.status(400).json({ ok: false, error: 'slowMo (non-negative number) is required' })
    return
  }
  slowMoMs = Math.round(ms)
  res.json({ ok: true, slowMo: slowMoMs })
})

app.get('/api/base-url', (_req, res) => {
  res.json({ baseUrl: BASE_URL })
})

app.post('/api/base-url', async (req, res) => {
  const url = req.body?.url
  if (typeof url !== 'string' || !url.trim()) {
    res.status(400).json({ ok: false, error: 'url is required' })
    return
  }
  try {
    setBaseUrl(url)
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message })
    return
  }
  // Old sessions are logged into whatever environment was live when they opened —
  // closing them avoids a demo where two role windows silently point at different apps.
  for (const [id, instance] of instances) {
    await closeInstance(instance)
    instances.delete(id)
  }
  res.json({ ok: true, baseUrl: BASE_URL })
})

app.post('/api/steps/:id/run', async (req, res) => {
  const step = steps.find(s => s.id === req.params.id)
  if (!step) {
    res.status(404).json({ ok: false, error: 'Unknown step id' })
    return
  }
  let instance: Instance | null = null
  try {
    instance = await ensureInstance(step.instance)
    // Burns the presenter's talking point onto the screen beside the role badge, toggleable
    // independently of anything else so the presenter can turn it off for a clean live view.
    if (descriptionsEnabled) await setPageCaption(instance.page, step.say)
    const patch = await step.run({
      page: instance.page,
      state: instance.state,
      act: (label, fn) => act(instance!, label, fn)
    })
    if (patch) Object.assign(instance.state, patch) // atomic: only merged after run() resolves
    res.json({ ok: true, url: instance.page.url() })
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message })
  } finally {
    // Hide it once the step is done (pass or fail) rather than leaving it up until the next
    // step overwrites it — the presenter can also dismiss it early via the × on the caption itself.
    if (instance && descriptionsEnabled) await setPageCaption(instance.page, null)
  }
})

app.listen(PANEL_PORT, () => {
  console.log(`Demo control panel: http://localhost:${PANEL_PORT}`)
})

async function shutdown() {
  for (const instance of instances.values()) await closeInstance(instance)
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
