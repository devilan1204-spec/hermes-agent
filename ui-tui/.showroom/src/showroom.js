const initial = window.__SHOWROOM_INITIAL__
const catalog = window.__SHOWROOM_CATALOG__ ?? []
const root = document.getElementById('showroom')
const SPEEDS = [0.5, 1, 2]

const role = {
  assistant: { color: '#d8d0bd', glyph: '✦' },
  system: { color: '#8f856f', glyph: '·' },
  tool: { color: '#f1cb78', glyph: '┊' },
  user: { color: '#f1cb78', glyph: '›' }
}

const escapeHtml = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    char => ({ '&': '&amp;', '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;' })[char]
  )

const state = {
  body: null,
  composer: null,
  overlays: null,
  progressFill: null,
  progressLabel: null,
  raf: null,
  shell: null,
  speed: 1,
  startedAt: 0,
  statusLeft: null,
  statusRight: null,
  timers: [],
  total: 0,
  viewport: null,
  workflow: initial?.workflow ?? { timeline: [] }
}

const clearTimers = () => {
  while (state.timers.length) {
    clearTimeout(state.timers.pop())
  }

  if (state.raf) {
    cancelAnimationFrame(state.raf)
    state.raf = null
  }
}

const target = id => (id ? document.querySelector(`[data-target="${CSS.escape(id)}"]`) : null)

const setText = (node, text = '', duration = 0) => {
  if (!duration || state.speed <= 0) {
    node.textContent = text

    return
  }

  const chars = [...text]
  const adjusted = duration / state.speed
  const started = performance.now()

  const frame = now => {
    const n = Math.min(chars.length, Math.ceil(((now - started) / adjusted) * chars.length))
    node.textContent = chars.slice(0, n).join('')

    if (n < chars.length) {
      requestAnimationFrame(frame)
    }
  }

  requestAnimationFrame(frame)
}

const removeAfter = (node, duration = 1400) => {
  const wait = duration / state.speed

  state.timers.push(
    setTimeout(() => {
      node.classList.remove('is-visible')
      state.timers.push(setTimeout(() => node.remove(), 420 / state.speed))
    }, wait)
  )
}

const rectFor = (id, pad = 10) => {
  const el = target(id)

  if (!el || !state.overlays) {
    return null
  }

  const stage = state.overlays.getBoundingClientRect()
  const rect = el.getBoundingClientRect()

  return {
    height: rect.height + pad * 2,
    left: rect.left - stage.left - pad,
    top: rect.top - stage.top - pad,
    width: rect.width + pad * 2
  }
}

const placeNear = (node, id, position = 'right') => {
  const rect = rectFor(id, 0)

  if (!rect) {
    node.style.left = `${state.viewport.scale * 28}px`
    node.style.top = `${state.viewport.scale * 28}px`

    return
  }

  const gap = 24
  const left = position === 'left' ? rect.left - node.offsetWidth - gap : rect.left + rect.width + gap
  const top = position === 'top' ? rect.top - node.offsetHeight - gap : rect.top

  node.style.left = `${Math.max(18, left)}px`
  node.style.top = `${Math.max(18, top)}px`
}

const message = action => {
  const spec = role[action.role] ?? role.assistant
  const line = document.createElement('div')
  const glyph = document.createElement('span')
  const copy = document.createElement('div')

  line.className = `showroom-line showroom-line-${action.role ?? 'assistant'}`
  line.dataset.target = action.id ?? ''
  line.style.setProperty('--role', spec.color)

  glyph.className = 'showroom-glyph'
  glyph.textContent = spec.glyph

  copy.className = 'showroom-copy'

  line.append(glyph, copy)
  state.body.append(line)
  setText(copy, action.text, action.duration)
}

const tool = action => {
  const box = document.createElement('div')
  const title = document.createElement('div')
  const items = document.createElement('div')

  box.className = 'showroom-tool'
  box.dataset.target = action.id ?? ''

  title.className = 'showroom-tool-title'
  title.textContent = action.title ?? 'tool activity'

  items.className = 'showroom-tool-items'

  for (const item of action.items ?? []) {
    const row = document.createElement('div')

    row.textContent = item
    items.append(row)
  }

  box.append(title, items)
  state.body.append(box)
}

const fade = action => {
  const el = target(action.target)

  if (!el) {
    return
  }

  el.style.transition = `opacity ${(action.duration ?? 420) / state.speed}ms var(--ease-in-out)`
  el.style.opacity = String(action.to ?? 0)
}

const highlight = action => {
  const el = target(action.target)

  if (!el) {
    return
  }

  el.classList.add('is-highlighted')
  state.timers.push(setTimeout(() => el.classList.remove('is-highlighted'), (action.duration ?? 1200) / state.speed))
}

const caption = action => {
  const node = document.createElement('div')

  node.className = 'showroom-caption'
  node.dataset.target = action.id ?? ''
  node.textContent = action.text ?? ''
  state.overlays.append(node)
  placeNear(node, action.target, action.position)
  requestAnimationFrame(() => node.classList.add('is-visible'))
  removeAfter(node, action.duration ?? 1600)
}

const spotlight = action => {
  const rect = rectFor(action.target, action.pad ?? 10)

  if (!rect) {
    return
  }

  const node = document.createElement('div')

  node.className = 'showroom-spotlight'
  node.style.left = `${rect.left}px`
  node.style.top = `${rect.top}px`
  node.style.width = `${rect.width}px`
  node.style.height = `${rect.height}px`
  state.overlays.append(node)
  requestAnimationFrame(() => node.classList.add('is-visible'))
  removeAfter(node, action.duration ?? 1500)
}

const status = action => {
  state.statusLeft.textContent = action.text ?? ''
  state.statusRight.textContent = action.detail ?? ''
}

const compose = action => setText(state.composer, action.text ?? '', action.duration ?? 0)

const clearTranscript = () => {
  state.body.textContent = ''
  state.overlays.textContent = ''
}

const ACTIONS = { caption, clear: clearTranscript, compose, fade, highlight, message, spotlight, status, tool }

const fmtTime = ms => {
  if (!Number.isFinite(ms)) {
    return '0.0s'
  }

  const sec = Math.max(0, ms) / 1000

  return `${sec.toFixed(1)}s`
}

const tickProgress = () => {
  if (!state.startedAt) {
    return
  }

  const elapsed = Math.min(state.total, (performance.now() - state.startedAt) * state.speed)
  const ratio = state.total ? elapsed / state.total : 0

  state.progressFill.style.width = `${(ratio * 100).toFixed(2)}%`
  state.progressLabel.textContent = `${fmtTime(elapsed)} / ${fmtTime(state.total)}`

  if (elapsed < state.total) {
    state.raf = requestAnimationFrame(tickProgress)
  }
}

const play = () => {
  clearTimers()
  clearTranscript()
  state.statusLeft.textContent = ''
  state.statusRight.textContent = ''
  state.composer.textContent = state.workflow.composer ?? '›'

  const timeline = [...(state.workflow.timeline ?? [])].sort((a, b) => a.at - b.at)

  state.total = timeline.reduce((max, action) => Math.max(max, action.at + (action.duration ?? 0)), 0)
  state.startedAt = performance.now()
  state.progressFill.style.width = '0%'
  state.progressLabel.textContent = `0.0s / ${fmtTime(state.total)}`

  for (const action of timeline) {
    state.timers.push(setTimeout(() => ACTIONS[action.type]?.(action), action.at / state.speed))
  }

  state.raf = requestAnimationFrame(tickProgress)
}

const setSpeed = next => {
  state.speed = next

  for (const button of state.shell.querySelectorAll('.showroom-speed button')) {
    button.classList.toggle('is-active', Number(button.dataset.speed) === next)
  }
}

const loadWorkflow = async name => {
  const url = new URL(window.location.href)
  url.searchParams.set('w', name)
  window.history.replaceState(null, '', url)

  try {
    const response = await fetch(`/api/workflow/${encodeURIComponent(name)}`)

    if (response.ok) {
      state.workflow = await response.json()
    }
  } catch {
    /* fall through to current workflow */
  }

  play()
}

const buildOptions = () => {
  if (!catalog.length) {
    return ''
  }

  return catalog
    .map(({ name, title }) => {
      const selected = name === initial?.name ? ' selected' : ''

      return `<option value="${escapeHtml(name)}"${selected}>${escapeHtml(title)}</option>`
    })
    .join('')
}

const buildSpeed = () =>
  SPEEDS.map(
    speed =>
      `<button type="button" data-speed="${speed}" class="${speed === 1 ? 'is-active' : ''}">${speed}x</button>`
  ).join('')

const mount = () => {
  const viewport = { cellWidth: 9, cols: 96, lineHeight: 18, rows: 30, scale: 4, ...(state.workflow.viewport ?? {}) }
  const shell = document.createElement('section')

  state.viewport = viewport
  state.shell = shell

  shell.className = 'showroom-shell'
  shell.style.setProperty('--cell-w', `${viewport.cellWidth}px`)
  shell.style.setProperty('--cols', `${viewport.cols}`)
  shell.style.setProperty('--line-h', `${viewport.lineHeight}px`)
  shell.style.setProperty('--rows', `${viewport.rows}`)
  shell.style.setProperty('--scale', `${viewport.scale}`)
  shell.style.setProperty('--stage-h', `${viewport.rows * viewport.lineHeight * viewport.scale}px`)
  shell.style.setProperty('--stage-w', `${viewport.cols * viewport.cellWidth * viewport.scale}px`)
  shell.style.setProperty('--term-h', `${viewport.rows * viewport.lineHeight}px`)
  shell.style.setProperty('--term-w', `${viewport.cols * viewport.cellWidth}px`)

  shell.innerHTML = `
    <header class="showroom-title">
      <span class="showroom-title-name">
        <span data-role="title">${escapeHtml(state.workflow.title ?? 'Hermes TUI Showroom')}</span>
        <span class="showroom-title-tag">showroom</span>
      </span>
      <span class="showroom-meta">
        <span>${viewport.cols}x${viewport.rows} · ${viewport.scale}x</span>
        ${catalog.length > 1 ? `<select class="showroom-picker" data-action="picker">${buildOptions()}</select>` : ''}
      </span>
    </header>
    <div class="showroom-stage">
      <div class="showroom-terminal">
        <div class="showroom-status" data-target="status">
          <span></span>
          <span></span>
        </div>
        <div class="showroom-body"></div>
        <div class="showroom-composer" data-target="composer"></div>
      </div>
      <div class="showroom-overlays"></div>
    </div>
    <div class="showroom-progress">
      <span data-role="time">0.0s / 0.0s</span>
      <div class="showroom-progress-track"><div class="showroom-progress-fill"></div></div>
    </div>
    <footer class="showroom-controls">
      <button type="button" data-action="restart">Restart</button>
      <button type="button" data-action="clear">Clear</button>
      <span class="showroom-speed">${buildSpeed()}</span>
    </footer>
  `

  root.replaceChildren(shell)

  state.body = shell.querySelector('.showroom-body')
  state.composer = shell.querySelector('.showroom-composer')
  state.overlays = shell.querySelector('.showroom-overlays')
  state.statusLeft = shell.querySelector('.showroom-status span:first-child')
  state.statusRight = shell.querySelector('.showroom-status span:last-child')
  state.progressFill = shell.querySelector('.showroom-progress-fill')
  state.progressLabel = shell.querySelector('[data-role="time"]')

  shell.querySelector('[data-action="restart"]').addEventListener('click', play)
  shell.querySelector('[data-action="clear"]').addEventListener('click', () => {
    clearTimers()
    clearTranscript()
  })

  for (const button of shell.querySelectorAll('.showroom-speed button')) {
    button.addEventListener('click', () => setSpeed(Number(button.dataset.speed)))
  }

  const picker = shell.querySelector('[data-action="picker"]')

  if (picker) {
    picker.addEventListener('change', event => {
      const next = event.target.value

      shell.querySelector('[data-role="title"]').textContent =
        catalog.find(c => c.name === next)?.title ?? next
      void loadWorkflow(next)
    })
  }

  window.addEventListener('keydown', event => {
    const key = event.key.toLowerCase()

    if (key === 'r') {
      play()
    } else if (key === 'c') {
      clearTimers()
      clearTranscript()
    } else if (key === '1' || key === '2' || key === '3') {
      setSpeed(SPEEDS[Number(key) - 1])
    }
  })

  requestAnimationFrame(() => shell.classList.add('is-mounted'))
  play()
}

mount()
