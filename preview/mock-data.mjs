// Simulated crew for the preview and the tests. Field names match GET /api/chat/slots
// (kiro_crew/dashboard/slot_projection.py) and GET /api/agents, so the app runs the same
// code path it runs inside Kiro Crew.
//
// One worker session loops every 60 s: working -> awaiting approval -> working -> finished.
// Approve/Deny on the worker's request moves it on at once (see decide()).

const CYCLE_MS = 60_000
const iso = (ms) => new Date(ms).toISOString()
const WORKER = 'dashboard:chat-41-mock'
const PLAN = ['Ler eventos do pod', 'Checar limits e requests', 'Ler logs do container anterior', 'Confirmar causa do restart', 'Abrir PR no gitops']
const POC_PLAN = [
  'Levantar os dados da Crew',
  'Escrever a POC',
  'Escrever a issue',
  'Refazer o visual',
  'Publicar no GitHub',
  'Validar manifest e rodar testes',
  'Instalar na Crew',
]
// The todo payload shape of slot_todo.todo_payload().
const todoOf = (description, tasks, done) => ({
  description,
  tasks: tasks.map((text, i) => ({ id: String(i + 1), text, completed: i < done })),
  completed: done,
  total: tasks.length,
  current: tasks[done] || '',
})

export const MOCK_AGENTS = [
  { name: 'default', display_name: 'Mate', description: 'Assistente padrão da Crew', model: 'auto', kiro_agent: 'devops-agent', scope: 'global', avatar: {} },
  // Avatars use the real roster shape ({ kind: 'icon', pose, bg }) of this machine's crewmates.
  { name: 'felix-conserta', display_name: 'Felix Conserta', description: 'Diagnostica e corrige incidentes em K8s', model: 'claude-opus-4.5', kiro_agent: 'k8s-troubleshooter', scope: 'global', avatar: { kind: 'icon', pose: 'pose-8', bg: '#21a5de' } },
  { name: 'legolas', display_name: 'Legolas', description: 'Revisões de Terraform', model: 'auto', kiro_agent: 'devops-agent', scope: 'global', avatar: { kind: 'icon', pose: 'pose-1', bg: '#eeae4f' } },
  { name: 'andre', display_name: 'André', description: 'Modernização de apps .NET', model: 'auto', kiro_agent: 'legacy-modernizer', scope: 'global', avatar: { kind: 'icon', pose: 'pose-2', bg: '#9d2561' } },
  { name: 'auto-improvement-engineer', display_name: 'Auto-Improve Engineer', model: 'auto', scope: 'global' },
  { name: 'auto-improvement-scout', display_name: 'Auto-Improve Scout', model: 'auto', scope: 'global', session_color: '#0d9488' },
  { name: 'some-project-agent', scope: 'project' },
]

// Full replies behind the 80-character `last_message` previews, as markdown agents write.
const WORKER_ASKS = `Achei o motivo provável dos restarts.

**O que vi até agora**
- O pod reinicia a cada ~4 min com \`OOMKilled\`.
- O limite de memória está em \`512Mi\` e o uso sobe até o teto antes de cada restart.
- Nenhum deploy novo nas últimas 24 h.

Preciso do log do container anterior para confirmar o OOMKilled antes de propor o ajuste:

\`\`\`
kubectl --context eks-hml logs deploy/corp-sigo-web --previous --tail=200
\`\`\`

Se confirmar, abro um PR subindo o limite para \`1Gi\` e o request para \`768Mi\`.`

const WORKER_DONE = `PR #318 aberto com os novos limites. O CI está rodando.

| Recurso | Antes | Depois |
|---|---|---|
| requests.memory | 384Mi | 768Mi |
| limits.memory | 512Mi | 1Gi |

**Próximos passos**
1. Esperar o CI do PR #318.
2. Acompanhar o rollout por 15 min.
3. Fechar o alerta se não houver novo restart.

Quer que eu acompanhe o rollout?`

const LONG_REPLIES = {
  'dashboard:chat-41-mock': (slot) => (slot.pending_approval ? WORKER_ASKS : slot.waiting_for_input ? WORKER_DONE : ''),
  'dashboard:chat-30-mock': `PR #152 validado no eks-dev. Próximo passo?

**Resumo do plan**
- NodePool com as gerações 5, 6 e 7
- \`consolidateAfter\` de 1m para 10m
- Orçamento de disrupção: 1 nó por vez

[OPTIONS: Abrir PR para hml | Rodar plan de novo | Encerrar]`,
  'member-andre.memory-member-andre-9f8e7d': `Checklist de migração do SiteA pronto.

1. Atualizar para .NET Framework 4.8
2. Gerar a imagem com \`servercore:ltsc2022\`
3. Configurar o pipeline no GitHub Actions
4. Validar em hml antes de prod

Detalhes no [guia de migração](https://example.com/guia).`,
}

function base(key, extra) {
  return {
    key,
    title: '',
    agent: '',
    model: 'auto',
    served_model: '',
    running: false,
    compacting: false,
    preparing: false,
    pending_approval: false,
    pending_approval_info: null,
    needs_input: false,
    waiting_for_input: false,
    has_options: false,
    options: [],
    prompt_preview: '',
    interrupted: false,
    muted: false,
    queue_depth: 0,
    todo: null,
    source_links: [],
    created_by: '',
    app: '',
    last_message: '',
    messages: 6,
    ...extra,
  }
}

/** A scenario anchored at t0; slots(now) returns the crew as seen at `now`. */
export function createScenario(t0 = Date.now()) {
  const decisions = new Map() // request_id -> action, set by decide()
  const slots = (now = Date.now()) => {
    const cycleIndex = Math.floor((now - t0) / CYCLE_MS)
    const cycleStart = t0 + cycleIndex * CYCLE_MS
    const phase = (now - cycleStart) / 1000
    const requestId = `mock-req-${cycleIndex}`
    const decided = decisions.get(requestId)
    const felixDm = 'member-felix-conserta.memory-member-felix-conserta-0a1b2c'

    const worker = base(WORKER, {
      title: 'CrashLoopBackOff no corp-sigo-web (eks-hml)',
      agent: 'k8s-troubleshooter',
      served_model: 'claude-opus-4.5',
      created_by: felixDm,
      created: iso(t0 - 30 * 60_000),
      last_turn_ts: iso(cycleStart),
      source_links: [{ provider: 'github', kind: 'change', number: 318, url: 'https://github.com/my-org/k8s-gitops/pull/318' }],
    })
    if (phase < 20) {
      Object.assign(worker, {
        running: true,
        last_activity_ts: iso(now - 3000),
        last_agent_ts: iso(now - 3000),
        last_message: 'Lendo os eventos do pod e o último log antes do restart…',
        todo: todoOf('Diagnóstico', PLAN, 2),
      })
    } else if (phase < 32 && !decided) {
      // Same shape as slot_projection's native pending_approval_info.
      Object.assign(worker, {
        running: true,
        pending_approval: true,
        pending_approval_info: {
          origin: 'native',
          tool: 'shell',
          tool_purpose: 'Ler o log do container anterior para confirmar o OOMKilled',
          tool_input: JSON.stringify({ command: 'kubectl --context eks-hml logs deploy/corp-sigo-web --previous --tail=200' }),
          tool_kind: 'execute',
          request_id: requestId,
          request_mid: `mid-${cycleIndex}`,
        },
        last_activity_ts: iso(cycleStart + 20_000),
        last_agent_ts: iso(cycleStart + 20_000),
        last_message: 'Preciso do log do container anterior para confirmar o OOMKilled.',
        todo: todoOf('Diagnóstico', PLAN, 2),
      })
    } else if (phase < 32) {
      Object.assign(worker, {
        running: true,
        last_activity_ts: iso(now - 1000),
        last_agent_ts: iso(now - 1000),
        last_message: decided === 'approved' ? 'Aprovado. Lendo o log do container anterior…' : 'Pedido negado. Vou seguir só pelos eventos do pod.',
        todo: todoOf('Diagnóstico', PLAN, 3),
      })
    } else if (phase < 45) {
      Object.assign(worker, {
        running: true,
        last_activity_ts: iso(now - 2000),
        last_agent_ts: iso(now - 2000),
        last_message: 'OOMKilled confirmado. Preparando PR com limits de memória 512Mi → 1Gi.',
        todo: todoOf('Diagnóstico', PLAN, 4),
      })
    } else {
      Object.assign(worker, {
        waiting_for_input: true,
        last_activity_ts: iso(cycleStart + 45_000),
        last_agent_ts: iso(cycleStart + 45_000),
        last_message: 'PR #318 aberto com limits 1Gi. CI rodando; quer que eu acompanhe o rollout?',
        source_links: [{ provider: 'github', kind: 'change', number: 318, url: 'https://github.com/my-org/k8s-gitops/pull/318' }],
      })
    }

    return [
      base(felixDm, {
        title: 'Felix Conserta',
        agent: 'felix-conserta',
        waiting_for_input: true,
        created: iso(t0 - 3 * 3_600_000),
        last_activity_ts: iso(t0 - 30 * 60_000),
        last_agent_ts: iso(t0 - 30 * 60_000),
        last_message: 'Abri uma sessão para investigar o corp-sigo-web.',
      }),
      worker,
      base('dashboard:chat-31-mock', {
        title: 'Crew Lobby: issue + POC',
        agent: 'devops-agent',
        served_model: 'claude-opus-4.5',
        running: true,
        queue_depth: 1,
        created: iso(t0 - 50 * 60_000),
        last_turn_ts: iso(t0 - 6 * 60_000),
        last_activity_ts: iso(now - 20_000),
        last_agent_ts: iso(now - 20_000),
        last_message: 'Validando o manifest com o validador da própria Crew…',
        todo: todoOf('POC', POC_PLAN, 5),
      }),
      base('dashboard:chat-30-mock', {
        title: 'Karpenter spot-first (eks-dev)',
        agent: 'devops-agent',
        has_options: true,
        options: ['Abrir PR para hml', 'Rodar plan de novo', 'Encerrar'],
        prompt_preview: 'PR #152 validado no eks-dev. Próximo passo?',
        created: iso(t0 - 5 * 3_600_000),
        last_activity_ts: iso(t0 - 40 * 60_000),
        last_agent_ts: iso(t0 - 40 * 60_000),
        last_message: 'PR #152 validado no eks-dev. Próximo passo?',
        source_links: [{ provider: 'github', kind: 'change', number: 152, url: 'https://github.com/my-org/k8s-infra/pull/152' }],
      }),
      base('dashboard:chat-23-mock', {
        title: 'Issue Radar #117: terraform plan',
        agent: 'devops-agent',
        running: true,
        created: iso(t0 - 2 * 3_600_000),
        last_turn_ts: iso(t0 - 25 * 60_000),
        last_activity_ts: iso(t0 - 14 * 60_000),
        last_agent_ts: iso(t0 - 14 * 60_000),
        last_message: 'Rodando terraform plan no módulo karpenter…',
        app: 'issue-radar',
      }),
      base('dashboard:chat-18-mock', {
        title: 'AppA: .NET 4.8 + container',
        agent: 'legacy-modernizer',
        needs_input: true,
        running: true,
        created: iso(t0 - 26 * 3_600_000),
        last_activity_ts: iso(t0 - 4 * 60_000),
        last_agent_ts: iso(t0 - 4 * 60_000),
        last_message: 'Qual base image usar: servercore:ltsc2022 ou ltsc2019?',
      }),
      base('member-andre.memory-member-andre-9f8e7d', {
        title: 'André',
        agent: 'andre',
        waiting_for_input: true,
        created: iso(t0 - 30 * 3_600_000),
        last_activity_ts: iso(t0 - 2 * 3_600_000),
        last_agent_ts: iso(t0 - 2 * 3_600_000),
        last_message: 'Checklist de migração do SiteA pronto.',
      }),
      base('dashboard:chat-12-mock', {
        title: 'Auto-improve: flaky KEDA scaler',
        agent: 'auto-improvement-engineer',
        interrupted: true,
        created: iso(t0 - 3 * 3_600_000),
        last_activity_ts: iso(t0 - 40 * 60_000),
        last_agent_ts: iso(t0 - 41 * 60_000),
        last_message: 'Ajustando o fallback do ScaledObject…',
      }),
      base('dashboard:chat-27-mock', {
        title: 'Splunk fallback em 30 ScaledObjects',
        agent: 'k8s-troubleshooter',
        waiting_for_input: true,
        created: iso(t0 - 4 * 86_400_000),
        last_activity_ts: iso(t0 - 3 * 86_400_000),
        last_agent_ts: iso(t0 - 3 * 86_400_000),
        last_message: 'PR #305 mergeado.',
      }),
      base('_optimizer', { title: 'internal', agent: 'devops-agent', running: true }),
    ]
  }
  // GET /api/apps/crew-lobby/last-message (the app's backend route): the full latest reply.
  const lastMessage = (key, now = Date.now()) => {
    const slot = slots(now).find((item) => item.key === key)
    if (!slot) return { available: false, reason: 'no session by that key' }
    const long = LONG_REPLIES[key]
    const text = (typeof long === 'function' ? long(slot) : long) || slot.last_message
    if (!text) return { available: false, reason: 'no reply yet' }
    return { available: true, text, truncated: false, chars: text.length, ts: slot.last_agent_ts || '' }
  }

  // POST /api/chat/slots/{slot}/approve, strict native form.
  const decide = (key, body) => {
    const id = body && typeof body.request_id === 'string' ? body.request_id : ''
    const ok = key === WORKER && id.startsWith('mock-req-') && body.origin === 'native' && ['approved', 'rejected', 'rejected_once'].includes(body.action)
    if (!ok) {
      const err = new Error('404: no pending approval')
      err.status = 404
      throw err
    }
    decisions.set(id, body.action)
    return { ok: true, resolved: body.action }
  }
  return { agents: MOCK_AGENTS, slots, decide, lastMessage, cycleMs: CYCLE_MS }
}
