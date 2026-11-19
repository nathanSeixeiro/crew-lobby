// node --test test/lobby.test.mjs
// Pure-logic and render-path tests. No browser, no network, no Kiro Crew needed.
import test from 'node:test'
import assert from 'node:assert/strict'

// Minimal stand-in for the host React: enough to load the module and walk a render tree.
const stubReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
}
globalThis.window = { __kirocrew_modules: { react: stubReact, '@kirocrew/app-sdk': {} } }

const lobbyModule = await import('../app/ui/index.mjs')
const { buildLobby, sessionState, presenceOf, toMs, duration, withSeenDefaults, activityLine, inkFor, LobbyView, STR } = lobbyModule
const { approvalOf, commandOf, canDecide, decisionError, findSession, parseBlocks, stripOptions } = lobbyModule

// Host elements of a stub-React tree, function components resolved, that match `pred`.
function findAll(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, pred, out)
    return out
  }
  if (typeof node.type === 'function') return findAll(node.type({ ...node.props, children: node.children }), pred, out)
  if (pred(node)) out.push(node)
  for (const child of node.children || []) findAll(child, pred, out)
  return out
}
const hasClass = (name) => (node) => String(node.props?.className || '').split(' ').includes(name)
const { createScenario } = await import('../preview/mock-data.mjs')

const T0 = Date.parse('2026-10-30T15:00:00Z')
const at = (seconds) => T0 + seconds * 1000

function render(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(render).join(' ')
  if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }))
  return node.children.map(render).join(' ')
}

function lobbyAt(seconds, seen) {
  const scenario = createScenario(T0)
  const slots = scenario.slots(at(seconds))
  return { lobby: buildLobby({ slots, agents: scenario.agents, seen: withSeenDefaults(seen, slots), now: at(seconds) }), slots }
}

const find = (lobby, id) => lobby.colleagues.find((c) => c.id === id)

test('toMs reads epoch seconds, epoch ms, numeric text and ISO text', () => {
  assert.equal(toMs(1793384825), 1793384825000)
  assert.equal(toMs(1793384825000), 1793384825000)
  assert.equal(toMs('1793384825.5'), 1793384825500)
  assert.equal(toMs('2026-10-30T15:00:00Z'), T0)
  assert.equal(toMs(''), 0)
  assert.equal(toMs('not a date'), 0)
  assert.equal(toMs(null), 0)
})

test('duration buckets', () => {
  assert.equal(duration(0, T0), null)
  assert.equal(duration(T0 - 30_000, T0), '')
  assert.equal(duration(T0 - 12 * 60_000, T0), '12 min')
  assert.equal(duration(T0 - 3 * 3_600_000, T0), '3 h')
  assert.equal(duration(T0 - 3 * 86_400_000, T0), '3 d')
})

test('sessionState follows the urgency order', () => {
  const agentTs = '2026-10-30T15:00:00Z'
  assert.equal(sessionState({ pending_approval: true, running: true }), 'approval')
  assert.equal(sessionState({ needs_input: true, running: true }), 'question')
  assert.equal(sessionState({ running: true }), 'working')
  assert.equal(sessionState({ compacting: true }), 'working')
  assert.equal(sessionState({ interrupted: true, last_agent_ts: agentTs }), 'interrupted')
  assert.equal(sessionState({ waiting_for_input: true, last_agent_ts: agentTs }, 0), 'unread')
  assert.equal(sessionState({ waiting_for_input: true, last_agent_ts: agentTs }, T0), 'waiting')
  assert.equal(sessionState({ has_options: true, last_agent_ts: agentTs }, T0), 'choice')
  assert.equal(sessionState({ waiting_for_input: true, muted: true, last_agent_ts: agentTs }, 0), 'waiting')
  assert.equal(sessionState({}), 'idle')
})

test('sessions group under the crewmate that owns or opened them', () => {
  const { lobby } = lobbyAt(5, {})
  const felix = find(lobby, 'felix-conserta')
  assert.ok(felix, 'felix present')
  assert.equal(felix.displayName, 'Felix Conserta')
  assert.deepEqual(felix.sessions.map((se) => se.key).sort(), ['dashboard:chat-41-mock', 'member-felix-conserta.memory-member-felix-conserta-0a1b2c'])
  assert.equal(find(lobby, 'k8s-troubleshooter').sessions.length, 1, 'worker is not double-counted under its agent')
  assert.equal(find(lobby, 'andre').sessions.length, 1, 'member DM key maps to the roster name')
  assert.equal(find(lobby, 'devops-agent').sessions.length, 3, 'agent without a roster row still shows up')
  assert.equal(find(lobby, 'some-project-agent'), undefined, 'project-scope agent definitions are not crewmates')
  assert.ok(!lobby.colleagues.some((c) => c.sessions.some((se) => se.key === '_optimizer')), 'internal slots hidden')
})

test('presence and zones', () => {
  const { lobby } = lobbyAt(5, {})
  assert.equal(find(lobby, 'legolas').presence, 'offline')
  assert.equal(find(lobby, 'legolas').zone, 'offline')
  assert.equal(find(lobby, 'andre').presence, 'away')
  assert.equal(find(lobby, 'andre').zone, 'available')
  assert.equal(find(lobby, 'k8s-troubleshooter').zone, 'offline', 'only session is 3 days old')
  assert.equal(find(lobby, 'legacy-modernizer').zone, 'needs')
  assert.equal(find(lobby, 'auto-improvement-engineer').state, 'interrupted')
  assert.equal(find(lobby, 'devops-agent').state, 'working')
  assert.equal(presenceOf({ sessions: [], lastActivity: 0 }, T0), 'offline')
})

test('needs-you sorts first; stalled work is flagged', () => {
  const { lobby } = lobbyAt(5, {})
  assert.equal(lobby.colleagues[0].zone, 'needs')
  const issueRadar = find(lobby, 'devops-agent').sessions.find((se) => se.key === 'dashboard:chat-23-mock')
  assert.equal(issueRadar.stalled, true)
  assert.equal(issueRadar.app, 'issue-radar')
})

test('the worker cycle: working -> approval -> working -> finished unread -> read', () => {
  const seenAtStart = withSeenDefaults({}, createScenario(T0).slots(at(1)))

  const working = find(lobbyAt(5, seenAtStart).lobby, 'felix-conserta')
  assert.equal(working.state, 'working')
  assert.equal(working.focus.todo.current, 'Ler logs do container anterior')

  const approval = find(lobbyAt(25, seenAtStart).lobby, 'felix-conserta')
  assert.equal(approval.state, 'approval')
  assert.equal(approval.zone, 'needs')
  assert.match(activityLine(approval.focus, STR.pt), /^Quer executar shell: Ler o log/)
  assert.equal(commandOf(approval.focus.approval), 'kubectl --context eks-hml logs deploy/corp-sigo-web --previous --tail=200')
  assert.ok(canDecide(approval.focus), 'a native request can be decided from the lobby')

  const { lobby: doneLobby, slots: doneSlots } = lobbyAt(50, seenAtStart)
  const done = find(doneLobby, 'felix-conserta')
  assert.equal(done.state, 'unread')
  assert.equal(done.unreadCount, 1)
  assert.equal(doneLobby.counts.unread, 1)

  const worker = doneSlots.find((slot) => slot.key === 'dashboard:chat-41-mock')
  const seenAfterOpen = { ...seenAtStart, [worker.key]: toMs(worker.last_agent_ts) }
  const read = find(lobbyAt(50, seenAfterOpen).lobby, 'felix-conserta')
  assert.equal(read.state, 'waiting')
  assert.equal(read.zone, 'available')

  const nextCycle = find(lobbyAt(110, seenAfterOpen).lobby, 'felix-conserta')
  assert.equal(nextCycle.state, 'unread', 'a new reply after reading is unread again')
})

test('first observation never floods unread', () => {
  const scenario = createScenario(T0)
  const slots = scenario.slots(at(50))
  const lobby = buildLobby({ slots, agents: scenario.agents, seen: withSeenDefaults({}, slots), now: at(50) })
  assert.equal(lobby.counts.unread, 0)
})

test('crewmate colors, readable names and initials ink', () => {
  const { lobby } = lobbyAt(5, {})
  assert.equal(find(lobby, 'felix-conserta').color, '#21a5de', 'roster avatar.bg is used')
  assert.equal(find(lobby, 'auto-improvement-scout').color, '#0d9488', 'session_color when there is no icon bg')
  assert.equal(find(lobby, 'felix-conserta').ink, '#fff')
  assert.equal(find(lobby, 'legolas').ink, '#1b1d24', 'dark initials on a light avatar color')
  assert.equal(find(lobby, 'devops-agent').displayName, 'Devops Agent')
  assert.equal(find(lobby, 'devops-agent').initials, 'DA')
  assert.equal(inkFor('#9d2561'), '#fff')
  assert.equal(inkFor('not-a-color'), '#fff')
})

test('pt and en strings have the same keys', () => {
  const keys = (obj) => Object.keys(obj).sort().join(',')
  assert.equal(keys(STR.pt), keys(STR.en))
  for (const group of ['zones', 'states', 'presence', 'stats', 'units', 'cols', 'notifyMsg']) {
    assert.equal(keys(STR.pt[group]), keys(STR.en[group]), group)
  }
})

test('links only keep http(s) URLs', () => {
  const lobby = buildLobby({
    slots: [{ key: 'k1', agent: 'a', waiting_for_input: true, source_links: [{ number: 1, url: 'javascript:alert(1)' }, { number: 2, url: 'https://github.com/x/y/pull/2', ci: 'failure' }] }],
    now: T0,
  })
  assert.deepEqual(lobby.colleagues[0].sessions[0].links, [{ label: 'PR #2', url: 'https://github.com/x/y/pull/2' }])
})

test('LobbyView renders room and list views in both languages', () => {
  const { lobby } = lobbyAt(25, withSeenDefaults({}, createScenario(T0).slots(at(1))))
  const base = {
    lobby,
    now: at(25),
    query: '',
    expanded: { 'devops-agent': true },
    setPref: () => {},
    setQuery: () => {},
    onToggle: () => {},
    onOpen: () => {},
    onMarkRead: () => {},
    onMarkAllRead: () => {},
    onRefresh: () => {},
    error: '',
    updatedAt: at(25),
  }
  const room = render(LobbyView({ ...base, s: STR.pt, lang: 'pt', prefs: { view: 'room', onlyNeeds: false, notifyOn: true } }))
  for (const text of ['Precisa de você', 'Aguardando aprovação', 'Pergunta pra você', 'Felix Conserta', 'Abrir sessão', 'Offline', 'Legolas', 'PR #318', 'sem saída há', 'outra sessão sem saída']) {
    assert.ok(room.includes(text), `room view shows "${text}"`)
  }
  const list = render(LobbyView({ ...base, s: STR.en, lang: 'en', prefs: { view: 'list', onlyNeeds: true, notifyOn: true } }))
  assert.ok(list.includes('Awaiting approval'))
  assert.ok(!list.includes('Legolas'), 'only-needs filter hides offline crewmates')
  const loading = render(LobbyView({ ...base, lobby: null, s: STR.pt, lang: 'pt', prefs: { view: 'room' } }))
  assert.ok(loading.includes('Carregando a equipe'))
})

test('approve/deny targets only native requests and maps refusals', () => {
  const native = { origin: 'native', request_id: 'r1', request_mid: 'm1', tool: 'shell' }
  assert.equal(canDecide({ state: 'approval', approval: approvalOf(native) }), true)
  assert.equal(canDecide({ state: 'approval', approval: approvalOf({ origin: 'coordinator', request_id: 'r1', tool: 'spawn' }) }), false)
  assert.equal(canDecide({ state: 'approval', approval: approvalOf({ origin: 'native', request_id: 'r1' }) }), false, 'needs request_mid')
  assert.equal(canDecide({ state: 'working', approval: approvalOf(native) }), false)
  assert.equal(commandOf(approvalOf({ tool_input: 'ls -la' })), 'ls -la')
  assert.equal(commandOf(approvalOf({ tool_input: '{"path":"/tmp/x"}' })), '{"path":"/tmp/x"}')
  assert.equal(decisionError({ status: 403 }, STR.pt), STR.pt.decideForbidden)
  assert.equal(decisionError(new Error('404: no pending approval'), STR.pt), STR.pt.decideGone)
  assert.equal(decisionError(new Error('boom'), STR.en), 'Could not decide: boom')
})

test('Peek shows the request, and a decision moves the worker on', () => {
  const scenario = createScenario(T0)
  const seen = withSeenDefaults({}, scenario.slots(at(1)))
  const before = buildLobby({ slots: scenario.slots(at(25)), agents: scenario.agents, seen, now: at(25) })
  const hit = findSession(before, 'dashboard:chat-41-mock')
  assert.equal(hit.person.id, 'felix-conserta')
  const props = {
    lobby: before, s: STR.pt, lang: 'pt', now: at(25), prefs: { view: 'room' }, query: '', expanded: {}, error: '', updatedAt: at(25),
    peekKey: hit.se.key, deciding: {}, setPref() {}, setQuery() {}, onToggle() {}, onOpen() {}, onMarkRead() {}, onMarkAllRead() {}, onRefresh() {},
  }
  const peek = render(LobbyView(props))
  for (const text of ['Espiando', 'Pedido de aprovação', 'kubectl --context eks-hml logs', 'Plano · 2/5 passos', 'Ler eventos do pod', 'Última mensagem', 'Aprovar', 'Negar', 'Outras sessões']) {
    assert.ok(peek.includes(text), `peek shows "${text}"`)
  }
  assert.ok(!render(LobbyView({ ...props, peekKey: null })).includes('Espiando'), 'no panel without a peek key')
  const busy = render(LobbyView({ ...props, deciding: { [hit.se.key]: 'approved' } }))
  assert.ok(busy.includes('Aprovando…'))
  assert.throws(() => scenario.decide(hit.se.key, { request_id: 'nope', action: 'approved', origin: 'native' }), /404/)
  scenario.decide(hit.se.key, { request_id: hit.se.approval.requestId, request_mid: hit.se.approval.requestMid, action: 'approved', origin: 'native' })
  const after = buildLobby({ slots: scenario.slots(at(26)), agents: scenario.agents, seen, now: at(26) })
  assert.equal(findSession(after, hit.se.key).se.state, 'working')
})

test('markdown-lite: headings, paragraphs, lists, code and tables; options dropped', () => {
  const md = '# Título\n\nUm parágrafo\ncom quebra.\n\n- um\n- dois\n\n1. primeiro\n2. segundo\n\n```\nkubectl get pods\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |'
  const blocks = parseBlocks(md)
  assert.deepEqual(blocks.map((b) => b.type), ['h', 'p', 'ul', 'ol', 'code', 'table'])
  assert.deepEqual(blocks[1].lines, ['Um parágrafo', 'com quebra.'])
  assert.deepEqual(blocks[2].items, ['um', 'dois'])
  assert.equal(blocks[4].text, 'kubectl get pods')
  assert.deepEqual(blocks[5].rows, [['A', 'B'], ['1', '2']])
  assert.equal(stripOptions('Próximo passo?\n[OPTIONS: Sim | Não]'), 'Próximo passo?')
})

test('Peek shows the full reply, safe links only, and falls back to the preview', () => {
  const { lobby } = lobbyAt(25, withSeenDefaults({}, createScenario(T0).slots(at(1))))
  const key = 'dashboard:chat-41-mock'
  const base = {
    lobby, s: STR.pt, lang: 'pt', now: at(25), prefs: { view: 'room' }, query: '', expanded: {}, error: '', updatedAt: at(25),
    peekKey: key, deciding: {}, setPref() {}, setQuery() {}, onToggle() {}, onOpen() {}, onMarkRead() {}, onMarkAllRead() {}, onRefresh() {},
  }
  const text = '**Achei** o motivo.\n\n[guia](https://example.com) e [x](javascript:alert(1))\n\n| Recurso | Depois |\n|---|---|\n| limits | 1Gi |\n[OPTIONS: Sim | Não]'
  const tree = LobbyView({ ...base, peekFull: { key, available: true, text } })
  const shown = render(tree)
  for (const piece of ['Achei', 'o motivo.', 'Recurso', '1Gi']) assert.ok(shown.includes(piece), `full reply shows "${piece}"`)
  assert.ok(!shown.includes('[OPTIONS:') && !shown.includes('Carregando a mensagem'))
  const md = findAll(tree, hasClass('cl-md'))
  assert.equal(md.length, 1)
  assert.deepEqual(findAll(md[0], (n) => n.type === 'a').map((a) => a.props.href), ['https://example.com'])
  assert.ok(render(md[0]).includes('[x](javascript:alert(1))'), 'a javascript: link stays plain text')

  const preview = render(LobbyView({ ...base, peekFull: { key, available: false, reason: 'unreachable' } }))
  assert.ok(preview.includes('Preciso do log do container anterior') && preview.includes(STR.pt.peekPreviewOnly))
  const priv = render(LobbyView({ ...base, peekFull: { key, available: false, reason: 'private session' } }))
  assert.ok(priv.includes(STR.pt.peekPrivate))
  assert.ok(render(LobbyView({ ...base, peekFull: null })).includes(STR.pt.peekLoading))
})

test('clicking a desk bubble opens Peek on that session', () => {
  const { lobby } = lobbyAt(25, withSeenDefaults({}, createScenario(T0).slots(at(1))))
  const peeked = []
  const tree = LobbyView({
    lobby, s: STR.pt, lang: 'pt', now: at(25), prefs: { view: 'room' }, query: '', expanded: {}, error: '', updatedAt: at(25),
    setPref() {}, setQuery() {}, onToggle() {}, onOpen() {}, onMarkRead() {}, onMarkAllRead() {}, onRefresh() {}, onPeek: (k) => peeked.push(k),
  })
  const bubbles = findAll(tree, hasClass('is-clickable'))
  assert.ok(bubbles.length >= 3)
  bubbles[0].props.onClick()
  assert.equal(peeked[0], find(lobby, 'felix-conserta').focus.key)
})
