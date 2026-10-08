import { expect, test } from 'claude-code/testing'
import { pickTier } from '../lib/jev-router'
import { JEV, jev, startSession, step, submit, world, type Reply } from './harness'

test('cheapest tier that is probably enough wins; doubt rounds up', async () => {
  expect(pickTier({ mechanical: 0.9, routine: 0.1 })).toBe('mechanical')
  expect(pickTier({ mechanical: 0.6, routine: 0.3, complex: 0.1 })).toBe('routine')
  expect(pickTier({ mechanical: 0.3, routine: 0.3, complex: 0.3, deep: 0.1 })).toBe('complex')
  expect(pickTier({ complex: 0.3, deep: 0.7 })).toBe('deep')
})

test('a routine SQL prompt goes to Sonnet with the SQL skill hinted', async ($, on) => {
  const reply = { current: { tier: { mechanical: 0.05, routine: 0.85, complex: 0.1 }, risky: 0.05, skill: { none: 0.1, 'data:sql-queries': 0.85, 'pdf-viewer:open': 0.05 } } }
  const w = world(on, reply)
  const entered = await submit($, 'write a query for weekly signups by country')
  expect(entered.context?.[0]).toContain('"data:sql-queries" skill')
  const skillOptions = Object.keys((w.requests[0]?.questions.skill as { criteria: object }).criteria)
  expect(skillOptions).toEqual(['none', 'data:sql-queries', 'pdf-viewer:open'])
  await step($)
  expect(w.steps[0]?.model).toBe('claude-sonnet-5-5')
  expect(w.steps[0]?.effort).toBe('xhigh')
})

test('a risky prompt floors at Opus even when Jev calls it mechanical', async ($, on) => {
  const reply = { current: { tier: { mechanical: 0.95, routine: 0.05 }, risky: 0.9, skill: { none: 0.9, 'data:sql-queries': 0.1 } } }
  const w = world(on, reply)
  const entered = await submit($, 'rotate the production database password')
  expect(entered.context).toBeUndefined()
  await step($, 'claude-sonnet-5-5')
  expect(w.steps[0]?.model).toBe('claude-opus-5-5')
})

test('follow-ups hold the tier; ten idle minutes let it drop to Haiku', async ($, on) => {
  const reply: { current: Reply } = { current: { tier: { complex: 0.9, deep: 0.1 }, risky: 0, skill: { none: 1 } } }
  const w = world(on, reply)
  await submit($, 'refactor the auth module across services')
  reply.current = { tier: { mechanical: 0.95, routine: 0.05 }, risky: 0, skill: { none: 1 } }
  await submit($, 'yes, go ahead')
  await step($)
  expect(w.steps[0]?.model).toBe('claude-opus-5-5')

  await w.clock.advance(11 * 60_000)
  await submit($, 'rename foo to bar in utils.ts')
  await step($)
  expect(w.steps[1]?.model).toBe('claude-haiku-4-5-20251001')
  expect(w.steps[1]?.effort).toBeUndefined()
})

test('without a key nothing is routed', async ($, on) => {
  const reply = { current: { tier: { mechanical: 1 }, risky: 0, skill: { none: 1 } } }
  const w = world(on, reply, {})
  await submit($, 'rename foo to bar')
  expect(w.requests.length).toBe(0)
  await step($)
  expect(w.steps[0]?.model).toBe('claude-opus-5-5')
})

test('with effort routing on, effort follows the tier', { options: { effortRouting: true } }, async ($, on) => {
  const reply: { current: Reply } = { current: { tier: { routine: 0.9, complex: 0.1 }, risky: 0, skill: { none: 1 } } }
  const w = world(on, reply)
  await submit($, 'add a dark mode toggle to settings')
  await step($)
  expect(w.steps[0]?.model).toBe('claude-sonnet-5-5')
  expect(w.steps[0]?.effort).toBe('medium')

  reply.current = { tier: { complex: 0.9, deep: 0.1 }, risky: 0, skill: { none: 1 } }
  await submit($, 'checkout double-charges users; find out why')
  await step($)
  expect(w.steps[1]?.model).toBe('claude-opus-5-5')
  expect(w.steps[1]?.effort).toBe('high')

  reply.current = { tier: { deep: 1 }, risky: 0, skill: { none: 1 } }
  await submit($, 'design the sharding strategy for our event store')
  await step($, 'claude-opus-5-5')
  expect(w.steps[2]?.effort).toBe('xhigh')
})

test("a routine's scheduled prompt is routed; a background notification is not", async ($, on) => {
  const reply = { current: { tier: { mechanical: 0.95, routine: 0.05 }, risky: 0, skill: { none: 1 } } }
  const w = world(on, reply)
  await submit($, 'background task finished', 'task-notification')
  expect(w.requests.length).toBe(0)
  await submit($, 'pull the latest commits and summarize them', 'scheduled-trigger')
  expect(w.requests.length).toBe(1)
  await step($)
  expect(w.steps[0]?.model).toBe('claude-haiku-4-5-20251001')
})

const science: Reply = { tier: { complex: 0.05, deep: 0.95 }, risky: 0, skill: { none: 1 }, subject: { science: 0.97, math: 0.03 }, output: { explanation: 0.9, analysis: 0.1 } }

test('hard science goes to the Fable specialist; a follow-up stays on it', async ($, on) => {
  const reply: { current: Reply } = { current: science }
  const w = world(on, reply)
  await submit($, 'derive the transition state energy for this SN2 reaction and explain the solvent effect')
  expect(w.requests[0]?.questions.subject).toBeDefined()
  await step($)
  expect(w.steps[0]?.model).toBe('claude-fable-5-1')

  reply.current = { tier: { complex: 0.1, deep: 0.9 }, risky: 0, skill: { none: 1 }, subject: { general: 0.9, science: 0.1 } }
  await submit($, 'yes, go ahead')
  await step($)
  expect(w.steps[1]?.model).toBe('claude-fable-5-1')
})

test('/jev and a widget nudge change routing', async ($, on) => {
  const reply: { current: Reply } = { current: science }
  const w = world(on, reply)
  await startSession($, on)

  // Token efficient: no premium specialist, so hard science falls back to Opus.
  await jev($, 'focus 0')
  await submit($, 'derive the transition state energy for this SN2 reaction')
  await step($)
  expect(w.steps[0]?.model).toBe('claude-opus-5-5')

  // Effort on, then the widget nudges this session's model down one tier at a time.
  await jev($, 'effort on')
  const nudgeDown = (id: string) => {
    const current = JSON.parse(w.files.get(`${JEV}/settings.json`)!)
    w.files.set(`${JEV}/settings.json`, JSON.stringify({ ...current, nudge: { target: 'sess-a', by: -1, id } }))
  }
  nudgeDown('d1')
  await step($)
  expect(w.steps[1]?.model).toBe('claude-opus-5-5') // deep -> complex is still Opus
  expect(w.steps[1]?.effort).toBe('medium') // complex's high, one step down at token-efficient focus
  nudgeDown('d2')
  await step($)
  expect(w.steps[2]?.model).toBe('claude-sonnet-5-5')
})

test('the status line shows the session is connected from the start', async ($, on) => {
  const w = world(on, { current: { tier: { routine: 0.9, complex: 0.1 }, risky: 0, skill: { none: 1 } } })
  await startSession($, on)
  expect(w.statuses.at(-1)).toBe('Jev: auto')
  await submit($, 'add a dark mode toggle')
  expect(w.statuses.at(-1)).toBe('Jev → Sonnet 5.5')

  // The widget turns the router off: the line clears on the next prompt.
  w.files.set(
    `${JEV}/settings.json`,
    JSON.stringify({ version: 1, mode: 'off', focus: 2, effort: false, skills: true, specialists: true, nudge: null, updatedAt: 9_000_000, updatedBy: 'widget' }),
  )
  await submit($, 'add a dark mode toggle')
  expect(w.statuses.at(-1)).toBeUndefined()
})

test('without a key, the status line says so as soon as the session starts', async ($, on) => {
  const w = world(on, { current: { tier: { routine: 1 }, risky: 0, skill: { none: 1 } } }, {})
  await startSession($, on)
  expect(w.statuses.at(-1)).toBe('Jev: no API key (run /jev)')
})

test('/jev focus sets the level by name', async ($, on) => {
  const reply: { current: Reply } = { current: science }
  const w = world(on, reply)
  await startSession($, on)
  const out = await jev($, 'focus token-efficient')
  expect(out.text).toContain('Token efficient')
  await submit($, 'derive the transition state energy for this SN2 reaction')
  await step($)
  expect(w.steps[0]?.model).toBe('claude-opus-5-5')
  await jev($, 'focus balanced')
  await jev($, 'reset')
  await submit($, 'derive the transition state energy for this SN2 reaction')
  await step($)
  expect(w.steps[1]?.model).toBe('claude-fable-5-1')
})

test('shadow mode decides and logs but switches nothing and hints no skill', async ($, on) => {
  const reply = { current: { tier: { mechanical: 0.95, routine: 0.05 }, risky: 0, skill: { none: 0.1, 'data:sql-queries': 0.9 } } }
  const w = world(on, reply)
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('command.register', async ($, e) => ({ value: { command: e.name } }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const out = await $.command.run({ command: 'jev', args: 'shadow', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(out.text).toContain('shadow')
  expect(JSON.parse(w.files.get(`${JEV}/settings.json`)!).mode).toBe('shadow')

  const entered = await submit($, 'count signups by country, secret project NEPTUNE')
  expect(entered.context).toBeUndefined()
  expect(w.requests.length).toBe(1)
  await step($)
  expect(w.steps[0]?.model).toBe('claude-opus-5-5')

  const log = w.files.get(`${JEV}/decisions.jsonl`)!.trim().split('\n').map(l => JSON.parse(l))
  expect(log.length).toBe(1)
  expect(log[0].shadow).toBe(true)
  expect(log[0].model).toBe('claude-haiku-4-5-20251001')
  expect(log[0].skill).toBe('data:sql-queries')
  expect(log[0].session).toBe('sess-a')
  expect(typeof log[0].jevCostUsd).toBe('number')
  const last = JSON.parse(w.files.get(`${JEV}/last.json`)!)
  expect(last.working).toBe(true)
  expect(last.mode).toBe('shadow')
  expect(last.decision.tier).toBe('mechanical')

  // No prompt text anywhere: not in the shared files, not in /jev's history.
  for (const text of w.files.values()) expect(text.includes('NEPTUNE')).toBe(false)
  const status = await $.command.run({ command: 'jev', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect((status.text ?? '').includes('NEPTUNE')).toBe(false)
  expect(status.text).toContain('(shadow)')

  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 't', reason: 'answer' })
  expect(JSON.parse(w.files.get(`${JEV}/last.json`)!).working).toBe(false)
})

test("the widget's settings apply on the next prompt, and its nudge only in the session it targets", async ($, on) => {
  const reply: { current: Reply } = { current: { tier: { routine: 0.9, complex: 0.1 }, risky: 0, skill: { none: 1 } } }
  const w = world(on, reply)
  const widget = (patch: object) =>
    w.files.set(
      `${JEV}/settings.json`,
      JSON.stringify({ version: 1, mode: 'auto', focus: 2, effort: false, skills: true, specialists: true, nudge: null, updatedAt: 2_000_000, updatedBy: 'widget', ...patch }),
    )

  widget({ mode: 'off' })
  await submit($, 'add a dark mode toggle')
  expect(w.requests.length).toBe(0)

  widget({ mode: 'auto', effort: true, updatedAt: 2_000_001 })
  await submit($, 'add a dark mode toggle')
  await step($)
  expect(w.steps[0]?.model).toBe('claude-sonnet-5-5')
  expect(w.steps[0]?.effort).toBe('medium')

  // A nudge for another session is ignored; one for this session moves the model mid-turn.
  widget({ effort: true, updatedAt: 2_000_001, nudge: { target: 'sess-b', by: 1, id: 'n1' } })
  await step($)
  expect(w.steps[1]?.model).toBe('claude-sonnet-5-5')
  widget({ effort: true, updatedAt: 2_000_001, nudge: { target: 'sess-a', by: 1, id: 'n2' } })
  await step($)
  expect(w.steps[2]?.model).toBe('claude-opus-5-5')
  await step($) // the same nudge is applied once
  expect(w.steps[3]?.model).toBe('claude-opus-5-5')
  const log = w.files.get(`${JEV}/decisions.jsonl`)!.trim().split('\n').map(l => JSON.parse(l))
  expect(log.at(-1).manual).toBe(true)
})

test('/jev writes its changes to settings.json, keeping a pending nudge', async ($, on) => {
  const w = world(on, { current: science })
  w.files.set(`${JEV}/settings.json`, JSON.stringify({ mode: 'auto', focus: 2, nudge: { target: 'sess-b', by: -1, id: 'n9' }, updatedAt: 5 }))
  await startSession($, on)
  await jev($, 'focus task-focused')
  await jev($, 'specialists off')
  await jev($, 'shadow')
  const saved = JSON.parse(w.files.get(`${JEV}/settings.json`)!)
  expect(saved.focus).toBe(4)
  expect(saved.specialists).toBe(false)
  expect(saved.mode).toBe('shadow')
  expect(saved.updatedBy).toBe('plugin')
  expect(saved.nudge.id).toBe('n9')
})
