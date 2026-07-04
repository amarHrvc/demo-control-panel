const appEl = document.getElementById('app')
const teleprompterEl = document.getElementById('teleprompter')
const teleprompterTextEl = document.getElementById('teleprompter-text')
const baseUrlInput = document.getElementById('base-url-input')
const baseUrlStatus = document.getElementById('base-url-status')
const recordingToggleBtn = document.querySelector('[data-action="toggle-recording"]')
const recordingStatusEl = document.getElementById('recording-status')
const slowMoInput = document.getElementById('slowmo-input')
const slowMoStatus = document.getElementById('slowmo-status')

const INSTANCE_COLORS = { admin: '#e53935', doctor: '#1e88e5', patient: '#43a047' }

let steps = []
let instanceStatus = {} // id -> { open, url, paused, state }
let stepResults = {} // id -> { status: 'ok'|'err', text: string }

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function showTeleprompter(text) {
  if (!text) return
  teleprompterTextEl.textContent = text
  teleprompterEl.classList.add('show')
}

function renderRecordingToggle() {
  const anyStatus = Object.values(instanceStatus)[0]
  const enabled = anyStatus?.recordingEnabled ?? false
  recordingToggleBtn.textContent = enabled ? 'Recording: ON' : 'Recording: OFF'
  recordingToggleBtn.classList.toggle('record', enabled)
  recordingStatusEl.textContent = enabled
    ? 'New/reset instances will record. Already-open windows need Reset to start.'
    : ''
}

function render() {
  renderRecordingToggle()
  appEl.innerHTML = ''
  const byInstance = {}
  for (const step of steps) {
    ;(byInstance[step.instance] ??= []).push(step)
  }

  for (const [instanceId, instanceSteps] of Object.entries(byInstance)) {
    const status = instanceStatus[instanceId] ?? {}
    const color = INSTANCE_COLORS[instanceId] ?? '#888'
    const block = document.createElement('div')
    block.className = 'instance-block'
    block.id = `instance-${instanceId}`
    block.style.borderLeft = `4px solid ${color}`

    block.innerHTML = `
      <div class="instance-header">
        <div>
          <span class="dot" style="background:${status.open ? color : '#555'}"></span>
          <span class="name" style="color:${color}">${instanceId}</span>
          <span class="url">${status.open ? escapeHtml(status.url ?? '') : 'not open'}</span>
        </div>
        <div class="instance-actions">
          ${
            status.recordingActive
              ? `<span class="take-badge"><span class="rec-dot"></span>take ${status.takeNumber}</span>`
              : status.recordingEnabled && status.open
                ? `<span class="take-badge stale" title="Recording was turned on after this window opened — Reset to start capturing it">not recording — Reset to apply</span>`
                : ''
          }
          <button class="pill-btn" data-action="open" data-instance="${instanceId}">
            ${status.open ? 'Focus window' : 'Open browser (maximized)'}
          </button>
          <button class="pill-btn ${status.paused ? 'pause-on' : ''}" data-action="pause" data-instance="${instanceId}">
            ${status.paused ? 'Step-through ON — click to disarm' : 'Arm step-through'}
          </button>
          ${
            status.waitingLabel
              ? `<button class="pill-btn continue" data-action="continue" data-instance="${instanceId}">Continue →</button>`
              : ''
          }
          ${
            status.recordingActive
              ? `<button class="pill-btn record" data-action="new-take" data-instance="${instanceId}">New Take</button>`
              : ''
          }
          <button class="pill-btn danger" data-action="reset" data-instance="${instanceId}">Reset</button>
        </div>
      </div>
      ${status.waitingLabel ? `<div class="waiting">⏸ Waiting after: <strong>${escapeHtml(status.waitingLabel)}</strong></div>` : ''}
    `

    let lastSegment = null
    for (const step of instanceSteps) {
      if (step.segment !== lastSegment) {
        lastSegment = step.segment
        const label = document.createElement('div')
        label.className = 'segment-label'
        label.textContent = step.segment
        block.appendChild(label)
      }

      const lastResult = stepResults[step.id]
      const card = document.createElement('div')
      card.className = `card${lastResult ? ' ' + lastResult.status : ''}`
      card.id = `card-${step.id}`
      card.innerHTML = `
        <div class="card-top">
          <div class="title">${escapeHtml(step.title)}</div>
          <button class="run-btn" data-id="${step.id}">Run</button>
        </div>
        ${step.requires ? `<div class="requires">Requires: ${escapeHtml(step.requires)}</div>` : ''}
        <div class="result-slot">${lastResult ? `<div class="result ${lastResult.status}">${escapeHtml(lastResult.text)}</div>` : ''}</div>
      `
      block.appendChild(card)
    }

    appEl.appendChild(block)
  }

  appEl.querySelectorAll('.run-btn').forEach(btn => {
    btn.addEventListener('click', () => runStep(btn.dataset.id))
  })
  appEl.querySelectorAll('[data-action="open"]').forEach(btn => {
    btn.addEventListener('click', () => openInstance(btn.dataset.instance))
  })
  appEl.querySelectorAll('[data-action="pause"]').forEach(btn => {
    btn.addEventListener('click', () => togglePause(btn.dataset.instance))
  })
  appEl.querySelectorAll('[data-action="continue"]').forEach(btn => {
    btn.addEventListener('click', () => continueInstance(btn.dataset.instance))
  })
  appEl.querySelectorAll('[data-action="reset"]').forEach(btn => {
    btn.addEventListener('click', () => resetInstance(btn.dataset.instance))
  })
  appEl.querySelectorAll('[data-action="new-take"]').forEach(btn => {
    btn.addEventListener('click', () => newTake(btn.dataset.instance))
  })
}

async function runStep(id) {
  const step = steps.find(s => s.id === id)
  if (step?.say) showTeleprompter(step.say)

  const card = document.getElementById(`card-${id}`)
  const slot = card.querySelector('.result-slot')
  card.classList.remove('ok', 'err')
  card.classList.add('running')
  slot.innerHTML = ''

  try {
    const res = await fetch(`/api/steps/${id}/run`, { method: 'POST' })
    const json = await res.json()
    card.classList.remove('running')
    if (json.ok) {
      card.classList.add('ok')
      stepResults[id] = { status: 'ok', text: `done — ${json.url ?? ''}` }
    } else {
      card.classList.add('err')
      stepResults[id] = { status: 'err', text: json.error }
    }
    slot.innerHTML = `<div class="result ${stepResults[id].status}">${escapeHtml(stepResults[id].text)}</div>`
  } catch (err) {
    card.classList.remove('running')
    card.classList.add('err')
    stepResults[id] = { status: 'err', text: String(err) }
    slot.innerHTML = `<div class="result err">${escapeHtml(stepResults[id].text)}</div>`
  }
  refreshInstances()
}

async function openInstance(id) {
  await fetch(`/api/instances/${id}/open`, { method: 'POST' })
  refreshInstances()
}

async function togglePause(id) {
  await fetch(`/api/instances/${id}/pause`, { method: 'POST' })
  refreshInstances()
}

async function continueInstance(id) {
  await fetch(`/api/instances/${id}/continue`, { method: 'POST' })
  refreshInstances()
}

async function resetInstance(id) {
  if (!confirm(`Close and relaunch the ${id} browser? Captured state for it will be cleared.`)) return
  for (const step of steps) {
    if (step.instance === id) delete stepResults[step.id]
  }
  await fetch(`/api/instances/${id}/reset`, { method: 'POST' })
  refreshInstances()
}

async function newTake(id) {
  const label = prompt('Label for this take (optional, e.g. "Segment 2 — Doctor"):', '')
  if (label === null) return // cancelled
  const res = await fetch(`/api/instances/${id}/new-take`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label })
  })
  const json = await res.json()
  if (!json.ok) alert(json.error)
  await refreshInstances()
  await refreshRecordings()
}

function renderRecordings(enabled, takes) {
  const listEl = document.getElementById('recordings-list')
  const sectionEl = document.getElementById('recordings-section')
  if (!enabled && takes.length === 0) {
    sectionEl.style.display = 'none'
    return
  }
  sectionEl.style.display = ''
  if (takes.length === 0) {
    listEl.innerHTML = '<p style="color:#8b92a3;font-size:13px;">No takes recorded yet this session.</p>'
    return
  }
  listEl.innerHTML = takes
    .map(t => {
      const color = INSTANCE_COLORS[t.instance] ?? '#888'
      const name = t.label ? escapeHtml(t.label) : `Take ${t.take_number}`
      const link = t.file_path
        ? `<a href="/recordings/${t.file_path}" target="_blank">${escapeHtml(t.file_path.split('/').pop())}</a>`
        : `<span class="pending">recording…</span>`
      return `<div class="take-row">
        <span><strong style="color:${color}">${escapeHtml(t.instance)}</strong> · ${name}</span>
        <span style="display:flex;align-items:center;gap:10px;">
          ${link}
          <button class="pill-btn danger" data-action="delete-take" data-id="${t.id}">Delete</button>
        </span>
      </div>`
    })
    .join('')
  listEl.querySelectorAll('[data-action="delete-take"]').forEach(btn => {
    btn.addEventListener('click', () => deleteTakeRow(btn.dataset.id))
  })
}

async function deleteTakeRow(id) {
  if (!confirm('Delete this take? This removes its database entry and video file permanently.')) return
  const res = await fetch(`/api/recordings/${id}`, { method: 'DELETE' })
  const json = await res.json()
  if (!json.ok) {
    alert(json.error)
    return
  }
  await refreshRecordings()
}

async function refreshRecordings() {
  try {
    const res = await fetch('/api/recordings')
    const json = await res.json()
    renderRecordings(json.enabled, json.takes)
  } catch {
    // panel server not reachable
  }
}

async function refreshInstances() {
  try {
    const res = await fetch('/api/instances')
    const list = await res.json()
    instanceStatus = Object.fromEntries(list.map(i => [i.id, i]))
    render()
  } catch {
    // panel server not reachable — leave last known render in place
  }
}

async function loadBaseUrl() {
  const res = await fetch('/api/base-url')
  const json = await res.json()
  baseUrlInput.value = json.baseUrl
  baseUrlStatus.textContent = ''
  baseUrlStatus.className = ''
}

async function setBaseUrl(url) {
  baseUrlStatus.textContent = 'switching…'
  baseUrlStatus.className = ''
  try {
    const res = await fetch('/api/base-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    })
    const json = await res.json()
    if (!json.ok) throw new Error(json.error)
    baseUrlInput.value = json.baseUrl
    baseUrlStatus.textContent = `now targeting ${json.baseUrl} — open browsers were closed`
    baseUrlStatus.className = ''
    stepResults = {}
    await refreshInstances()
  } catch (err) {
    baseUrlStatus.textContent = String(err.message ?? err)
    baseUrlStatus.className = 'err'
  }
}

async function loadSlowMo() {
  const res = await fetch('/api/slowmo')
  const json = await res.json()
  slowMoInput.value = json.slowMo
  slowMoStatus.textContent = ''
  slowMoStatus.className = ''
}

async function setSlowMo(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) {
    slowMoStatus.textContent = 'enter a non-negative number'
    slowMoStatus.className = 'err'
    return
  }
  const res = await fetch('/api/slowmo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slowMo: value })
  })
  const json = await res.json()
  if (!json.ok) {
    slowMoStatus.textContent = json.error
    slowMoStatus.className = 'err'
    return
  }
  slowMoInput.value = json.slowMo
  slowMoStatus.textContent = 'applies to instances opened/reset from now on'
  slowMoStatus.className = ''
}

document.querySelector('[data-action="set-slowmo"]').addEventListener('click', () => setSlowMo(slowMoInput.value))
slowMoInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') setSlowMo(slowMoInput.value)
})

document.querySelector('[data-action="set-base-url"]').addEventListener('click', () => setBaseUrl(baseUrlInput.value))
document.querySelector('[data-action="quick-local"]').addEventListener('click', () => setBaseUrl('http://localhost:3000'))
baseUrlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') setBaseUrl(baseUrlInput.value)
})

async function toggleRecording() {
  const anyStatus = Object.values(instanceStatus)[0]
  const nextEnabled = !(anyStatus?.recordingEnabled ?? false)

  let label = null
  if (nextEnabled) {
    label = prompt('Name for this recording (used as the default take label instead of "Take 1"):', '')
    if (label === null) return // cancelled — leave recording off
  }

  await fetch('/api/recording', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: nextEnabled, label })
  })
  await refreshInstances()
  await refreshRecordings()
}

recordingToggleBtn.addEventListener('click', toggleRecording)

async function init() {
  const res = await fetch('/api/steps')
  steps = await res.json()
  await loadBaseUrl()
  await loadSlowMo()
  await refreshInstances()
  await refreshRecordings()
  setInterval(refreshInstances, 1500) // fast enough to catch a waitingLabel promptly during step-through
  setInterval(refreshRecordings, 4000)
}

init()
