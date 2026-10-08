import type { CommandInfo, HttpResponse, On, TurnStepInput } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { mock } from 'claude-code/testing'

// The world beneath the plugin, shared by the test files: a key, a skill list, a Jev that
// answers `reply` (or fails with 'error'), ~/.config/jev in memory, and bottoms for
// prompt.submit, turn.step and the status line that record what reached them.

export type Reply = {
  tier?: Record<string, number>
  risky?: number
  skill?: Record<string, number>
  subject?: Record<string, number>
  output?: Record<string, number>
}

/** What the menu bar widget writes to settings.json; anything left out takes the default. */
export type WidgetSettings = {
  mode?: 'auto' | 'shadow' | 'off'
  focus?: number
  effort?: boolean
  skills?: boolean
  specialists?: boolean
  nudge?: { target: string; by: 1 | -1; id: string } | null
}

export const JEV = '/home/t/.config/jev'

const top = (probabilities: Record<string, number>) =>
  Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'none'

export function world(on: On, reply: { current: Reply | 'error' }, env: Record<string, string> = { TYPESAFE_API_KEY: 'test-key' }) {
  mock.env(on, { HOME: '/home/t', ...env })
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  const requests: { questions: Record<string, unknown> }[] = []
  const steps: TurnStepInput[] = []
  const statuses: (string | undefined)[] = []
  // ~/.config/jev/ in memory; no api_key file, so the key comes from env.
  const files = new Map<string, string>()

  on('fs.read', async ($, e) => {
    const text = files.get(e.path)
    return text === undefined ? { deny: 'missing' } : { value: text }
  })
  on('fs.write', async ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('ui.status', async ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.id', async () => ({ value: 'sess-a' }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  const commands: CommandInfo[] = [
    { name: 'data:sql-queries', description: 'Write correct, performant SQL across warehouse dialects.', source: 'plugin' },
    { name: 'pdf-viewer:open', description: 'Open a PDF in the interactive viewer.', source: 'plugin' },
    { name: 'help', description: 'Show help', source: 'builtin' },
  ]
  on('command.list', async () => ({ value: commands }))
  on('http.fetch', async ($, e) => {
    const body = JSON.parse(e.init?.body ?? '{}') as { questions: Record<string, unknown> }
    requests.push(body)
    const r = reply.current
    if (r === 'error') return { value: { status: 500, ok: false, headers: {}, text: '' } as HttpResponse }
    // Like the real Jev, only the questions asked get answers.
    const asked = body.questions ?? {}
    const answers: Record<string, unknown> = {}
    if (r.tier && asked.tier) answers.tier = { type: 'choice', choice: top(r.tier), probabilities: r.tier, confidence: 0.8 }
    if (r.risky !== undefined && asked.risky) answers.risky = { type: 'noul', noul: r.risky }
    if (r.skill && asked.skill) answers.skill = { type: 'choice', choice: top(r.skill), probabilities: r.skill, confidence: 0.8 }
    if (r.subject && asked.subject) answers.subject = { type: 'choice', choice: top(r.subject), probabilities: r.subject, confidence: 0.9 }
    if (r.output && asked.output) answers.output = { type: 'choice', choice: top(r.output), probabilities: r.output, confidence: 0.9 }
    const value: HttpResponse = { status: 200, ok: true, headers: {}, text: JSON.stringify({ model: 'jev-1.13.0', answers }) }
    return { value }
  })
  on('prompt.submit', async ($, e) => ({ text: e.text, context: e.context }))
  on('turn.step', async function* ($, e) {
    steps.push(e)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })

  // Each write is newer than the last, as the widget's own writes are.
  let widgetAt = 2_000_000
  const widget = (patch: WidgetSettings = {}) =>
    files.set(
      `${JEV}/settings.json`,
      JSON.stringify({ version: 1, mode: 'auto', focus: 2, effort: false, skills: true, specialists: true, nudge: null, ...patch, updatedAt: ++widgetAt, updatedBy: 'widget' }),
    )

  return { clock, requests, steps, statuses, files, widget }
}

export const submit = ($: Engine, text: string, kind: 'composer' | 'scheduled-trigger' | 'task-notification' = 'composer') =>
  $.prompt.submit({ text, wait: false, origin: { kind } })

/** One request of the turn, sent as the session would: on Opus 5.5 at xhigh effort, unless told otherwise. */
export async function step($: Engine, model = 'claude-opus-5-5') {
  const stream = $.turn.step({ turnId: 't', index: 0, model, effort: 'xhigh', messageCount: 1 })
  for await (const _ of stream) {
  }
  return stream.result
}

export async function startSession($: Engine, on: On) {
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('command.register', async ($, e) => ({ value: { command: e.name } }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
}

export const jev = ($: Engine, args: string) =>
  $.command.run({ command: 'jev', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
