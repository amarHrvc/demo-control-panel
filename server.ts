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
import { buildSteps, emptyState, tagInstanceWindow, setBaseUrl, BASE_URL, INSTANCE_IDS, type DemoState, type InstanceId } from './steps.ts'
import { RECORDING_ENABLED, RECORDINGS_DIR, RECORDINGS_ROOT, startTake, finalizeTake, listTakes, type OpenTake } from './recordings.ts'

const PANEL_PORT = Number(process.env.PANEL_PORT ?? 4949)
const PUBLIC_DIR = fileURLToPath(new URL('./public', import.meta.url))

const app = express()
app.use(express.static(PUBLIC_DIR))
app.use('/recordings', express.static(RECORDINGS_ROOT))
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
  /** Current take's video handle + DB row, only set when RECORDING_ENABLED. */
  recording: OpenTake | null
}

const instances = new Map<InstanceId, Instance>()
const steps = buildSteps()

function beginTake(id: InstanceId, page: Page, takeNumber: number, label: string | null): OpenTake {
  const takeId = startTake(id, takeNumber, label)
  return { id: takeId, takeNumber, video: page.video() }
}

/** Closes the browser first so the video is guaranteed written, then records its final path. */
async function closeInstance(instance: Instance): Promise<void> {
  const recording = instance.recording
  await instance.browser.close().catch(() => {})
  if (recording) await finalizeTake(recording.id, recording.video)
}

async function ensureInstance(id: InstanceId): Promise<Instance> {
  const existing = instances.get(id)
  if (existing && !existing.page.isClosed()) return existing

  const browser = await chromium.launch({ headless: false, slowMo: 150, args: ['--start-maximized'] })
  const context = await browser.newContext({
    viewport: null,
    ...(RECORDING_ENABLED ? { recordVideo: { dir: RECORDINGS_DIR, size: { width: 1920, height: 1080 } } } : {})
  })
  const page = await context.newPage()
  await tagInstanceWindow(page, id)
  const instance: Instance = {
    browser,
    context,
    page,
    state: emptyState(),
    paused: false,
    waitingLabel: null,
    resumeResolver: null,
    recording: RECORDING_ENABLED ? beginTake(id, page, 1, null) : null
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
        state: inst?.state ?? emptyState(),
        recordingEnabled: RECORDING_ENABLED,
        takeNumber: inst?.recording?.takeNumber ?? null
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

app.post('/api/instances/:id/new-take', async (req, res) => {
  const id = req.params.id as InstanceId
  if (!RECORDING_ENABLED) {
    res.status(400).json({ ok: false, error: 'Recording is off (start the panel with RECORD=1)' })
    return
  }
  const inst = instances.get(id)
  if (!inst || !inst.recording) {
    res.status(400).json({ ok: false, error: 'Instance not open yet' })
    return
  }
  const label = typeof req.body?.label === 'string' && req.body.label.trim() ? req.body.label.trim() : null

  const oldPage = inst.page
  const oldRecording = inst.recording
  const newPage = await inst.context.newPage() // same context: cookies/login carry over into the new take
  await tagInstanceWindow(newPage, id)
  await oldPage.close() // finalizes the outgoing take's video
  await finalizeTake(oldRecording.id, oldRecording.video)

  inst.page = newPage
  inst.recording = beginTake(id, newPage, oldRecording.takeNumber + 1, label)
  res.json({ ok: true, takeNumber: inst.recording.takeNumber })
})

app.get('/api/recordings', (_req, res) => {
  res.json({ enabled: RECORDING_ENABLED, takes: listTakes() })
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
  try {
    const instance = await ensureInstance(step.instance)
    const patch = await step.run({
      page: instance.page,
      state: instance.state,
      act: (label, fn) => act(instance, label, fn)
    })
    if (patch) Object.assign(instance.state, patch) // atomic: only merged after run() resolves
    res.json({ ok: true, url: instance.page.url() })
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message })
  }
})

app.listen(PANEL_PORT, () => {
  console.log(`Demo control panel: http://localhost:${PANEL_PORT}`)
  if (RECORDING_ENABLED) console.log(`Recording ON — takes saved under ${RECORDINGS_DIR}`)
})

// Ctrl+C mid-recording would otherwise kill Chromium before its video is muxed/finalized,
// leaving a corrupt .webm — close every instance properly first so takes are recoverable.
async function shutdown() {
  for (const instance of instances.values()) await closeInstance(instance)
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
