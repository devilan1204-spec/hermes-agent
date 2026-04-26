const workflow = window.__SHOWROOM_WORKFLOW__
const root = document.getElementById('showroom')
const timers = []

let body
let composer
let overlays
let statusLeft
let statusRight
let viewportConfig

const role = {
  assistant: { color: '#d8d0bd', glyph: '✦' },
  system: { color: '#8f856f', glyph: '·' },
  tool: { color: '#f1cb78', glyph: '┊' },
  user: { color: '#f1cb78', glyph: '›' }
}

const escapeHtml = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    char =>
      ({
        '&': '&amp;',
        '"': '&quot;',
        "'": '&#39;',
        '<': '&lt;',
        '>': '&gt;'
      })[char]
  )

const clearTimers = () => {
  while (timers.length) {
    clearTimeout(timers.pop())
  }
}

const target = id => (id ? document.querySelector(`[data-target="${CSS.escape(id)}"]`) : null)

const setText = (node, text = '', duration = 0) => {
  if (!duration) {
    node.textContent = text

    return
  }

  const chars = [...text]
  const started = performance.now()

  const frame = now => {
    const n = Math.min(chars.length, Math.ceil(((now - started) / duration) * chars.length))
    node.textContent = chars.slice(0, n).join('')

    if (n < chars.length) {
      requestAnimationFrame(frame)
    }
  }

  requestAnimationFrame(frame)
}

const removeAfter = (node, duration = 1400) => {
  timers.push(
    setTimeout(() => {
      node.classList.remove('is-visible')
      timers.push(setTimeout(() => node.remove(), 420))
    }, duration)
  )
}

const rectFor = (id, pad = 10) => {
  const el = target(id)

  if (!el) {
    return null
  }

  const stage = overlays.getBoundingClientRect()
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
    node.style.left = `${viewportConfig.scale * 28}px`
    node.style.top = `${viewportConfig.scale * 28}px`

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
  body.append(line)
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
  body.append(box)
}

const fade = action => {
  const el = target(action.target)

  if (!el) {
    return
  }

  el.style.transition = `opacity ${action.duration ?? 420}ms ease`
  el.style.opacity = String(action.to ?? 0)
}

const highlight = action => {
  const el = target(action.target)

  if (!el) {
    return
  }

  el.classList.add('is-highlighted')
  timers.push(setTimeout(() => el.classList.remove('is-highlighted'), action.duration ?? 1200))
}

const caption = action => {
  const node = document.createElement('div')

  node.className = 'showroom-caption'
  node.dataset.target = action.id ?? ''
  node.textContent = action.text ?? ''
  overlays.append(node)
  placeNear(node, action.target, action.position)
  requestAnimationFrame(() => node.classList.add('is-visible'))
  removeAfter(node, action.duration)
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
  overlays.append(node)
  requestAnimationFrame(() => node.classList.add('is-visible'))
  removeAfter(node, action.duration)
}

const status = action => {
  statusLeft.textContent = action.text ?? ''
  statusRight.textContent = action.detail ?? ''
}

const compose = action => setText(composer, action.text ?? '', action.duration)

const clear = () => {
  body.textContent = ''
  overlays.textContent = ''
}

const run = action =>
  ({
    caption,
    clear,
    compose,
    fade,
    highlight,
    message,
    spotlight,
    status,
    tool
  })[action.type]?.(action)

const play = () => {
  clearTimers()
  clear()
  statusLeft.textContent = ''
  statusRight.textContent = ''
  composer.textContent = workflow.composer ?? '›'

  for (const action of [...(workflow.timeline ?? [])].sort((a, b) => a.at - b.at)) {
    timers.push(setTimeout(() => run(action), action.at))
  }
}

const mount = () => {
  const viewport = { cellWidth: 9, cols: 96, lineHeight: 18, rows: 30, scale: 4, ...workflow.viewport }
  const shell = document.createElement('section')

  viewportConfig = viewport
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
      <span>${escapeHtml(workflow.title ?? 'Hermes TUI Showroom')}</span>
      <span class="showroom-meta">${viewport.cols}x${viewport.rows} · ${viewport.scale}x</span>
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
    <footer class="showroom-controls">
      <button type="button" data-action="restart">Restart</button>
      <button type="button" data-action="clear">Clear</button>
    </footer>
  `

  root.replaceChildren(shell)

  body = shell.querySelector('.showroom-body')
  composer = shell.querySelector('.showroom-composer')
  overlays = shell.querySelector('.showroom-overlays')
  statusLeft = shell.querySelector('.showroom-status span:first-child')
  statusRight = shell.querySelector('.showroom-status span:last-child')

  shell.querySelector('[data-action="restart"]').addEventListener('click', play)
  shell.querySelector('[data-action="clear"]').addEventListener('click', () => {
    clearTimers()
    clear()
  })

  window.addEventListener('keydown', event => {
    if (event.key.toLowerCase() === 'r') {
      play()
    }
  })

  play()
}

mount()
