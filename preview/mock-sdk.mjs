// Stand-in for the host's @kirocrew/app-sdk, enough for the preview page.
// Every function returned by a hook is module-level, so its identity is stable across
// renders, as the host's should be.
//   ?at=25  starts 25 s into the 60 s worker cycle (25 = awaiting approval, 40 = about to finish)
import { createScenario } from './mock-data.mjs'

const params = new URLSearchParams(globalThis.location?.search || '')
const offsetSec = Math.max(0, Math.min(3600, Number(params.get('at')) || 0))
const scenario = createScenario(Date.now() - offsetSec * 1000)

const api = {
  async get(path) {
    await new Promise((resolve) => setTimeout(resolve, 120))
    if (path.startsWith('/api/chat/slots')) return scenario.slots(Date.now())
    if (path.startsWith('/api/agents')) return { agents: scenario.agents, default_agent: 'default' }
    const last = /^\/api\/apps\/crew-lobby\/last-message\?session=(.+)$/.exec(path)
    if (last) return scenario.lastMessage(decodeURIComponent(last[1]), Date.now())
    throw new Error(`mock: no route for ${path}`)
  },
  async post(path, body) {
    await new Promise((resolve) => setTimeout(resolve, 350))
    const approve = /^\/api\/chat\/slots\/([^/]+)\/approve$/.exec(path)
    if (approve) return scenario.decide(decodeURIComponent(approve[1]), body)
    throw new Error(`mock: no route for ${path}`)
  },
  put: async () => ({}),
  patch: async () => ({}),
  del: async () => ({}),
}

function toast(message, options = {}) {
  const box = document.getElementById('toasts')
  if (!box) return
  const item = document.createElement('div')
  item.className = `toast ${options.type || 'info'}`
  item.textContent = message
  box.appendChild(item)
  setTimeout(() => item.classList.add('out'), 4300)
  setTimeout(() => item.remove(), 4700)
}

const navigate = (path) => toast(`Na Crew isto abriria ${path}`)
const setBadge = (n) => {
  document.title = n ? `(${n}) Crew Lobby · preview` : 'Crew Lobby · preview'
  window.dispatchEvent(new CustomEvent('pv-badge', { detail: n }))
}
const locale = () => params.get('lang') || navigator.language

export function createMockSdk() {
  return {
    useAppApi: () => api,
    useNavigate: () => navigate,
    useNavBadge: () => setBadge,
    useNotify: () => toast,
    useAppEvents: () => {},
    activeLocale: locale,
  }
}
