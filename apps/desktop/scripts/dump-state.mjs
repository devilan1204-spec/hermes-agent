// Just dump current state of the page
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const tgt = list.find(t => t.type === 'page' && t.url.startsWith('http'))
const ws = new WebSocket(tgt.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data)
  if (m.id != null && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
await new Promise(r => ws.addEventListener('open', r))
const send = (m, p = {}) =>
  new Promise(r => {
    const i = ++id
    pending.set(i, r)
    ws.send(JSON.stringify({ id: i, method: m, params: p }))
  })

async function evalP(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
  return r.result.result.value
}

const data = await evalP(`JSON.stringify({
  url: location.href,
  threadMessages: document.querySelectorAll('[data-slot="aui_message"]').length,
  threadMessagesAlt: document.querySelectorAll('[data-message-role]').length,
  threadGroups: document.querySelectorAll('[data-slot="aui_turn-pair"]').length,
  composerText: document.querySelector('[data-slot="composer-rich-input"]')?.innerText?.length || 0,
  visibleArticles: document.querySelectorAll('article').length,
  sidebarSession: document.querySelector('[data-active="true"]')?.textContent?.slice(0,80) || null,
  bodyLen: document.body.innerText.length,
  bodyTail: document.body.innerText.slice(-400)
})`)
console.log(JSON.parse(data))
ws.close()
