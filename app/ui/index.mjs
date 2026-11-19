// Crew Lobby: a calm, people-centric lobby for Kiro Crew (POC 0.2.0).
//
// One desk per crewmate (or agent) with presence, what it is doing now, whether it waits on
// your approval or a new instruction, and what finished while you were away (unread).
// One click jumps into the session.
//
// No build step. Like the builtin Agent Worlds app, this module takes React, the app SDK and
// lucide-react from the host through window.__kirocrew_modules, so this file is the whole UI.
// Colors come from the dashboard theme tokens (--bg, --card, --accent, --aim, ...), so the
// lobby follows whichever Crew theme is active.
//
// Read-only: it calls GET /api/chat/slots and GET /api/agents and nothing else. It never
// approves, sends, stops or edits anything.
// shortcut: "unread" lives in this browser's localStorage; upgrade to a server-side
// last_seen per slot so it syncs across devices and clears when opened from the sidebar.

const mods = globalThis.window?.__kirocrew_modules ?? {}
const React = mods.react
const sdk = mods['@kirocrew/app-sdk'] ?? {}
const lucide = mods['lucide-react'] ?? {}
if (!React) throw new Error('[crew-lobby] host React not found in window.__kirocrew_modules')

const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React

// Optional host hooks resolve once at load, so every render calls the same hooks in the same
// order even on a host build that lacks one of them.
const useAppApi = sdk.useAppApi ?? (() => null)
const useNavigate = sdk.useNavigate ?? (() => null)
const useNavBadge = sdk.useNavBadge ?? (() => null)
const useNotify = sdk.useNotify ?? (() => null)
const noop = () => {}
// No live events: an app socket only receives slot events for sessions the app itself owns
// (ws_event_scope "slots:own"), so the user's sessions arrive through the poll below.

// ── Tuning ──────────────────────────────────────────────────────────────────────────────
export const POLL_MS = 4000
const POLL_HIDDEN_MS = 15000
const ROSTER_MS = 60000
const CLOCK_MS = 30000
export const AWAY_AFTER_MS = 15 * 60_000
export const OFFLINE_AFTER_MS = 24 * 3_600_000
export const STALL_AFTER_MS = 10 * 60_000
const SEEN_KEY = 'crew-lobby:seen:v1'
const PREFS_KEY = 'crew-lobby:prefs:v1'
const SEEN_MAX = 400
const PILE_MAX = 6
const DEFAULT_PREFS = { view: 'room', onlyNeeds: false, notifyOn: true }

// Most urgent first. A crewmate shows the most urgent state across its sessions.
export const STATE_ORDER = ['approval', 'question', 'interrupted', 'unread', 'working', 'choice', 'waiting', 'idle']
export const ZONES = ['needs', 'unread', 'working', 'available', 'offline']
const NEEDS = new Set(['approval', 'question', 'interrupted'])
const NOTIFY_ON = new Set(['approval', 'question', 'interrupted', 'unread'])
const PALETTE = ['#7c3aed', '#2563eb', '#0891b2', '#0d9488', '#16a34a', '#d97706', '#db2777', '#9333ea']

// Semantic icon -> lucide-react export name. All of them exist in the host's vendor list.
const ICON_NAMES = {
  approval: 'ShieldAlert', question: 'MessageCircleQuestion', interrupted: 'PauseCircle', unread: 'CheckCircle2',
  working: 'Sparkles', choice: 'ListChecks', waiting: 'MessageSquare', idle: 'Moon',
  'zone-needs': 'BellRing', 'zone-unread': 'Inbox', 'zone-working': 'Zap', 'zone-available': 'Coffee', 'zone-offline': 'Moon',
  online: 'Radio', logo: 'Ghost', open: 'ArrowUpRight', read: 'CheckCheck', chevron: 'ChevronDown', search: 'Search',
  room: 'LayoutGrid', list: 'List', refresh: 'RefreshCw', shield: 'ShieldCheck', clock: 'Clock', timer: 'Timer',
  queue: 'Layers', stall: 'AlertTriangle', pr: 'GitPullRequest', model: 'Cpu', app: 'Puzzle', terminal: 'Terminal',
  close: 'X', peek: 'Eye', approve: 'Check', taskDone: 'CircleCheck', taskTodo: 'Circle', spinner: 'LoaderCircle',
}

// ── Strings ─────────────────────────────────────────────────────────────────────────────
export const STR = {
  pt: {
    title: 'Crew Lobby',
    tagline: 'Quem está na sala, no que está mexendo e o que espera por você.',
    loading: 'Carregando a equipe…',
    live: 'Ao vivo',
    liveOff: 'Sem conexão',
    inRoom: (n) => `${n} na sala agora`,
    nobodyOnline: 'Ninguém na sala agora',
    stats: { online: 'Online agora', needs: 'Aguardando você', unread: 'Não lidas', working: 'Em andamento' },
    units: {
      people: (n) => (n === 1 ? 'colega' : 'colegas'),
      sessions: (n) => (n === 1 ? 'sessão' : 'sessões'),
      replies: (n) => (n === 1 ? 'resposta' : 'respostas'),
    },
    zones: { needs: 'Precisa de você', unread: 'Terminou · não lido', working: 'Trabalhando', available: 'Disponível', offline: 'Offline' },
    states: {
      approval: 'Aguardando aprovação', question: 'Pergunta pra você', interrupted: 'Interrompido', unread: 'Terminou · não lido',
      working: 'Trabalhando', choice: 'Aguardando escolha', waiting: 'Aguardando instrução', idle: 'Ocioso',
    },
    presence: { online: 'Online', away: 'Ausente', offline: 'Offline' },
    cols: { who: 'Colega', state: 'Estado', doing: 'Fazendo agora', when: 'Quando' },
    open: 'Abrir sessão',
    openShort: 'Abrir',
    markRead: 'Marcar lido',
    markAllRead: 'Marcar tudo como lido',
    refresh: 'Atualizar',
    clearFilter: 'Limpar filtro',
    sessions: (n) => `${n} ${n === 1 ? 'sessão' : 'sessões'}`,
    room: 'Sala',
    list: 'Lista',
    onlyNeeds: 'Só o que precisa de mim',
    notify: 'Avisos',
    search: 'Buscar colega ou sessão…',
    ago: (d) => (d ? `há ${d}` : 'agora'),
    workingFor: (d) => (d ? `trabalhando há ${d}` : 'começou agora'),
    waitingSince: (d) => (d ? `esperando há ${d}` : 'esperando agora'),
    finishedAgo: (d) => (d ? `terminou há ${d}` : 'terminou agora'),
    stalled: (d) => `sem saída há ${d}`,
    otherStalled: (n) => `${n} ${n === 1 ? 'outra sessão' : 'outras sessões'} sem saída há 10+ min`,
    steps: (done, total) => `${done}/${total} passos`,
    queue: (n) => `+${n} na fila`,
    options: (n) => `${n} ${n === 1 ? 'opção sugerida' : 'opções sugeridas'}`,
    wantsToRun: (tool) => `Quer executar ${tool}`,
    awaitingApproval: 'Aguardando sua aprovação para continuar',
    askedQuestion: 'Fez uma pergunta e aguarda sua resposta',
    working: 'Trabalhando…',
    compacting: 'Compactando o contexto',
    interruptedHint: 'O turno foi interrompido. Abra a sessão para retomar.',
    noActivity: 'Sem atividade ainda',
    noSessions: 'Sem sessão aberta',
    via: (app) => `via ${app}`,
    unreadTitle: 'Respostas que você ainda não viu',
    updatedAt: (t) => `Atualizado às ${t}`,
    footNote: 'Só aprova ou nega um pedido quando você clica. Não envia mensagens nem para sessões.',
    approve: 'Aprovar',
    deny: 'Negar',
    approving: 'Aprovando…',
    denying: 'Negando…',
    decidedApproved: 'Pedido aprovado',
    decidedDenied: 'Pedido negado',
    decideInSession: 'Pedido de um processo em segundo plano: decida na sessão.',
    decideForbidden: 'A Crew recusou: ative o app aceitando o controle dos chats.',
    decideGone: 'Esse pedido já foi decidido ou expirou.',
    decideFailed: 'Não consegui decidir',
    peek: 'Espiar',
    peekTitle: 'Espiando',
    peekNow: 'Agora',
    peekApproval: 'Pedido de aprovação',
    peekLoading: 'Carregando a mensagem completa…',
    peekCut: 'Mensagem longa: mostrando o começo. Abra a sessão para ler o resto.',
    peekPrivate: 'Sessão privada: aqui aparece só a prévia.',
    peekPreviewOnly: 'Só a prévia de 80 caracteres: a mensagem completa não carregou.',
    readMore: 'Ler a mensagem inteira',
    peekOptions: 'Opções sugeridas',
    peekPlan: 'Plano',
    peekLast: 'Última mensagem',
    peekOther: 'Outras sessões',
    peekHint: 'Atualiza a cada 4 s.',
    close: 'Fechar',
    error: 'Não consegui ler as sessões',
    retry: 'Tentar de novo',
    empty: 'Ninguém por aqui ainda. Abra uma sessão e o colega aparece no lobby.',
    emptyFiltered: 'Nada por aqui com esse filtro.',
    noSdk: 'SDK de apps do host indisponível',
    notifyMsg: {
      approval: (who) => `${who} aguarda sua aprovação`,
      question: (who) => `${who} tem uma pergunta`,
      interrupted: (who) => `${who} foi interrompido`,
      unread: (who) => `${who} terminou`,
    },
    notifyMany: (n) => `${n} sessões mudaram e precisam da sua atenção`,
  },
  en: {
    title: 'Crew Lobby',
    tagline: 'Who is in the room, what they are on, and what is waiting for you.',
    loading: 'Loading your crew…',
    live: 'Live',
    liveOff: 'Disconnected',
    inRoom: (n) => `${n} in the room now`,
    nobodyOnline: 'Nobody in the room right now',
    stats: { online: 'Online now', needs: 'Waiting on you', unread: 'Unread', working: 'In progress' },
    units: {
      people: (n) => (n === 1 ? 'crewmate' : 'crewmates'),
      sessions: (n) => (n === 1 ? 'session' : 'sessions'),
      replies: (n) => (n === 1 ? 'reply' : 'replies'),
    },
    zones: { needs: 'Needs you', unread: 'Finished · unread', working: 'Working', available: 'Available', offline: 'Offline' },
    states: {
      approval: 'Awaiting approval', question: 'Has a question', interrupted: 'Interrupted', unread: 'Finished · unread',
      working: 'Working', choice: 'Waiting for a choice', waiting: 'Waiting for instructions', idle: 'Idle',
    },
    presence: { online: 'Online', away: 'Away', offline: 'Offline' },
    cols: { who: 'Crewmate', state: 'State', doing: 'Doing now', when: 'When' },
    open: 'Open session',
    openShort: 'Open',
    markRead: 'Mark read',
    markAllRead: 'Mark all read',
    refresh: 'Refresh',
    clearFilter: 'Clear filter',
    sessions: (n) => `${n} ${n === 1 ? 'session' : 'sessions'}`,
    room: 'Room',
    list: 'List',
    onlyNeeds: 'Only what needs me',
    notify: 'Alerts',
    search: 'Search crewmate or session…',
    ago: (d) => (d ? `${d} ago` : 'just now'),
    workingFor: (d) => (d ? `working for ${d}` : 'just started'),
    waitingSince: (d) => (d ? `waiting for ${d}` : 'waiting now'),
    finishedAgo: (d) => (d ? `finished ${d} ago` : 'just finished'),
    stalled: (d) => `no output for ${d}`,
    otherStalled: (n) => `${n} other ${n === 1 ? 'session' : 'sessions'} with no output for 10+ min`,
    steps: (done, total) => `${done}/${total} steps`,
    queue: (n) => `+${n} queued`,
    options: (n) => `${n} suggested ${n === 1 ? 'option' : 'options'}`,
    wantsToRun: (tool) => `Wants to run ${tool}`,
    awaitingApproval: 'Waiting for your approval to continue',
    askedQuestion: 'Asked a question and waits for your answer',
    working: 'Working…',
    compacting: 'Compacting context',
    interruptedHint: 'The turn was interrupted. Open the session to resume.',
    noActivity: 'No activity yet',
    noSessions: 'No open session',
    via: (app) => `via ${app}`,
    unreadTitle: 'Replies you have not seen yet',
    updatedAt: (t) => `Updated at ${t}`,
    footNote: 'Approves or denies a request only when you click. Never sends messages or stops sessions.',
    approve: 'Approve',
    deny: 'Deny',
    approving: 'Approving…',
    denying: 'Denying…',
    decidedApproved: 'Request approved',
    decidedDenied: 'Request denied',
    decideInSession: 'Raised by a background process: decide it in the session.',
    decideForbidden: 'Kiro Crew refused: enable the app and accept chat control.',
    decideGone: 'That request was already decided or expired.',
    decideFailed: 'Could not decide',
    peek: 'Peek',
    peekTitle: 'Peeking',
    peekNow: 'Now',
    peekApproval: 'Approval request',
    peekLoading: 'Loading the full message…',
    peekCut: 'Long message: showing the beginning. Open the session to read the rest.',
    peekPrivate: 'Private session: only the preview shows here.',
    peekPreviewOnly: 'Only the 80-character preview: the full message did not load.',
    readMore: 'Read the whole message',
    peekOptions: 'Suggested options',
    peekPlan: 'Plan',
    peekLast: 'Latest message',
    peekOther: 'Other sessions',
    peekHint: 'Refreshes every 4 s.',
    close: 'Close',
    error: 'Could not read sessions',
    retry: 'Retry',
    empty: 'Nobody here yet. Open a session and its crewmate shows up in the lobby.',
    emptyFiltered: 'Nothing matches this filter.',
    noSdk: 'Host app SDK unavailable',
    notifyMsg: {
      approval: (who) => `${who} is waiting for your approval`,
      question: (who) => `${who} has a question`,
      interrupted: (who) => `${who} was interrupted`,
      unread: (who) => `${who} finished`,
    },
    notifyMany: (n) => `${n} sessions changed and need your attention`,
  },
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────────────────

/** Epoch milliseconds from the slot projection's mixed formats (epoch s/ms, ISO text). */
export function toMs(value) {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'number') return Number.isFinite(value) ? (value > 1e11 ? value : value * 1000) : 0
  const text = String(value).trim()
  if (/^\d+(\.\d+)?$/.test(text)) return toMs(Number(text))
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? 0 : parsed
}

/** "12 min" / "3 h" / "2 d"; '' under a minute; null when the instant is unknown. */
export function duration(fromMs, now) {
  if (!fromMs) return null
  const minutes = Math.floor(Math.max(0, now - fromMs) / 60_000)
  if (minutes < 1) return ''
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.floor(hours / 24)} d`
}

function cleanText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function slugify(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** "devops-agent" -> "Devops Agent", for agents that have no roster display name. */
export function prettyName(id) {
  const words = String(id || '').split(/[-_.\s]+/).filter(Boolean)
  return words.length ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') : String(id || '?')
}

/** Crewmate DM threads are keyed "member-<slug>.<memory store>". */
export function memberSlugOf(key) {
  if (typeof key !== 'string' || !key.startsWith('member-')) return ''
  return key.slice('member-'.length).split('.')[0]
}

export function isBusy(slot) {
  return Boolean(
    slot.running || slot.compacting || slot.preparing || slot.wake_starting || slot.subagents_running || slot.orchestrating,
  )
}

/** One session's state, from the fields GET /api/chat/slots already projects. */
export function sessionState(slot, seenTs = 0) {
  if (slot.pending_approval) return 'approval'
  if (slot.needs_input) return 'question'
  if (isBusy(slot)) return 'working'
  if (slot.interrupted) return 'interrupted'
  const agentTs = toMs(slot.last_agent_ts)
  if (!slot.muted && agentTs > seenTs) return 'unread'
  if (slot.has_options) return 'choice'
  if (slot.waiting_for_input) return 'waiting'
  return 'idle'
}

/** A session first seen by the lobby counts as read at its current reply. */
export function withSeenDefaults(seen, slots) {
  const out = { ...(seen && typeof seen === 'object' ? seen : {}) }
  for (const slot of slots || []) {
    if (slot && typeof slot.key === 'string' && !Object.hasOwn(out, slot.key)) out[slot.key] = toMs(slot.last_agent_ts)
  }
  return out
}

function pruneSeen(seen, slots) {
  const live = new Set((slots || []).map((slot) => slot?.key).filter(Boolean))
  return Object.fromEntries(Object.entries(seen).filter(([key]) => live.has(key)).slice(-SEEN_MAX))
}

// Only url/number/kind: the host withholds CI status (`ci`, `state`) from app tokens.
function linksOf(slot) {
  if (!Array.isArray(slot.source_links)) return []
  return slot.source_links
    .filter((link) => link && /^https?:\/\//i.test(String(link.url || '')))
    .slice(0, 2)
    .map((link) => ({ label: `${link.kind === 'issue' ? '#' : 'PR #'}${link.number}`, url: String(link.url) }))
}

/**
 * The pending tool request as the slot projection ships it. Only a NATIVE request (the chat's
 * own approval card: origin "native" + request_id + request_mid) can be decided by an app; a
 * coordinator request from a background source answers 404 to app callers.
 */
export function approvalOf(info) {
  if (!info || typeof info !== 'object') return null
  const requestId = typeof info.request_id === 'string' ? info.request_id : ''
  const requestMid = typeof info.request_mid === 'string' ? info.request_mid : ''
  return {
    tool: cleanText(info.tool),
    purpose: cleanText(info.tool_purpose),
    input: typeof info.tool_input === 'string' ? info.tool_input.trim().slice(0, 4000) : '',
    requestId,
    requestMid,
    native: info.origin === 'native' && Boolean(requestId) && Boolean(requestMid),
  }
}

function tasksOf(todo) {
  if (!todo || !Array.isArray(todo.tasks)) return []
  return todo.tasks
    .filter((task) => task && typeof task === 'object')
    .slice(0, 40)
    .map((task) => ({ text: cleanText(task.text), done: Boolean(task.completed) }))
    .filter((task) => task.text)
}

/** The command an approval would run: `command` from a JSON tool_input, else the raw input. */
export function commandOf(approval) {
  const raw = approval && typeof approval.input === 'string' ? approval.input.trim() : ''
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      for (const key of ['command', 'cmd', 'script']) {
        if (typeof parsed[key] === 'string' && parsed[key].trim()) return parsed[key].trim()
      }
    }
  } catch {
    // Not JSON: show the input as the agent sent it.
  }
  return raw
}

/** Approve/Deny is offered only for the chat's own pending request. */
export function canDecide(se) {
  return Boolean(se && se.state === 'approval' && se.approval && se.approval.native)
}

/** A short, user-facing reason for a refused Approve/Deny. */
export function decisionError(err, s) {
  const status = Number(err && (err.status ?? err.statusCode ?? err.response?.status)) || 0
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  if (status === 403 || /\b403\b|forbidden|may not control|consent/i.test(text)) return s.decideForbidden
  if (status === 404 || /\b404\b|not found|not_found|not_pending/i.test(text)) return s.decideGone
  return text ? `${s.decideFailed}: ${text}` : s.decideFailed
}

/** The crewmate and session behind a slot key, or null. */
export function findSession(lobby, key) {
  if (!lobby || !key) return null
  for (const person of lobby.colleagues) {
    const se = person.sessions.find((item) => item.key === key)
    if (se) return { person, se }
  }
  return null
}

function describeSession(slot, state, now) {
  const approval = slot.pending_approval_info && typeof slot.pending_approval_info === 'object' ? slot.pending_approval_info : null
  const todo = slot.todo && typeof slot.todo === 'object' ? slot.todo : null
  const activityTs = Math.max(toMs(slot.last_activity_ts), toMs(slot.last_ts), toMs(slot.created))
  const agentTs = toMs(slot.last_agent_ts)
  const turnTs = toMs(slot.last_turn_ts)
  let sinceTs = activityTs
  if (state === 'working') sinceTs = turnTs || activityTs
  else if (state === 'unread' || state === 'waiting' || state === 'choice') sinceTs = agentTs || activityTs
  return {
    key: slot.key,
    title: cleanText(slot.title) || slot.key,
    state,
    activityTs,
    agentTs,
    sinceTs,
    stalled: state === 'working' && !slot.compacting && activityTs > 0 && now - activityTs > STALL_AFTER_MS,
    compacting: Boolean(slot.compacting),
    preview: cleanText(slot.last_message),
    promptPreview: cleanText(slot.prompt_preview),
    options: Array.isArray(slot.options) ? slot.options.length : 0,
    queue: Number(slot.queue_depth) || 0,
    approvalTool: approval ? cleanText(approval.tool) : '',
    approvalPurpose: approval ? cleanText(approval.tool_purpose) : '',
    approval: approvalOf(approval),
    todo:
      todo && Number(todo.total) > 0
        ? { done: Number(todo.completed) || 0, total: Number(todo.total) || 0, current: cleanText(todo.current) }
        : null,
    tasks: tasksOf(todo),
    optionList: Array.isArray(slot.options) ? slot.options.map((option) => cleanText(option)).filter(Boolean).slice(0, 8) : [],
    links: linksOf(slot),
    model: cleanText(slot.served_model) || cleanText(slot.model),
    app: cleanText(slot.app),
  }
}

export function presenceOf(person, now) {
  if (!person.sessions.length) return 'offline'
  if (person.sessions.some((se) => se.state === 'working' || se.state === 'approval' || se.state === 'question')) return 'online'
  const age = now - person.lastActivity
  if (person.lastActivity && age < AWAY_AFTER_MS) return 'online'
  if (person.lastActivity && age < OFFLINE_AFTER_MS) return 'away'
  return 'offline'
}

export function zoneOf(person) {
  if (NEEDS.has(person.state)) return 'needs'
  if (person.state === 'unread') return 'unread'
  if (person.state === 'working') return 'working'
  return person.presence === 'offline' ? 'offline' : 'available'
}

function initialsOf(name) {
  const words = String(name || '?').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  const text = words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)
  return text.toUpperCase()
}

/**
 * The crewmate's own color: its icon avatar `bg`, then its `session_color` (both are in the
 * GET /api/agents row an app receives), else a stable palette pick.
 */
function colorFor(person) {
  const av = person.avatar && typeof person.avatar === 'object' ? person.avatar : {}
  for (const own of [av.bg, person.sessionColor]) {
    if (typeof own === 'string' && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(own)) return own
  }
  let hash = 0
  for (const ch of person.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[hash % PALETTE.length]
}

/** Dark initials on light avatar colors, white on the rest (WCAG relative luminance). */
export function inkFor(hex) {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})(?:[0-9a-f]{2})?$/i.exec(String(hex || '').trim())
  if (!m) return '#fff'
  const full = m[1].length === 3 ? m[1].split('').map((ch) => ch + ch).join('') : m[1]
  const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const [r, g, b] = [0, 2, 4].map((i) => lin(parseInt(full.slice(i, i + 2), 16) / 255))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.42 ? '#1b1d24' : '#fff'
}

function finishPerson(person, now) {
  const order = (state) => STATE_ORDER.indexOf(state)
  person.sessions.sort((a, b) => order(a.state) - order(b.state) || b.activityTs - a.activityTs)
  const focus = person.sessions[0] ?? null
  const done = {
    ...person,
    focus,
    state: focus ? focus.state : 'idle',
    lastActivity: person.sessions.reduce((max, se) => Math.max(max, se.activityTs), 0),
    needsCount: person.sessions.filter((se) => NEEDS.has(se.state)).length,
    unreadCount: person.sessions.filter((se) => se.state === 'unread').length,
    workingCount: person.sessions.filter((se) => se.state === 'working').length,
    initials: initialsOf(person.displayName),
  }
  done.presence = presenceOf(done, now)
  done.zone = zoneOf(done)
  done.color = colorFor(done)
  done.ink = inkFor(done.color)
  return done
}

function byUrgency(a, b) {
  return (
    ZONES.indexOf(a.zone) - ZONES.indexOf(b.zone) ||
    STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) ||
    b.lastActivity - a.lastActivity ||
    a.displayName.localeCompare(b.displayName)
  )
}

/**
 * Group live sessions into crewmates.
 *
 * A session belongs to: the crewmate whose DM thread it is (key "member-<slug>…"), else the
 * crewmate whose session opened it (`created_by`, followed up to 4 hops), else its agent.
 * Crew roster rows from GET /api/agents with no session show up as offline.
 */
export function buildLobby({ slots = [], agents = [], seen = {}, now = Date.now() } = {}) {
  const people = new Map()
  const bySlug = new Map()

  const personFor = (id, row) => {
    let person = people.get(id)
    if (!person) {
      person = { id, name: id, displayName: prettyName(id), description: '', kiroAgent: '', avatar: null, sessionColor: '', inRoster: false, sessions: [] }
      people.set(id, person)
    }
    if (row && !person.inRoster) {
      person.inRoster = true
      person.displayName = cleanText(row.display_name) || prettyName(row.name)
      person.description = cleanText(row.description)
      person.kiroAgent = cleanText(row.kiro_agent)
      person.avatar = row.avatar && typeof row.avatar === 'object' ? row.avatar : null
      person.sessionColor = cleanText(row.session_color)
    }
    return person
  }

  for (const row of agents || []) {
    if (!row || typeof row.name !== 'string' || !row.name) continue
    if (row.scope === 'project') continue // project agent definitions, not crewmates
    personFor(row.name, row)
    bySlug.set(slugify(row.name), row.name)
  }

  const byKey = new Map((slots || []).filter((slot) => slot && typeof slot.key === 'string').map((slot) => [slot.key, slot]))
  const ownerOf = (slot, depth = 0) => {
    const slug = memberSlugOf(slot.key)
    if (slug) return bySlug.get(slug) || slug
    if (slot.created_by && depth < 4) {
      const parent = byKey.get(slot.created_by)
      if (parent) return ownerOf(parent, depth + 1)
      const parentSlug = memberSlugOf(slot.created_by)
      if (parentSlug) return bySlug.get(parentSlug) || parentSlug
    }
    return cleanText(slot.agent) || cleanText(slot.effective_agent) || 'default'
  }

  for (const slot of byKey.values()) {
    if (slot.key.startsWith('_')) continue // gateway-internal slots such as _optimizer
    const state = sessionState(slot, Number(seen?.[slot.key]) || 0)
    personFor(ownerOf(slot)).sessions.push(describeSession(slot, state, now))
  }

  const colleagues = [...people.values()].map((person) => finishPerson(person, now)).sort(byUrgency)
  const counts = { online: 0, needs: 0, unread: 0, working: 0, total: colleagues.length }
  for (const c of colleagues) {
    if (c.presence === 'online') counts.online++
    counts.needs += c.needsCount
    counts.unread += c.unreadCount
    counts.working += c.workingCount
  }
  return { colleagues, counts, generatedAt: now }
}

/** The "what is it doing" line for a session. */
export function activityLine(se, s) {
  if (!se) return s.noSessions
  switch (se.state) {
    case 'approval':
      if (!se.approvalTool) return s.awaitingApproval
      return se.approvalPurpose ? `${s.wantsToRun(se.approvalTool)}: ${se.approvalPurpose}` : s.wantsToRun(se.approvalTool)
    case 'question':
      return se.preview || s.askedQuestion
    case 'working':
      if (se.compacting) return s.compacting
      return se.todo?.current || se.preview || s.working
    case 'interrupted':
      return s.interruptedHint
    case 'choice':
      return se.promptPreview || se.preview || s.options(se.options)
    default:
      return se.preview || s.noActivity
  }
}

function matches(person, query) {
  if (person.displayName.toLowerCase().includes(query) || person.name.toLowerCase().includes(query)) return true
  return person.sessions.some((se) => se.title.toLowerCase().includes(query))
}

/** Stat-card filter: a crewmate passes when at least one of its sessions is in that bucket. */
function passesFilter(c, filter) {
  if (filter === 'online') return c.presence === 'online'
  if (filter === 'needs') return c.needsCount > 0
  if (filter === 'unread') return c.unreadCount > 0
  if (filter === 'working') return c.workingCount > 0
  return true
}

function pickLang() {
  let locale = ''
  try {
    locale = typeof sdk.activeLocale === 'function' ? sdk.activeLocale() : sdk.activeLocale
  } catch {
    locale = ''
  }
  if (typeof locale !== 'string' || !locale) locale = globalThis.navigator?.language || 'en'
  return locale.toLowerCase().startsWith('pt') ? 'pt' : 'en'
}

function clock(ms, lang) {
  return new Date(ms).toLocaleTimeString(lang === 'pt' ? 'pt-BR' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function loadJSON(key, fallback) {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    const value = raw ? JSON.parse(raw) : null
    return value && typeof value === 'object' ? value : fallback
  } catch {
    return fallback
  }
}

function saveJSON(key, value) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value))
  } catch {
    // Storage blocked or full: unread state just does not persist across reloads.
  }
}

const domId = (id) => `cl-desk-${slugify(id) || 'x'}`

// ── View: pure functions of props (no hooks), so tests can walk the tree ────────────────

function Icon({ name, size = 16, className = '' }) {
  const Comp = lucide[ICON_NAMES[name]]
  if (!Comp) return null
  return h(Comp, { size, strokeWidth: 2, className: className ? `cl-ico ${className}` : 'cl-ico', 'aria-hidden': 'true', focusable: 'false' })
}
const hasIcon = (name) => Boolean(lucide[ICON_NAMES[name]])

function Avatar({ c, size = 44, ring = true }) {
  return h(
    'span',
    { className: `cl-av cl-st-${c.state}`, style: { '--cl-c': c.color, '--cl-size': `${size}px`, color: c.ink }, 'aria-hidden': 'true' },
    ring ? h('span', { className: 'cl-av-ring' }) : null,
    h('span', { className: 'cl-av-face' }, c.initials),
    h('span', { className: `cl-av-dot cl-pr-${c.presence}` }),
  )
}

function StateChip({ state, s, compact = false }) {
  return h(
    'span',
    { className: `cl-chip cl-st-${state}${compact ? ' is-compact' : ''}` },
    h(Icon, { name: state, size: compact ? 12 : 13 }),
    h('span', null, s.states[state]),
  )
}

function UnreadBadge({ n, s }) {
  return n ? h('span', { className: 'cl-badge', title: s.unreadTitle }, String(n)) : null
}

function Typing() {
  return h('span', { className: 'cl-typing', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))
}

function Progress({ todo, s }) {
  const pct = todo.total ? Math.min(100, Math.round((todo.done / todo.total) * 100)) : 0
  return h(
    'div',
    { className: 'cl-progress', title: todo.current || '' },
    h('div', { className: 'cl-progress-track' }, h('i', { style: { width: `${pct}%` } })),
    h('span', { className: 'cl-progress-label' }, s.steps(todo.done, todo.total)),
  )
}

// Speech bubble: the Habbo nod. Title of the session, then what it is doing.
// Click the bubble to read the whole message in Peek.
function Bubble({ se, s, onPeek = noop }) {
  if (!se) return h('div', { className: 'cl-bubble is-empty' }, h('div', { className: 'cl-bubble-text' }, s.noSessions))
  const approval = se.state === 'approval' && se.approvalTool
  const cmd = approval ? commandOf(se.approval) : ''
  const said = approval && cmd && se.approvalPurpose ? `${s.wantsToRun(se.approvalTool)}: ${se.approvalPurpose}` : approval ? s.wantsToRun(se.approvalTool) : activityLine(se, s)
  const code = approval ? cmd || se.approvalPurpose : ''
  const peek = () => onPeek(se.key)
  return h(
    'div',
    {
      className: 'cl-bubble is-clickable',
      role: 'button',
      tabIndex: 0,
      title: s.readMore,
      onClick: peek,
      onKeyDown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          peek()
        }
      },
    },
    h(
      'div',
      { className: 'cl-bubble-head' },
      h('span', { className: 'cl-bubble-session', title: se.title }, se.title),
      se.app ? h('span', { className: 'cl-tag' }, h(Icon, { name: 'app', size: 11 }), s.via(se.app)) : null,
      se.state === 'working' && !se.compacting ? h(Typing) : null,
    ),
    h('div', { className: 'cl-bubble-text' }, said),
    code ? h('div', { className: 'cl-cmd', title: code }, h(Icon, { name: 'terminal', size: 13 }), h('code', null, code)) : null,
  )
}

function fact(key, icon, text, extra = '') {
  return h('span', { key, className: `cl-fact${extra ? ` ${extra}` : ''}` }, h(Icon, { name: icon, size: 13 }), h('span', null, text))
}

function sinceText(se, since, s) {
  if (se.state === 'working') return s.workingFor(since)
  if (se.state === 'approval' || se.state === 'question') return s.waitingSince(since)
  if (se.state === 'unread') return s.finishedAgo(since)
  return s.ago(since)
}

function facts(se, s, now, otherStalled = 0) {
  const out = []
  const since = duration(se.sinceTs, now)
  if (since !== null) out.push(fact('since', se.state === 'working' ? 'timer' : 'clock', sinceText(se, since, s)))
  if (se.queue) out.push(fact('queue', 'queue', s.queue(se.queue)))
  if (se.stalled) out.push(fact('stall', 'stall', s.stalled(duration(se.activityTs, now)), 'is-warn'))
  if (otherStalled) out.push(fact('stall-other', 'stall', s.otherStalled(otherStalled), 'is-warn'))
  for (const link of se.links) {
    out.push(
      h(
        'a',
        { key: link.url, className: 'cl-fact cl-pr', href: link.url, target: '_blank', rel: 'noreferrer noopener' },
        h(Icon, { name: 'pr', size: 13 }),
        h('span', null, link.label),
      ),
    )
  }
  if (se.model) out.push(fact('model', 'model', se.model, 'is-model'))
  return out
}

function PeekButton({ s, onClick, label = false }) {
  return h(
    'button',
    { type: 'button', className: label ? 'cl-btn cl-btn-ghost' : 'cl-icon-btn cl-icon-btn-sm', title: s.peek, 'aria-label': s.peek, 'data-peek': '', onClick },
    h(Icon, { name: 'peek', size: label ? 15 : 14 }),
    label ? h('span', null, s.peek) : null,
  )
}

// Approve / Deny for the chat's own pending request. `busy` is the action in flight, if any.
// Deny sends `rejected_once`, the same answer the dashboard's own Deny button sends.
function DecideButtons({ se, s, busy, onDecide, compact = false }) {
  if (!canDecide(se)) return null
  const size = compact ? 13 : 15
  const button = (action, cls, icon, label, working) =>
    h(
      'button',
      { type: 'button', className: `cl-btn ${cls}`, disabled: Boolean(busy), title: label, 'aria-label': label, onClick: () => onDecide(se.key, action) },
      h(Icon, { name: busy === action ? 'spinner' : icon, size, className: busy === action ? 'cl-spin' : '' }),
      compact ? null : h('span', null, busy === action ? working : label),
    )
  return h(
    'span',
    { className: `cl-decide${compact ? ' is-compact' : ''}` },
    button('approved', 'cl-btn-approve', 'approve', s.approve, s.approving),
    button('rejected_once', 'cl-btn-deny', 'close', s.deny, s.denying),
  )
}

function SessionRow({ se, s, now, onOpen, onPeek = noop }) {
  const since = duration(se.sinceTs, now)
  const when = se.stalled ? s.stalled(duration(se.activityTs, now)) : since === null ? '' : s.ago(since)
  return h(
    'li',
    { className: 'cl-session' },
    h(StateChip, { state: se.state, s, compact: true }),
    h('span', { className: 'cl-session-title', title: activityLine(se, s) }, se.title),
    h('span', { className: `cl-session-when${se.stalled ? ' is-warn' : ''}` }, when),
    h(
      'span',
      { className: 'cl-session-act' },
      h(PeekButton, { s, onClick: () => onPeek(se.key) }),
      h('button', { type: 'button', className: 'cl-btn cl-btn-tonal cl-btn-xs', onClick: () => onOpen(se.key) }, h('span', null, s.openShort), h(Icon, { name: 'open', size: 12 })),
    ),
  )
}

function metaLine(c, s) {
  const alias = c.inRoster && c.kiroAgent && c.kiroAgent !== c.name ? c.kiroAgent : c.displayName !== c.name ? c.name : ''
  return [s.presence[c.presence], alias, c.sessions.length ? s.sessions(c.sessions.length) : ''].filter(Boolean).join(' · ')
}

function DeskCard({ c, s, now, index = 0, expanded, onToggle, onOpen, onMarkRead, onPeek = noop, onDecide = noop, deciding = {} }) {
  const f = c.focus
  const unreadKeys = c.sessions.filter((se) => se.state === 'unread').map((se) => se.key)
  const otherStalled = c.sessions.filter((se) => se !== f && se.stalled).length
  return h(
    'article',
    {
      id: domId(c.id),
      className: `cl-desk cl-st-${c.state}`,
      style: { '--i': Math.min(index, 12) },
      tabIndex: 0,
      'aria-label': `${c.displayName}: ${s.states[c.state]}`,
      onKeyDown: (event) => {
        if (event.key === 'Enter' && f && event.target === event.currentTarget) onOpen(f.key)
      },
    },
    h(
      'header',
      { className: 'cl-desk-head' },
      h(Avatar, { c }),
      h(
        'div',
        { className: 'cl-desk-id' },
        h(
          'div',
          { className: 'cl-name', title: c.description || c.displayName },
          h('span', { className: 'cl-name-text' }, c.displayName),
          h(UnreadBadge, { n: c.unreadCount, s }),
        ),
        h('div', { className: 'cl-meta' }, metaLine(c, s)),
      ),
      h(StateChip, { state: c.state, s }),
    ),
    h(Bubble, { se: f, s, onPeek }),
    f && f.todo ? h(Progress, { todo: f.todo, s }) : null,
    f ? h('div', { className: 'cl-facts' }, facts(f, s, now, otherStalled)) : null,
    h(
      'footer',
      { className: 'cl-actions' },
      canDecide(f)
        ? [
            h(DecideButtons, { key: 'decide', se: f, s, busy: deciding[f.key], onDecide }),
            h(PeekButton, { key: 'peek', s, onClick: () => onPeek(f.key) }),
            h('button', { key: 'open', type: 'button', className: 'cl-icon-btn cl-icon-btn-sm', title: s.open, 'aria-label': s.open, onClick: () => onOpen(f.key) }, h(Icon, { name: 'open', size: 14 })),
          ]
        : f
          ? [
              h('button', { key: 'open', type: 'button', className: 'cl-btn cl-btn-primary', onClick: () => onOpen(f.key) }, h('span', null, s.open), h(Icon, { name: 'open', size: 15 })),
              h(PeekButton, { key: 'peek', s, label: true, onClick: () => onPeek(f.key) }),
            ]
          : null,
      unreadKeys.length
        ? h('button', { type: 'button', className: 'cl-btn cl-btn-tonal', onClick: () => onMarkRead(unreadKeys) }, h(Icon, { name: 'read', size: 15 }), h('span', null, s.markRead))
        : null,
      c.sessions.length > 1
        ? h(
            'button',
            { type: 'button', className: `cl-btn cl-btn-ghost cl-more${expanded ? ' is-open' : ''}`, 'aria-expanded': expanded ? 'true' : 'false', onClick: () => onToggle(c.id) },
            h('span', null, s.sessions(c.sessions.length)),
            hasIcon('chevron') ? h(Icon, { name: 'chevron', size: 15, className: 'cl-chev' }) : h('span', null, expanded ? '▴' : '▾'),
          )
        : null,
    ),
    expanded && c.sessions.length > 1
      ? h('ul', { className: 'cl-sessions' }, c.sessions.map((se) => h(SessionRow, { key: se.key, se, s, now, onOpen, onPeek })))
      : null,
  )
}

function OfflineChip({ c, s, now, onOpen }) {
  const since = duration(c.lastActivity, now)
  const when = since === null ? s.noSessions : s.ago(since)
  return h(
    'button',
    {
      type: 'button',
      className: 'cl-off',
      disabled: !c.focus,
      title: c.description ? `${c.displayName} · ${c.description}` : c.displayName,
      onClick: () => c.focus && onOpen(c.focus.key),
    },
    h(Avatar, { c, size: 30, ring: false }),
    h('span', { className: 'cl-off-text' }, h('span', { className: 'cl-off-name' }, c.displayName), h('span', { className: 'cl-off-when' }, when)),
  )
}

function ListRow({ c, s, now, onOpen, onPeek = noop, onDecide = noop, deciding = {} }) {
  const f = c.focus
  const since = f ? duration(f.sinceTs, now) : null
  return h(
    'div',
    { id: domId(c.id), className: `cl-row cl-st-${c.state}`, role: 'listitem' },
    h(Avatar, { c, size: 34 }),
    h(
      'div',
      { className: 'cl-row-who' },
      h('div', { className: 'cl-name' }, h('span', { className: 'cl-name-text' }, c.displayName), h(UnreadBadge, { n: c.unreadCount, s })),
      h('div', { className: 'cl-meta' }, metaLine(c, s)),
    ),
    h('div', { className: 'cl-row-state' }, h(StateChip, { state: c.state, s })),
    h(
      'div',
      { className: 'cl-row-doing', title: f ? activityLine(f, s) : '' },
      f ? h('span', { className: 'cl-row-session' }, f.title) : null,
      h('span', { className: 'cl-row-activity' }, f ? activityLine(f, s) : s.noSessions),
    ),
    h('div', { className: 'cl-row-when' }, since === null ? '' : s.ago(since)),
    h(
      'div',
      { className: 'cl-row-act' },
      f ? h(DecideButtons, { se: f, s, busy: deciding[f.key], onDecide, compact: true }) : null,
      f ? h(PeekButton, { s, onClick: () => onPeek(f.key) }) : null,
      f ? h('button', { type: 'button', className: 'cl-btn cl-btn-tonal cl-btn-xs', onClick: () => onOpen(f.key) }, h('span', null, s.openShort), h(Icon, { name: 'open', size: 12 })) : null,
    ),
  )
}

function ListView({ list, s, now, onOpen, onPeek, onDecide, deciding }) {
  return h(
    'div',
    { className: 'cl-table' },
    h(
      'div',
      { className: 'cl-thead', 'aria-hidden': 'true' },
      h('span'),
      h('span', null, s.cols.who),
      h('span', null, s.cols.state),
      h('span', null, s.cols.doing),
      h('span', null, s.cols.when),
      h('span'),
    ),
    h('div', { role: 'list' }, list.map((c) => h(ListRow, { key: c.id, c, s, now, onOpen, onPeek, onDecide, deciding }))),
  )
}

const peekSec = (key, title, ...children) =>
  h('section', { key, className: 'cl-peek-sec' }, title ? h('h4', { className: 'cl-peek-h' }, title) : null, ...children)

// ── Markdown-lite: the subset agent replies use, built as elements (never innerHTML) ─────
const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\))/g

/** The [OPTIONS: …] marker line is shown as chips elsewhere, so it is dropped from text. */
export function stripOptions(text) {
  return String(text || '').replace(/^[ \t]*\[OPTIONS:[^\n]*\][ \t]*$/gm, '').trim()
}

function inline(text, keyBase) {
  const out = []
  let last = 0
  let i = 0
  for (const m of String(text).matchAll(INLINE_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const key = `${keyBase}-${i++}`
    if (m[1]) out.push(h('code', { key, className: 'cl-md-code' }, m[1].slice(1, -1)))
    else if (m[2]) out.push(h('strong', { key }, m[2].slice(2, -2)))
    else out.push(h('a', { key, href: m[5], target: '_blank', rel: 'noreferrer noopener' }, m[4]))
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const cellsOf = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())

/** Blocks of a reply: paragraphs, headings, lists, fenced code and pipe tables. */
export function parseBlocks(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let para = null
  let list = null
  let table = null
  const flush = () => {
    for (const block of [para, list, table]) if (block) blocks.push(block)
    para = list = table = null
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      flush()
      const code = []
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i])
      blocks.push({ type: 'code', text: code.join('\n') })
      continue
    }
    const heading = /^\s{0,3}#{1,6}\s+(.+)$/.exec(line)
    const item = /^\s{0,6}([-*+]|\d+[.)])\s+(.+)$/.exec(line)
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (!table) flush()
      table = table || { type: 'table', rows: [] }
      if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(line)) table.rows.push(cellsOf(line))
    } else if (!line.trim() || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
    } else if (heading) {
      flush()
      blocks.push({ type: 'h', text: heading[1].trim() })
    } else if (item) {
      const ordered = /\d/.test(item[1])
      if (!list || list.type !== (ordered ? 'ol' : 'ul')) flush()
      list = list || { type: ordered ? 'ol' : 'ul', items: [] }
      list.items.push(item[2])
    } else {
      if (list || table) flush()
      para = para || { type: 'p', lines: [] }
      para.lines.push(line.replace(/^\s*>\s?/, '').trim())
    }
  }
  flush()
  return blocks
}

function Rich({ text }) {
  const blocks = parseBlocks(text)
  return h(
    'div',
    { className: 'cl-md' },
    blocks.map((b, i) => {
      const k = `b${i}`
      if (b.type === 'code') return h('pre', { key: k, className: 'cl-md-pre' }, b.text)
      if (b.type === 'h') return h('div', { key: k, className: 'cl-md-h' }, inline(b.text, k))
      if (b.type === 'ul' || b.type === 'ol') return h(b.type, { key: k, className: 'cl-md-list' }, b.items.map((it, j) => h('li', { key: j }, inline(it, `${k}-${j}`))))
      if (b.type === 'table') {
        const rows = b.rows.map((row, j) => h('tr', { key: j }, row.map((cell, x) => h(j ? 'td' : 'th', { key: x }, inline(cell, `${k}-${j}-${x}`)))))
        return h('div', { key: k, className: 'cl-md-tablewrap' }, h('table', { className: 'cl-md-table' }, h('tbody', null, rows)))
      }
      return h('p', { key: k, className: 'cl-md-p' }, b.lines.flatMap((ln, j) => [j ? h('br', { key: `br${j}` }) : null, ...inline(ln, `${k}-${j}`)]))
    }),
  )
}

// The full latest reply (backend /last-message), else the slot list's 80-character preview.
function LastMessage({ se, full, s }) {
  const mine = full && full.key === se.key ? full : null
  const text = mine && mine.available && typeof mine.text === 'string' ? stripOptions(mine.text) : ''
  let note = ''
  if (!mine || mine.loading) note = text ? '' : s.peekLoading
  else if (text) note = mine.truncated ? s.peekCut : ''
  else note = mine.reason === 'private session' ? s.peekPrivate : s.peekPreviewOnly
  if (!text && !se.preview) return null
  return peekSec(
    'last',
    s.peekLast,
    text ? h(Rich, { text }) : h('div', { className: 'cl-peek-msg' }, se.preview),
    note ? h('div', { className: 'cl-peek-note' }, note) : null,
  )
}

// What one session is doing: the pending request, the full latest reply, options and plan.
function PeekSections({ se, s, busy, full = null, onDecide }) {
  const out = []
  if (se.state === 'approval' && se.approval) {
    const tool = se.approval.tool || '?'
    const cmd = commandOf(se.approval)
    out.push(
      peekSec(
        'approval',
        s.peekApproval,
        h('div', { className: 'cl-peek-text' }, se.approval.purpose ? `${s.wantsToRun(tool)}: ${se.approval.purpose}` : s.wantsToRun(tool)),
        cmd ? h('pre', { className: 'cl-peek-code' }, cmd) : null,
        canDecide(se) ? h(DecideButtons, { se, s, busy, onDecide }) : h('div', { className: 'cl-peek-note' }, s.decideInSession),
      ),
    )
  }
  out.push(h(LastMessage, { key: 'last', se, full, s }))
  if (se.optionList.length) {
    out.push(peekSec('options', s.peekOptions, h('div', { className: 'cl-peek-opts' }, se.optionList.map((o) => h('span', { key: o, className: 'cl-peek-opt' }, o)))))
  }
  if (se.tasks.length) {
    const done = se.tasks.filter((t) => t.done).length
    const current = se.tasks.findIndex((t) => !t.done)
    const items = se.tasks.map((t, i) =>
      h(
        'li',
        { key: `${i}-${t.text}`, className: `cl-task${t.done ? ' is-done' : i === current ? ' is-current' : ''}` },
        h(Icon, { name: t.done ? 'taskDone' : 'taskTodo', size: 14 }),
        h('span', null, t.text),
      ),
    )
    out.push(peekSec('plan', `${s.peekPlan} · ${s.steps(done, se.tasks.length)}`, h('ul', { className: 'cl-tasks' }, items)))
  } else if (se.todo) {
    out.push(peekSec('plan', s.peekPlan, h(Progress, { todo: se.todo, s })))
  }
  return out
}

// Side panel: "what is going on" in one session, kept live by the same 4 s poll.
function PeekPanel({ hit, s, now, busy, full = null, onDecide, onOpen, onPeek, onClose }) {
  const { person: c, se } = hit
  const others = c.sessions.filter((item) => item.key !== se.key)
  const label = `${s.peekTitle}: ${c.displayName}`
  return h(
    'div',
    { className: 'cl-peek', role: 'dialog', 'aria-modal': 'true', 'aria-label': label },
    h('div', { className: 'cl-peek-backdrop', onClick: onClose }),
    h(
      'aside',
      { className: `cl-peek-panel cl-st-${se.state}` },
      h(
        'header',
        { className: 'cl-peek-head' },
        h(Avatar, { c, size: 40 }),
        h(
          'div',
          { className: 'cl-desk-id' },
          h('div', { className: 'cl-peek-kicker' }, s.peekTitle),
          h('div', { className: 'cl-name', title: c.displayName }, h('span', { className: 'cl-name-text' }, c.displayName)),
          h('div', { className: 'cl-meta' }, metaLine(c, s)),
        ),
        h('button', { type: 'button', className: 'cl-icon-btn', title: s.close, 'aria-label': s.close, autoFocus: true, onClick: onClose }, h(Icon, { name: 'close', size: 16 })),
      ),
      h(
        'div',
        { className: 'cl-peek-body' },
        peekSec(
          'now',
          s.peekNow,
          h('div', { className: 'cl-peek-title' }, se.title),
          h('div', { className: 'cl-peek-row' }, h(StateChip, { state: se.state, s }), se.app ? h('span', { className: 'cl-tag' }, h(Icon, { name: 'app', size: 11 }), s.via(se.app)) : null),
          h('div', { className: 'cl-facts' }, facts(se, s, now)),
        ),
        h(PeekSections, { se, s, busy, full, onDecide }),
        others.length
          ? peekSec('others', s.peekOther, h('ul', { className: 'cl-sessions' }, others.map((item) => h(SessionRow, { key: item.key, se: item, s, now, onOpen, onPeek }))))
          : null,
      ),
      h(
        'footer',
        { className: 'cl-peek-foot' },
        h('span', { className: 'cl-peek-hint' }, s.peekHint),
        h('button', { type: 'button', className: 'cl-btn cl-btn-primary', onClick: () => onOpen(se.key) }, h('span', null, s.open), h(Icon, { name: 'open', size: 15 })),
      ),
    ),
  )
}

function Hero({ lobby, s, error, onLocate }) {
  const online = lobby ? lobby.colleagues.filter((c) => c.presence === 'online') : []
  const shown = online.slice(0, PILE_MAX)
  return h(
    'div',
    { className: 'cl-hero' },
    h(
      'div',
      { className: 'cl-brand' },
      h('span', { className: 'cl-logo' }, hasIcon('logo') ? h(Icon, { name: 'logo', size: 24 }) : 'CL'),
      h(
        'div',
        { className: 'cl-brand-text' },
        h(
          'div',
          { className: 'cl-title-row' },
          h('h2', { className: 'cl-title' }, s.title),
          h('span', { className: `cl-live${error ? ' is-off' : ''}` }, h('i'), h('span', null, error ? s.liveOff : s.live)),
        ),
        h('div', { className: 'cl-sub' }, lobby ? s.tagline : s.loading),
      ),
    ),
    lobby
      ? h(
          'div',
          { className: 'cl-pile' },
          h(
            'div',
            { className: 'cl-pile-faces' },
            shown.map((c) =>
              h(
                'button',
                { key: c.id, type: 'button', className: 'cl-pile-face', title: `${c.displayName} · ${s.states[c.state]}`, 'aria-label': `${c.displayName}: ${s.states[c.state]}`, onClick: () => onLocate(c.id) },
                h(Avatar, { c, size: 36 }),
              ),
            ),
            online.length > shown.length ? h('span', { className: 'cl-pile-more' }, `+${online.length - shown.length}`) : null,
          ),
          h('span', { className: 'cl-pile-label' }, online.length ? s.inRoom(online.length) : s.nobodyOnline),
        )
      : null,
  )
}

const STAT_DEFS = [
  { key: 'online', icon: 'online', unit: 'people' },
  { key: 'needs', icon: 'zone-needs', unit: 'sessions' },
  { key: 'unread', icon: 'zone-unread', unit: 'replies' },
  { key: 'working', icon: 'zone-working', unit: 'sessions' },
]

// Stat cards double as filters: click one to see only the crewmates behind that number.
function Stats({ lobby, s, zoneFilter, onFilter }) {
  return h(
    'div',
    { className: 'cl-stats' },
    STAT_DEFS.map(({ key, icon, unit }) => {
      const n = lobby ? lobby.counts[key] : null
      const on = zoneFilter === key
      return h(
        'button',
        { key, type: 'button', className: `cl-stat cl-k-${key}${on ? ' is-on' : ''}${n ? ' has-value' : ''}`, 'aria-pressed': on ? 'true' : 'false', onClick: () => onFilter(on ? null : key) },
        h('span', { className: 'cl-stat-icon' }, h(Icon, { name: icon, size: 18 })),
        h(
          'span',
          { className: 'cl-stat-body' },
          h('span', { className: 'cl-stat-label' }, s.stats[key]),
          h('span', { className: 'cl-stat-value' }, h('b', null, n === null ? '–' : String(n)), h('small', null, n === null ? '' : s.units[unit](n))),
        ),
      )
    }),
  )
}

function Switch({ checked, label, onChange }) {
  return h(
    'label',
    { className: `cl-switch${checked ? ' is-on' : ''}` },
    h('input', { type: 'checkbox', checked: Boolean(checked), onChange: (event) => onChange(event.target.checked) }),
    h('span', { className: 'cl-switch-track', 'aria-hidden': 'true' }, h('span', { className: 'cl-switch-knob' })),
    h('span', null, label),
  )
}

function SegButton({ on, icon, label, onClick }) {
  return h(
    'button',
    { type: 'button', className: `cl-seg-btn${on ? ' is-on' : ''}`, 'aria-pressed': on ? 'true' : 'false', onClick },
    h(Icon, { name: icon, size: 14 }),
    h('span', null, label),
  )
}

function Toolbar({ lobby, s, prefs, setPref, query, setQuery, zoneFilter, onFilter, onMarkAllRead, onRefresh, spinning }) {
  const room = prefs.view !== 'list'
  return h(
    'div',
    { className: 'cl-toolbar' },
    h(
      'label',
      { className: 'cl-search' },
      h(Icon, { name: 'search', size: 15 }),
      h('input', { type: 'search', value: query, placeholder: s.search, 'aria-label': s.search, onChange: (event) => setQuery(event.target.value) }),
    ),
    h(
      'div',
      { className: 'cl-seg', role: 'group' },
      h(SegButton, { on: room, icon: 'room', label: s.room, onClick: () => setPref('view', 'room') }),
      h(SegButton, { on: !room, icon: 'list', label: s.list, onClick: () => setPref('view', 'list') }),
    ),
    h(Switch, { checked: prefs.onlyNeeds, label: s.onlyNeeds, onChange: (value) => setPref('onlyNeeds', value) }),
    h(Switch, { checked: prefs.notifyOn, label: s.notify, onChange: (value) => setPref('notifyOn', value) }),
    h('span', { className: 'cl-grow' }),
    zoneFilter
      ? h('button', { type: 'button', className: 'cl-btn cl-btn-ghost', onClick: () => onFilter(null) }, h(Icon, { name: 'close', size: 14 }), h('span', null, s.clearFilter))
      : null,
    lobby && lobby.counts.unread
      ? h('button', { type: 'button', className: 'cl-btn cl-btn-tonal', onClick: onMarkAllRead }, h(Icon, { name: 'read', size: 15 }), h('span', null, s.markAllRead))
      : null,
    h(
      'button',
      { type: 'button', className: `cl-icon-btn${spinning ? ' is-spinning' : ''}`, title: s.refresh, 'aria-label': s.refresh, onClick: onRefresh },
      hasIcon('refresh') ? h(Icon, { name: 'refresh', size: 16 }) : '↻',
    ),
  )
}

function Skeleton() {
  return h(
    'div',
    { className: 'cl-floor is-skeleton', 'aria-hidden': 'true' },
    [0, 1, 2, 3].map((i) =>
      h(
        'div',
        { key: i, className: 'cl-skel', style: { '--i': i } },
        h('div', { className: 'cl-skel-row' }, h('span', { className: 'cl-skel-av' }), h('span', { className: 'cl-skel-col' }, h('i', { className: 'w60' }), h('i', { className: 'w40' }))),
        h('i', { className: 'cl-skel-block' }),
        h('i', { className: 'w80' }),
      ),
    ),
  )
}

function Empty({ text }) {
  return h('div', { className: 'cl-empty' }, h('span', { className: 'cl-empty-icon' }, h(Icon, { name: 'logo', size: 30 })), h('div', { className: 'cl-empty-text' }, text))
}

function Zone({ zone, people, s, now, expanded, onToggle, onOpen, onMarkRead, onPeek, onDecide, deciding }) {
  return h(
    'section',
    { className: `cl-zone cl-z-${zone}` },
    h(
      'div',
      { className: 'cl-zone-head' },
      h('span', { className: 'cl-zone-icon' }, h(Icon, { name: `zone-${zone}`, size: 15 })),
      h('h3', { className: 'cl-zone-title' }, s.zones[zone]),
      h('span', { className: 'cl-zone-count' }, String(people.length)),
      h('span', { className: 'cl-zone-line' }),
    ),
    zone === 'offline'
      ? h('div', { className: 'cl-off-row' }, people.map((c) => h(OfflineChip, { key: c.id, c, s, now, onOpen })))
      : h(
          'div',
          { className: 'cl-floor' },
          people.map((c, i) =>
            h(DeskCard, { key: c.id, c, s, now, index: i, expanded: Boolean(expanded?.[c.id]), onToggle, onOpen, onMarkRead, onPeek, onDecide, deciding }),
          ),
        ),
  )
}

export function LobbyView(props) {
  const { lobby, s, lang, now, prefs, setPref, query, setQuery, expanded, onToggle, onOpen, onMarkRead, onMarkAllRead, onRefresh, error, updatedAt } = props
  const { zoneFilter = null, onFilter = noop, onLocate = noop, spinning = false } = props
  const { peekKey = null, peekFull = null, onPeek = noop, onClosePeek = noop, onDecide = noop, deciding = {} } = props
  const hit = peekKey ? findSession(lobby, peekKey) : null
  const q = String(query || '').trim().toLowerCase()
  const visible = lobby
    ? lobby.colleagues.filter(
        (c) => (!prefs.onlyNeeds || c.zone === 'needs' || c.zone === 'unread') && passesFilter(c, zoneFilter) && (!q || matches(c, q)),
      )
    : []

  let body
  if (!lobby) body = error ? null : h(Skeleton)
  else if (!visible.length) body = h(Empty, { text: lobby.colleagues.length ? s.emptyFiltered : s.empty })
  else if (prefs.view === 'list') body = h(ListView, { list: visible, s, now, onOpen, onPeek, onDecide, deciding })
  else {
    body = ZONES.map((zone) => {
      const people = visible.filter((c) => c.zone === zone)
      return people.length
        ? h(Zone, { key: zone, zone, people, s, now, expanded, onToggle, onOpen, onMarkRead, onPeek, onDecide, deciding })
        : null
    })
  }

  return h(
    'div',
    { className: 'cl-root' },
    h('style', null, CSS),
    // The page scrolls inside .cl-scroll, so the Peek overlay below can be absolute to the
    // app's own area: a fixed overlay sat under the desktop title bar and cut the header.
    h(
      'div',
      { className: 'cl-scroll' },
      h(Hero, { lobby, s, error, onLocate }),
      h(Stats, { lobby, s, zoneFilter, onFilter }),
      h(Toolbar, { lobby, s, prefs, setPref, query, setQuery, zoneFilter, onFilter, onMarkAllRead, onRefresh, spinning }),
      error
        ? h(
            'div',
            { className: 'cl-error', role: 'alert' },
            h('span', { className: 'cl-error-text' }, h(Icon, { name: 'stall', size: 15 }), h('span', null, `${s.error}: ${error}`)),
            h('button', { type: 'button', className: 'cl-btn', onClick: onRefresh }, s.retry),
          )
        : null,
      h('div', { className: 'cl-body' }, body),
      h(
        'div',
        { className: 'cl-foot' },
        h(Icon, { name: 'shield', size: 13 }),
        h('span', null, s.footNote),
        h('span', { className: 'cl-foot-time' }, updatedAt ? s.updatedAt(clock(updatedAt, lang)) : s.loading),
      ),
    ),
    hit ? h(PeekPanel, { hit, s, now, busy: deciding[hit.se.key], full: peekFull, onDecide, onOpen, onPeek, onClose: onClosePeek }) : null,
  )
}

// ── Container: data, unread state, alerts ───────────────────────────────────────────────

export default function CrewLobby() {
  const api = useAppApi()
  const navigate = useNavigate()
  const setBadge = useNavBadge()
  const notify = useNotify()
  const lang = useMemo(pickLang, [])
  const s = STR[lang]

  const [slots, setSlots] = useState(null)
  const [agents, setAgents] = useState([])
  const [error, setError] = useState(api ? '' : s.noSdk)
  const [updatedAt, setUpdatedAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [seen, setSeen] = useState(() => loadJSON(SEEN_KEY, {}))
  const [prefs, setPrefs] = useState(() => ({ ...DEFAULT_PREFS, ...loadJSON(PREFS_KEY, {}) }))
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState({})
  const [zoneFilter, setZoneFilter] = useState(null)
  const [spinning, setSpinning] = useState(false)
  const [peekKey, setPeekKey] = useState(null)
  const [deciding, setDeciding] = useState({})
  const [peekFull, setPeekFull] = useState(null)

  const apiRef = useRef(api)
  apiRef.current = api
  const notifyRef = useRef(notify)
  notifyRef.current = notify
  const slotsRef = useRef(slots)
  slotsRef.current = slots
  const busyRef = useRef(false)
  const prevRef = useRef(null)
  const lobbyRef = useRef(null)

  const refresh = useCallback(async () => {
    const client = apiRef.current
    if (!client || busyRef.current) return
    busyRef.current = true
    try {
      const res = await client.get('/api/chat/slots')
      setSlots(Array.isArray(res) ? res : Array.isArray(res?.slots) ? res.slots : [])
      setError('')
      const t = Date.now()
      setUpdatedAt(t)
      setNow(t)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      busyRef.current = false
    }
  }, [])

  const refreshRoster = useCallback(async () => {
    const client = apiRef.current
    if (!client) return
    try {
      const res = await client.get('/api/agents')
      setAgents(Array.isArray(res?.agents) ? res.agents : [])
    } catch {
      // The roster only adds offline crewmates and display names; sessions still render.
    }
  }, [])

  useEffect(() => {
    let alive = true
    let timer = 0
    const schedule = () => {
      const hidden = globalThis.document?.visibilityState === 'hidden'
      timer = setTimeout(async () => {
        await refresh()
        if (alive) schedule()
      }, hidden ? POLL_HIDDEN_MS : POLL_MS)
    }
    refresh()
    refreshRoster()
    schedule()
    const rosterTimer = setInterval(refreshRoster, ROSTER_MS)
    const clockTimer = setInterval(() => setNow(Date.now()), CLOCK_MS)
    return () => {
      alive = false
      clearTimeout(timer)
      clearInterval(rosterTimer)
      clearInterval(clockTimer)
    }
  }, [refresh, refreshRoster])

  const seenView = useMemo(() => withSeenDefaults(seen, slots || []), [seen, slots])
  useEffect(() => {
    if (!slots || Object.keys(seenView).length === Object.keys(seen || {}).length) return
    const next = pruneSeen(seenView, slots)
    setSeen(next)
    saveJSON(SEEN_KEY, next)
  }, [seenView, seen, slots])

  const lobby = useMemo(() => (slots ? buildLobby({ slots, agents, seen: seenView, now }) : null), [slots, agents, seenView, now])
  lobbyRef.current = lobby

  const markRead = useCallback((keys) => {
    if (!keys || !keys.length) return
    setSeen((prev) => {
      const live = slotsRef.current || []
      const next = withSeenDefaults(prev, live)
      for (const key of keys) {
        const slot = live.find((item) => item.key === key)
        next[key] = Math.max(Number(next[key]) || 0, toMs(slot?.last_agent_ts))
      }
      saveJSON(SEEN_KEY, next)
      return next
    })
  }, [])

  const markAllRead = useCallback(() => markRead((slotsRef.current || []).map((slot) => slot.key)), [markRead])

  const open = useCallback(
    (key) => {
      markRead([key])
      const path = `/chat?sid=${encodeURIComponent(key)}`
      if (typeof navigate === 'function') navigate(path)
      else globalThis.location?.assign(path)
    },
    [navigate, markRead],
  )

  // Peeking shows the latest reply, so it counts as having looked.
  const peek = useCallback(
    (key) => {
      markRead([key])
      setPeekKey(key)
    },
    [markRead],
  )
  const closePeek = useCallback(() => setPeekKey(null), [])

  // Peek reads the whole latest reply from this app's own backend route: the slot list
  // carries only an 80-character preview. Refetched when that session posts a new reply.
  const peekAgentTs = peekKey ? findSession(lobby, peekKey)?.se.agentTs || 0 : 0
  useEffect(() => {
    const client = apiRef.current
    if (!peekKey || !client) return undefined
    let alive = true
    setPeekFull((prev) => (prev && prev.key === peekKey ? { ...prev, loading: true } : { key: peekKey, loading: true }))
    Promise.resolve(client.get(`/api/apps/crew-lobby/last-message?session=${encodeURIComponent(peekKey)}`))
      .then((res) => {
        if (alive) setPeekFull({ ...(res && typeof res === 'object' ? res : {}), key: peekKey, loading: false })
      })
      .catch(() => {
        if (alive) setPeekFull({ key: peekKey, available: false, reason: 'unreachable', loading: false })
      })
    return () => {
      alive = false
    }
  }, [peekKey, peekAgentTs])
  useEffect(() => {
    if (!peekKey) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') setPeekKey(null)
    }
    globalThis.document?.addEventListener('keydown', onKey)
    return () => globalThis.document?.removeEventListener('keydown', onKey)
  }, [peekKey])

  // Approve / Deny one native request. The body names the exact card (request_id + request_mid,
  // origin "native"), so a stale click can never resolve a newer request on the same chat.
  const decide = useCallback(
    async (key, action) => {
      const client = apiRef.current
      const send = notifyRef.current
      const hit = findSession(lobbyRef.current, key)
      const approval = hit?.se?.approval
      if (!client || !approval || typeof client.post !== 'function') return
      if (!approval.native) {
        if (typeof send === 'function') send(s.decideInSession, { type: 'info' })
        return
      }
      setDeciding((prev) => ({ ...prev, [key]: action }))
      try {
        const body = { action, request_id: approval.requestId, request_mid: approval.requestMid, origin: 'native' }
        await client.post(`/api/chat/slots/${encodeURIComponent(key)}/approve`, body)
        const done = action === 'approved' ? s.decidedApproved : s.decidedDenied
        if (typeof send === 'function') send(`${done} · ${hit.se.title}`, { type: action === 'approved' ? 'success' : 'info' })
      } catch (err) {
        if (typeof send === 'function') send(decisionError(err, s), { type: 'error' })
      } finally {
        setDeciding((prev) => {
          const next = { ...prev }
          delete next[key]
          return next
        })
        refresh()
      }
    },
    [refresh, s],
  )

  const setPref = useCallback((name, value) => {
    setPrefs((prev) => {
      const next = { ...prev, [name]: value }
      saveJSON(PREFS_KEY, next)
      return next
    })
  }, [])

  const onToggle = useCallback((id) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] })), [])

  const manualRefresh = useCallback(() => {
    setSpinning(true)
    Promise.resolve(refresh()).finally(() => setTimeout(() => setSpinning(false), 450))
  }, [refresh])

  // Facepile click: scroll to that crewmate's desk and flash it.
  const locate = useCallback((id) => {
    const el = globalThis.document?.getElementById(domId(id))
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.remove('cl-flash')
    void el.offsetWidth
    el.classList.add('cl-flash')
    setTimeout(() => el.classList.remove('cl-flash'), 1700)
  }, [])

  // In-app alert when a session moves into a state that wants you. Never on first load.
  useEffect(() => {
    if (!lobby) return
    const current = new Map()
    for (const c of lobby.colleagues) for (const se of c.sessions) current.set(se.key, { state: se.state, who: c.displayName, title: se.title })
    const previous = prevRef.current
    prevRef.current = current
    const send = notifyRef.current
    if (!previous || !prefs.notifyOn || typeof send !== 'function') return
    const changes = []
    for (const [key, item] of current) {
      const before = previous.get(key)
      if (before && before.state !== item.state && NOTIFY_ON.has(item.state)) changes.push(item)
    }
    if (changes.length === 1) {
      const [item] = changes
      const type = item.state === 'interrupted' ? 'error' : item.state === 'unread' ? 'success' : 'info'
      send(`${s.notifyMsg[item.state](item.who)} · ${item.title}`, { type })
    } else if (changes.length > 1) {
      send(s.notifyMany(changes.length), { type: 'info' })
    }
  }, [lobby, prefs.notifyOn, s])

  const badge = lobby ? lobby.counts.needs + lobby.counts.unread : 0
  useEffect(() => {
    if (typeof setBadge === 'function') setBadge(badge)
  }, [badge, setBadge])

  return h(LobbyView, {
    lobby,
    s,
    lang,
    now,
    prefs,
    setPref,
    query,
    setQuery,
    expanded,
    onToggle,
    onOpen: open,
    onMarkRead: markRead,
    onMarkAllRead: markAllRead,
    onRefresh: manualRefresh,
    error,
    updatedAt,
    zoneFilter,
    onFilter: setZoneFilter,
    onLocate: locate,
    spinning,
    peekKey,
    peekFull,
    onPeek: peek,
    onClosePeek: closePeek,
    onDecide: decide,
    deciding,
  })
}

// ── Styles: Crew theme tokens first, default-dark-theme values as fallbacks ─────────────
// State colors: amber = waits on you, red = interrupted, Kiro purple (--aim) = unread,
// Crew green (--accent) = working, muted = idle. Presence dots use --ok/--warn.
const CSS = `
.cl-root{--cl-bg:var(--bg,#12141a);--cl-elev:var(--bg-elevated,#1a1d25);--cl-hover:var(--bg-hover,#262a35);--cl-card:var(--card,#181b22);
--cl-text:var(--text,#e4e4e7);--cl-strong:var(--text-strong,#fafafa);--cl-muted:var(--muted,#7f7f88);--cl-muted-2:var(--muted-strong,#52525b);
--cl-border:var(--border,#27272a);--cl-border-2:var(--border-strong,#3f3f46);--cl-accent:var(--accent,#00d492);--cl-aim:var(--aim,#a78bfa);
--cl-ok:var(--ok,#22c55e);--cl-warn:var(--warn,#eab308);--cl-danger:var(--danger,#ef4444);--cl-info:var(--info,#0891b2);
--cl-mono:var(--mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);--cl-r-xl:20px;--cl-r-lg:16px;--cl-r-md:12px;--cl-r-sm:10px;
--cl-shadow:0 1px 2px rgba(0,0,0,.16);
position:relative;isolation:isolate;display:flex;flex-direction:column;flex:1 1 auto;height:100%;min-height:0;overflow:hidden;
color:var(--cl-text);font-size:13px;line-height:1.45;-webkit-font-smoothing:antialiased}
.cl-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;scroll-behavior:smooth}
.cl-root *,.cl-root *::before,.cl-root *::after{box-sizing:border-box}
.cl-ico{flex:none;display:block}
.cl-hero{display:flex;flex-wrap:wrap;gap:18px;align-items:center;justify-content:space-between;padding:28px 28px 20px}
.cl-brand{display:flex;gap:14px;align-items:center;min-width:0}
.cl-logo{flex:none;width:44px;height:44px;border-radius:13px;display:grid;place-items:center;color:var(--cl-aim);font-weight:800;
background:color-mix(in srgb,var(--cl-aim) 14%,transparent);border:1px solid color-mix(in srgb,var(--cl-aim) 30%,transparent)}
.cl-title-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.cl-title{margin:0;font-size:23px;line-height:1.15;font-weight:700;letter-spacing:-.025em;color:var(--cl-strong)}
.cl-sub{margin-top:5px;color:var(--cl-muted);font-size:13px}
.cl-live{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px 0 8px;border-radius:999px;font-size:10.5px;font-weight:700;
letter-spacing:.06em;text-transform:uppercase;color:var(--cl-ok);background:color-mix(in srgb,var(--cl-ok) 12%,transparent);
border:1px solid color-mix(in srgb,var(--cl-ok) 30%,transparent)}
.cl-live i{width:7px;height:7px;border-radius:50%;background:currentColor;animation:cl-ping 2s ease-out infinite}
.cl-live.is-off{color:var(--cl-danger);background:color-mix(in srgb,var(--cl-danger) 12%,transparent);border-color:color-mix(in srgb,var(--cl-danger) 30%,transparent)}
.cl-live.is-off i{animation:none}
.cl-pile{display:flex;align-items:center;gap:12px;padding:5px 14px 5px 6px;border-radius:999px;background:var(--cl-card);border:1px solid var(--cl-border)}
.cl-pile-faces{display:flex;align-items:center;gap:2px}
.cl-pile-face{position:relative;padding:3px;border:0;background:transparent;cursor:pointer;border-radius:50%;transition:transform .18s ease}
.cl-pile-face .cl-av-ring{inset:-3px}
.cl-pile-face:hover,.cl-pile-face:focus-visible{transform:translateY(-3px);z-index:2;outline:none}
.cl-pile-face .cl-av{--cl-ring-bg:var(--cl-card)}
.cl-pile-face .cl-av-face{box-shadow:0 0 0 2px var(--cl-card)}
.cl-pile-more{margin-left:2px;width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:var(--cl-elev);
border:2px solid var(--cl-card);color:var(--cl-muted);font-size:11px;font-weight:700}
.cl-pile-label{color:var(--cl-muted);font-size:12px;white-space:nowrap}
.cl-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;padding:0 28px 20px}
@media (max-width:1000px){.cl-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
.cl-stat{position:relative;display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:var(--cl-r-lg);
text-align:left;cursor:pointer;font:inherit;color:inherit;background:var(--cl-card);border:1px solid var(--cl-border);box-shadow:var(--cl-shadow);
transition:border-color .15s ease,background .15s ease}
.cl-stat:hover{border-color:var(--cl-border-2);background:var(--cl-elev)}
.cl-stat.is-on{border-color:var(--cl-k);box-shadow:inset 0 0 0 1px var(--cl-k)}
.cl-stat:focus-visible{outline:2px solid var(--cl-k);outline-offset:2px}
.cl-stat-icon{flex:none;width:42px;height:42px;border-radius:13px;display:grid;place-items:center;color:var(--cl-k);
background:color-mix(in srgb,var(--cl-k) 15%,transparent);border:1px solid color-mix(in srgb,var(--cl-k) 28%,transparent)}
.cl-stat-body{display:flex;flex-direction:column;gap:1px;min-width:0}
.cl-stat-label{font-size:12px;color:var(--cl-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cl-stat-value{display:flex;align-items:baseline;gap:6px}
.cl-stat-value b{font-size:27px;line-height:1.1;font-weight:700;letter-spacing:-.03em;color:var(--cl-strong);font-variant-numeric:tabular-nums}
.cl-stat-value small{font-size:12px;color:var(--cl-muted)}
.cl-k-online{--cl-k:var(--cl-ok)}.cl-k-needs{--cl-k:var(--cl-warn)}.cl-k-unread{--cl-k:var(--cl-aim)}.cl-k-working{--cl-k:var(--cl-accent)}
.cl-toolbar{position:sticky;top:0;z-index:6;display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:10px 28px;
background:var(--cl-bg);border-top:1px solid color-mix(in srgb,var(--cl-border) 60%,transparent);border-bottom:1px solid color-mix(in srgb,var(--cl-border) 60%,transparent)}
.cl-grow{flex:1}
.cl-search{display:flex;align-items:center;gap:8px;flex:0 1 320px;min-width:220px;height:36px;padding:0 12px;border-radius:var(--cl-r-sm);
background:var(--cl-elev);border:1px solid var(--cl-border);color:var(--cl-muted);transition:border-color .15s,box-shadow .15s}
.cl-search:focus-within{border-color:color-mix(in srgb,var(--cl-accent) 60%,var(--cl-border));box-shadow:0 0 0 3px color-mix(in srgb,var(--cl-accent) 18%,transparent)}
.cl-search input{flex:1;min-width:0;height:100%;border:0;outline:0;background:transparent;color:var(--cl-text);font:inherit}
.cl-search input::placeholder{color:var(--cl-muted)}
.cl-seg{display:inline-flex;gap:2px;padding:3px;border-radius:var(--cl-r-sm);background:var(--cl-elev);border:1px solid var(--cl-border)}
.cl-seg-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border:0;border-radius:7px;background:transparent;
color:var(--cl-muted);font:inherit;font-weight:500;cursor:pointer;transition:background .15s,color .15s}
.cl-seg-btn:hover{color:var(--cl-text)}
.cl-seg-btn.is-on{background:var(--cl-hover);color:var(--cl-strong);box-shadow:0 1px 2px rgba(0,0,0,.25)}
.cl-switch{position:relative;display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 4px;color:var(--cl-muted);cursor:pointer;user-select:none;white-space:nowrap}
.cl-switch input{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.cl-switch-track{position:relative;width:32px;height:18px;border-radius:999px;background:var(--cl-border-2);transition:background .2s}
.cl-switch-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35);transition:transform .2s cubic-bezier(.3,.7,.3,1)}
.cl-switch.is-on{color:var(--cl-text)}
.cl-switch.is-on .cl-switch-track{background:var(--cl-accent)}
.cl-switch.is-on .cl-switch-knob{transform:translateX(14px)}
.cl-switch:focus-within .cl-switch-track{box-shadow:0 0 0 3px color-mix(in srgb,var(--cl-accent) 25%,transparent)}
.cl-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border-radius:var(--cl-r-sm);
border:1px solid var(--cl-border);background:var(--cl-elev);color:var(--cl-text);font:inherit;font-weight:500;white-space:nowrap;cursor:pointer;
transition:background .15s,border-color .15s,color .15s,transform .15s,box-shadow .15s}
.cl-btn:hover{border-color:var(--cl-border-2);background:var(--cl-hover)}
.cl-btn:active{transform:translateY(1px)}
.cl-btn:focus-visible,.cl-icon-btn:focus-visible,.cl-seg-btn:focus-visible,.cl-off:focus-visible{outline:2px solid var(--cl-accent);outline-offset:2px}
.cl-btn-primary{border-color:transparent;color:var(--cl-bg);font-weight:600;background:var(--cl-accent)}
.cl-btn-primary:hover{border-color:transparent;background:color-mix(in srgb,var(--cl-accent) 85%,var(--cl-strong))}
.cl-btn-tonal{color:var(--cl-accent);border-color:color-mix(in srgb,var(--cl-accent) 30%,transparent);background:color-mix(in srgb,var(--cl-accent) 10%,transparent)}
.cl-btn-tonal:hover{background:color-mix(in srgb,var(--cl-accent) 17%,transparent);border-color:color-mix(in srgb,var(--cl-accent) 48%,transparent)}
.cl-btn-ghost{background:transparent;border-color:transparent;color:var(--cl-muted)}
.cl-btn-ghost:hover{background:var(--cl-hover);border-color:transparent;color:var(--cl-text)}
.cl-btn-xs{height:26px;padding:0 9px;font-size:12px;border-radius:8px}
.cl-icon-btn{display:inline-grid;place-items:center;width:36px;height:36px;border-radius:var(--cl-r-sm);border:1px solid var(--cl-border);
background:var(--cl-elev);color:var(--cl-muted);cursor:pointer;font:inherit;transition:color .15s,border-color .15s}
.cl-icon-btn:hover{color:var(--cl-text);border-color:var(--cl-border-2)}
.cl-icon-btn.is-spinning .cl-ico{animation:cl-spin .7s linear infinite}
.cl-body{padding:6px 28px 6px}
.cl-zone{margin:16px 0 28px}
.cl-zone-head{display:flex;align-items:center;gap:10px;margin:0 2px 12px}
.cl-zone-icon{flex:none;width:28px;height:28px;border-radius:9px;display:grid;place-items:center;color:var(--cl-z);
background:color-mix(in srgb,var(--cl-z) 14%,transparent);border:1px solid color-mix(in srgb,var(--cl-z) 26%,transparent)}
.cl-zone-title{margin:0;font-size:14px;font-weight:650;letter-spacing:-.01em;color:var(--cl-strong)}
.cl-zone-count{min-width:22px;height:20px;padding:0 7px;border-radius:999px;display:inline-grid;place-items:center;font-size:11px;font-weight:700;
color:var(--cl-z);background:color-mix(in srgb,var(--cl-z) 14%,transparent)}
.cl-zone-line{flex:1;height:1px;background:var(--cl-border)}
.cl-z-needs{--cl-z:var(--cl-warn)}.cl-z-unread{--cl-z:var(--cl-aim)}.cl-z-working{--cl-z:var(--cl-accent)}.cl-z-available{--cl-z:var(--cl-info)}.cl-z-offline{--cl-z:var(--cl-muted)}
.cl-floor{position:relative;display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px;padding:18px;border-radius:var(--cl-r-xl);
border:1px solid var(--cl-border);overflow:hidden;background:color-mix(in srgb,var(--cl-bg) 55%,var(--cl-card))}
.cl-floor::before{content:'';position:absolute;inset:0;pointer-events:none;
background-image:repeating-linear-gradient(30deg,transparent 0 27px,color-mix(in srgb,var(--cl-text) 4%,transparent) 27px 28px),
repeating-linear-gradient(150deg,transparent 0 27px,color-mix(in srgb,var(--cl-text) 4%,transparent) 27px 28px)}
.cl-floor>*{position:relative}
.cl-st-approval,.cl-st-question{--cl-sc:var(--cl-warn)}
.cl-st-interrupted{--cl-sc:var(--cl-danger)}
.cl-st-unread{--cl-sc:var(--cl-aim)}
.cl-st-working{--cl-sc:var(--cl-accent)}
.cl-st-choice,.cl-st-waiting,.cl-st-idle{--cl-sc:var(--cl-muted)}
.cl-desk{display:flex;flex-direction:column;gap:12px;padding:15px 15px 13px;border-radius:var(--cl-r-lg);outline:none;overflow:hidden;
background:var(--cl-card);border:1px solid var(--cl-border);box-shadow:var(--cl-shadow);transition:border-color .15s ease;
animation:cl-rise .3s ease-out backwards;animation-delay:calc(var(--i,0) * 40ms)}
.cl-desk::after{content:'';position:absolute;left:0;right:0;top:0;height:3px;pointer-events:none;background:var(--cl-sc)}
.cl-desk.cl-st-choice::after,.cl-desk.cl-st-waiting::after,.cl-desk.cl-st-idle::after{display:none}
.cl-desk::before{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;opacity:0;box-shadow:inset 0 0 0 2px var(--cl-aim)}
.cl-desk.cl-flash::before{animation:cl-flash 1.6s ease}
.cl-desk:hover{border-color:var(--cl-border-2)}
.cl-desk:focus-visible{border-color:var(--cl-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--cl-accent) 28%,transparent)}
.cl-desk-head{display:flex;align-items:center;gap:12px}
.cl-desk{container-type:inline-size}
@container (max-width:400px){
.cl-desk-head{display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:12px;row-gap:6px}
.cl-desk-head>.cl-av{grid-row:1/span 2;align-self:start}
.cl-desk-head>.cl-chip{grid-column:2;justify-self:start}}
.cl-desk-id{flex:1;min-width:0}
.cl-name{display:flex;align-items:center;gap:6px;min-width:0;font-size:14.5px;font-weight:650;letter-spacing:-.01em;color:var(--cl-strong)}
.cl-name-text{min-width:0;overflow:hidden;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.cl-meta{margin-top:2px;color:var(--cl-muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cl-badge{flex:none;min-width:18px;height:18px;padding:0 6px;border-radius:999px;display:inline-grid;place-items:center;font-size:11px;font-weight:700;
color:var(--cl-bg);background:var(--cl-aim)}
.cl-av{position:relative;flex:none;display:inline-grid;place-items:center;width:var(--cl-size);height:var(--cl-size);--cl-ring-bg:var(--cl-card)}
.cl-av-face{width:100%;height:100%;border-radius:50%;display:grid;place-items:center;font-weight:700;letter-spacing:.02em;font-size:calc(var(--cl-size) * .36);
background:var(--cl-c)}
.cl-av-ring{position:absolute;inset:-4px;border-radius:50%;opacity:0;background:var(--cl-sc);
-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 calc(100% - 2px));mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 calc(100% - 2px))}
.cl-av.cl-st-approval .cl-av-ring,.cl-av.cl-st-question .cl-av-ring{opacity:1;animation:cl-breathe 1.8s ease-in-out infinite}
.cl-av.cl-st-interrupted .cl-av-ring,.cl-av.cl-st-unread .cl-av-ring{opacity:1}
.cl-av.cl-st-working .cl-av-ring{opacity:1;animation:cl-spin 1.2s linear infinite;
background:conic-gradient(var(--cl-sc) 0deg 90deg,color-mix(in srgb,var(--cl-sc) 22%,transparent) 90deg 360deg)}
.cl-av-dot{position:absolute;right:-1px;bottom:-1px;width:max(10px,calc(var(--cl-size) * .27));height:max(10px,calc(var(--cl-size) * .27));
border-radius:50%;background:var(--cl-muted-2);border:2px solid var(--cl-ring-bg)}
.cl-pr-online{background:var(--cl-ok)}.cl-pr-away{background:var(--cl-warn)}.cl-pr-offline{background:var(--cl-muted-2)}
.cl-chip{flex:none;display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px 0 7px;border-radius:999px;font-size:11.5px;font-weight:600;
white-space:nowrap;color:var(--cl-sc);background:color-mix(in srgb,var(--cl-sc) 13%,transparent);border:1px solid color-mix(in srgb,var(--cl-sc) 32%,transparent)}
.cl-chip.is-compact{height:21px;padding:0 7px 0 6px;font-size:11px}
.cl-chip.cl-st-approval .cl-ico,.cl-chip.cl-st-question .cl-ico{animation:cl-nudge 2.6s ease-in-out infinite}
.cl-bubble{position:relative;margin-left:8px;padding:10px 12px 11px;border-radius:12px;background:var(--cl-elev);border:1px solid var(--cl-border)}
.cl-bubble::before{content:'';position:absolute;top:-6px;left:16px;width:10px;height:10px;transform:rotate(45deg);background:inherit;
border-left:1px solid var(--cl-border);border-top:1px solid var(--cl-border);border-top-left-radius:3px}
.cl-bubble-head{display:flex;align-items:center;gap:8px;min-width:0;margin-bottom:4px}
.cl-bubble-session{flex:0 1 auto;min-width:0;font-size:11.5px;font-weight:600;color:var(--cl-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cl-tag{flex:none;display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 6px;border-radius:6px;font-size:10.5px;font-weight:600;
color:var(--cl-info);background:color-mix(in srgb,var(--cl-info) 15%,transparent)}
.cl-bubble-text{font-size:14px;line-height:1.5;color:var(--cl-text);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.cl-bubble.is-clickable{cursor:pointer;transition:border-color .15s ease}
.cl-bubble.is-clickable:hover{border-color:var(--cl-border-2)}
.cl-bubble.is-clickable:focus-visible{outline:2px solid var(--cl-accent);outline-offset:2px}
.cl-bubble.is-empty .cl-bubble-text{color:var(--cl-muted);font-style:italic}
.cl-cmd{display:flex;align-items:center;gap:8px;margin-top:8px;padding:7px 10px;border-radius:9px;font-family:var(--cl-mono);font-size:11.5px;color:var(--cl-strong);
background:color-mix(in srgb,var(--cl-text) 7%,var(--cl-bg));border:1px solid color-mix(in srgb,var(--cl-warn) 32%,var(--cl-border))}
.cl-cmd .cl-ico{color:var(--cl-warn)}
.cl-cmd code{font:inherit;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cl-typing{margin-left:auto;flex:none;display:inline-flex;align-items:center;gap:3px;padding:0 2px}
.cl-typing i{width:5px;height:5px;border-radius:50%;background:var(--cl-accent);animation:cl-dots 1.2s ease-in-out infinite}
.cl-typing i:nth-child(2){animation-delay:.15s}.cl-typing i:nth-child(3){animation-delay:.3s}
.cl-progress{display:flex;align-items:center;gap:10px}
.cl-progress-track{flex:1;height:6px;border-radius:999px;overflow:hidden;background:color-mix(in srgb,var(--cl-text) 10%,transparent)}
.cl-progress-track i{display:block;height:100%;border-radius:inherit;background:var(--cl-sc);transition:width .4s ease}
.cl-progress-label{flex:none;font-size:11.5px;color:var(--cl-muted);font-variant-numeric:tabular-nums}
.cl-facts{display:flex;flex-wrap:wrap;gap:6px}
.cl-fact{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border-radius:8px;font-size:11.5px;white-space:nowrap;text-decoration:none;
color:var(--cl-muted);background:color-mix(in srgb,var(--cl-text) 5%,transparent);border:1px solid color-mix(in srgb,var(--cl-border) 85%,transparent)}
.cl-fact.is-warn{color:var(--cl-warn);background:color-mix(in srgb,var(--cl-warn) 10%,transparent);border-color:color-mix(in srgb,var(--cl-warn) 30%,transparent)}
.cl-fact.is-model{font-family:var(--cl-mono);font-size:11px}
a.cl-fact{color:var(--cl-text);transition:background .15s,border-color .15s}
a.cl-fact:hover{background:var(--cl-hover);border-color:var(--cl-border-2)}
.cl-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:auto;padding-top:12px;border-top:1px solid color-mix(in srgb,var(--cl-border) 75%,transparent)}
.cl-more{margin-left:auto}
.cl-chev{transition:transform .2s ease}
.cl-more.is-open .cl-chev{transform:rotate(180deg)}
.cl-sessions{list-style:none;margin:0;padding:4px;display:flex;flex-direction:column;gap:2px;border-radius:12px;animation:cl-fade .25s ease both;
background:color-mix(in srgb,var(--cl-text) 3%,transparent);border:1px solid color-mix(in srgb,var(--cl-border) 75%,transparent)}
.cl-session{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;gap:8px;padding:6px 6px 6px 8px;border-radius:9px}
.cl-session:hover{background:var(--cl-hover)}
.cl-session-title{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cl-session-when{font-size:11.5px;color:var(--cl-muted);white-space:nowrap}
.cl-session-when.is-warn{color:var(--cl-warn)}
.cl-off-row{display:flex;flex-wrap:wrap;gap:10px}
.cl-off{display:inline-flex;align-items:center;gap:10px;padding:5px 16px 5px 5px;border-radius:999px;cursor:pointer;font:inherit;text-align:left;
color:var(--cl-text);opacity:.8;background:color-mix(in srgb,var(--cl-card) 75%,transparent);border:1px solid var(--cl-border);
transition:opacity .15s,border-color .15s,background .15s,transform .15s}
.cl-off:hover:not(:disabled){opacity:1;transform:translateY(-1px);border-color:var(--cl-border-2);background:var(--cl-card)}
.cl-off:disabled{cursor:default}
.cl-off .cl-av-face{filter:saturate(.25)}
.cl-off-text{display:flex;flex-direction:column;line-height:1.25}
.cl-off-name{font-size:12.5px;font-weight:600}
.cl-off-when{font-size:11px;color:var(--cl-muted)}
.cl-table{border-radius:var(--cl-r-lg);overflow:hidden;border:1px solid var(--cl-border);background:var(--cl-card);box-shadow:var(--cl-shadow);margin-top:16px}
.cl-thead,.cl-row{display:grid;grid-template-columns:40px minmax(170px,1.1fr) 200px minmax(0,2.2fr) 90px 172px;align-items:center;gap:14px;padding:0 16px}
.cl-thead{height:38px;font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--cl-muted);
background:var(--cl-elev);border-bottom:1px solid var(--cl-border)}
.cl-row{position:relative;min-height:64px;border-bottom:1px solid color-mix(in srgb,var(--cl-border) 75%,transparent);transition:background .15s}
.cl-row:last-child{border-bottom:0}
.cl-row:hover{background:var(--cl-hover)}
.cl-row::before{content:'';position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:0 3px 3px 0;background:var(--cl-sc);opacity:0}
.cl-row.cl-st-approval::before,.cl-row.cl-st-question::before,.cl-row.cl-st-interrupted::before,.cl-row.cl-st-unread::before,.cl-row.cl-st-working::before{opacity:1}
.cl-row.cl-flash{animation:cl-row-flash 1.6s ease}
.cl-row-who,.cl-row-doing{min-width:0}
.cl-row-doing{display:flex;flex-direction:column;gap:1px}
.cl-row-session{font-size:11.5px;color:var(--cl-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cl-row-activity{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cl-row-when{font-size:12px;color:var(--cl-muted);white-space:nowrap}
.cl-row-act{display:flex;justify-content:flex-end}
@media (max-width:900px){.cl-thead{display:none}.cl-row{grid-template-columns:36px minmax(0,1fr) auto auto;padding:10px 14px}.cl-row-doing,.cl-row-when{display:none}}
.cl-floor.is-skeleton{margin-top:16px}
.cl-skel{display:flex;flex-direction:column;gap:12px;height:206px;padding:15px;border-radius:var(--cl-r-lg);background:var(--cl-card);border:1px solid var(--cl-border)}
.cl-skel i,.cl-skel-av{display:block;height:10px;border-radius:7px;background:color-mix(in srgb,var(--cl-text) 8%,transparent);animation:cl-breathe 1.4s ease-in-out infinite}
.cl-skel-row{display:flex;align-items:center;gap:12px}
.cl-skel-av{flex:none;width:44px;height:44px !important;border-radius:50% !important}
.cl-skel-col{flex:1;display:flex;flex-direction:column;gap:8px}
.cl-skel .w60{width:60%}.cl-skel .w40{width:40%}.cl-skel .w80{width:80%}
.cl-skel .cl-skel-block{height:62px;border-radius:12px}
.cl-empty{display:flex;flex-direction:column;align-items:center;gap:14px;padding:70px 0;color:var(--cl-muted);text-align:center}
.cl-empty-icon{width:66px;height:66px;border-radius:21px;display:grid;place-items:center;color:var(--cl-aim);animation:cl-float 4s ease-in-out infinite;
background:color-mix(in srgb,var(--cl-aim) 12%,transparent);border:1px solid color-mix(in srgb,var(--cl-aim) 26%,transparent)}
.cl-empty-text{max-width:420px}
.cl-error{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:14px 28px 0;padding:10px 14px;border-radius:12px;
color:var(--cl-danger);background:color-mix(in srgb,var(--cl-danger) 10%,transparent);border:1px solid color-mix(in srgb,var(--cl-danger) 35%,transparent)}
.cl-error-text{display:inline-flex;align-items:center;gap:8px}
.cl-foot{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:12px 28px 24px;color:var(--cl-muted);font-size:12px}
.cl-foot>.cl-ico{color:var(--cl-ok)}
.cl-foot-time{margin-left:auto;font-variant-numeric:tabular-nums}
.cl-btn-approve{border-color:transparent;color:var(--cl-bg);font-weight:600;background:var(--cl-accent)}
.cl-btn-approve:hover{border-color:transparent;background:color-mix(in srgb,var(--cl-accent) 85%,var(--cl-strong))}
.cl-btn-deny{color:var(--cl-danger);border-color:color-mix(in srgb,var(--cl-danger) 35%,transparent);background:color-mix(in srgb,var(--cl-danger) 8%,transparent)}
.cl-btn-deny:hover{border-color:color-mix(in srgb,var(--cl-danger) 55%,transparent);background:color-mix(in srgb,var(--cl-danger) 15%,transparent)}
.cl-btn:disabled,.cl-btn:disabled:hover{opacity:.6;cursor:default}
.cl-decide{display:inline-flex;gap:8px}
.cl-decide.is-compact{gap:6px}
.cl-decide.is-compact .cl-btn{width:28px;height:26px;padding:0;border-radius:8px}
.cl-icon-btn-sm{width:30px;height:30px;border-radius:9px}
.cl-spin{animation:cl-spin .8s linear infinite}
.cl-session-act,.cl-row-act{display:inline-flex;align-items:center;justify-content:flex-end;gap:6px}
.cl-peek{position:absolute;inset:0;z-index:40;display:flex;justify-content:flex-end}
.cl-peek-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.45);animation:cl-fade .2s ease both}
.cl-peek-panel{position:relative;width:min(560px,100%);height:100%;display:flex;flex-direction:column;overflow:hidden;
background:var(--cl-card);border-left:1px solid var(--cl-border);box-shadow:-12px 0 32px rgba(0,0,0,.35);animation:cl-slide .22s ease-out both}
.cl-peek-panel::before{content:'';position:absolute;left:0;right:0;top:0;height:3px;background:var(--cl-sc)}
.cl-peek-panel.cl-st-choice::before,.cl-peek-panel.cl-st-waiting::before,.cl-peek-panel.cl-st-idle::before{display:none}
.cl-peek-head{display:flex;align-items:center;gap:12px;padding:18px 18px 14px;border-bottom:1px solid var(--cl-border)}
.cl-peek-kicker{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--cl-muted)}
.cl-peek-body{flex:1;min-height:0;overflow-y:auto;padding:0 18px 8px}
.cl-peek-sec{display:flex;flex-direction:column;gap:8px;padding:14px 0;border-bottom:1px solid color-mix(in srgb,var(--cl-border) 70%,transparent)}
.cl-peek-sec:last-child{border-bottom:0}
.cl-peek-h{margin:0;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--cl-muted)}
.cl-peek-title{font-size:15px;font-weight:650;color:var(--cl-strong)}
.cl-peek-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.cl-peek-text{line-height:1.55;white-space:pre-wrap;word-break:break-word}
.cl-md,.cl-peek-msg{font-size:15px;line-height:1.7;color:var(--cl-strong);overflow-wrap:anywhere;padding:14px 16px;border-radius:12px;
background:var(--cl-elev);border:1px solid var(--cl-border)}
.cl-peek-msg{white-space:pre-wrap}
.cl-md>*{margin:0}.cl-md>*+*{margin-top:10px}
.cl-md-h{font-size:15.5px;font-weight:700}
.cl-md-list{padding-left:22px}.cl-md-list li+li{margin-top:4px}
.cl-md a{color:var(--cl-accent);text-decoration:underline;text-underline-offset:2px}
.cl-md-code{font-family:var(--cl-mono);font-size:.86em;padding:1px 5px;border-radius:5px;background:color-mix(in srgb,var(--cl-text) 10%,transparent)}
.cl-md-pre{padding:10px 12px;border-radius:9px;font-family:var(--cl-mono);font-size:12.5px;line-height:1.55;white-space:pre-wrap;
background:color-mix(in srgb,var(--cl-text) 7%,var(--cl-bg));border:1px solid var(--cl-border)}
.cl-md-tablewrap{overflow-x:auto}
.cl-md-table{border-collapse:collapse;font-size:13px;line-height:1.45}
.cl-md-table th,.cl-md-table td{padding:6px 10px;text-align:left;vertical-align:top;border:1px solid var(--cl-border)}
.cl-md-table th{font-weight:650;background:color-mix(in srgb,var(--cl-text) 6%,transparent)}
.cl-peek-code{margin:0;max-height:220px;overflow:auto;padding:10px 12px;border-radius:10px;font-family:var(--cl-mono);font-size:12px;line-height:1.5;
white-space:pre-wrap;overflow-wrap:anywhere;color:var(--cl-strong);background:color-mix(in srgb,var(--cl-text) 7%,var(--cl-bg));
border:1px solid color-mix(in srgb,var(--cl-warn) 32%,var(--cl-border))}
.cl-peek-note{font-size:12px;color:var(--cl-muted)}
.cl-peek-opts{display:flex;flex-wrap:wrap;gap:6px}
.cl-peek-opt{padding:4px 10px;border-radius:999px;font-size:12px;background:var(--cl-elev);border:1px solid var(--cl-border)}
.cl-tasks{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px}
.cl-task{display:flex;align-items:flex-start;gap:8px}
.cl-task .cl-ico{margin-top:2px;color:var(--cl-muted)}
.cl-task.is-done{color:var(--cl-muted)}
.cl-task.is-done .cl-ico,.cl-task.is-current .cl-ico{color:var(--cl-accent)}
.cl-task.is-current{font-weight:600;color:var(--cl-strong)}
.cl-peek-foot{display:flex;align-items:center;gap:10px;padding:12px 18px;border-top:1px solid var(--cl-border)}
.cl-peek-hint{flex:1;font-size:12px;color:var(--cl-muted)}
@keyframes cl-slide{from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:none}}
@keyframes cl-spin{to{transform:rotate(360deg)}}
@keyframes cl-breathe{0%,100%{opacity:1}50%{opacity:.4}}
@keyframes cl-ping{0%{box-shadow:0 0 0 0 color-mix(in srgb,currentColor 60%,transparent)}80%,100%{box-shadow:0 0 0 7px transparent}}
@keyframes cl-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes cl-fade{from{opacity:0}to{opacity:1}}
@keyframes cl-flash{0%{opacity:0}15%{opacity:1}100%{opacity:0}}
@keyframes cl-row-flash{0%,100%{background:transparent}20%{background:color-mix(in srgb,var(--cl-aim) 18%,transparent)}}
@keyframes cl-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
@keyframes cl-nudge{0%,80%,100%{transform:rotate(0)}85%{transform:rotate(-12deg)}90%{transform:rotate(12deg)}95%{transform:rotate(-6deg)}}
@keyframes cl-dots{0%,60%,100%{opacity:.25;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}
@media (prefers-reduced-motion:reduce){.cl-root *,.cl-root *::before,.cl-root *::after{animation:none !important;transition:none !important}.cl-scroll{scroll-behavior:auto}}
`
