const appEl = document.getElementById('app')
const teleprompterEl = document.getElementById('teleprompter')
const teleprompterTextEl = document.getElementById('teleprompter-text')
const baseUrlInput = document.getElementById('base-url-input')
const baseUrlStatus = document.getElementById('base-url-status')

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

function render() {
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

document.querySelector('[data-action="set-base-url"]').addEventListener('click', () => setBaseUrl(baseUrlInput.value))
document.querySelector('[data-action="quick-local"]').addEventListener('click', () => setBaseUrl('http://localhost:3000'))
baseUrlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') setBaseUrl(baseUrlInput.value)
})

async function init() {
  const res = await fetch('/api/steps')
  steps = await res.json()
  await loadBaseUrl()
  await refreshInstances()
  setInterval(refreshInstances, 1500) // fast enough to catch a waitingLabel promptly during step-through
}

init()
