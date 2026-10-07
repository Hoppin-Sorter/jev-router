// Tests for the standalone router (lib/jev-router.ts): `node --test tests/`
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createRouter, FOCUS, PRESETS, pickTier, type JevAnswers } from '../lib/jev-router.ts'

const top = (p: Record<string, number>) => Object.entries(p).sort((a, b) => b[1] - a[1])[0]![0]
type Reply = { tier?: Record<string, number>; risky?: number; skill?: Record<string, number>; subject?: Record<string, number>; output?: Record<string, number> }
function fakeJev(reply: Reply | 'down' | { current: Reply }) {
  const calls: any[] = []
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)))
    if (reply === 'down') throw new Error('connect ECONNREFUSED')
    const r: Reply = 'current' in reply ? reply.current : reply
    const answers: JevAnswers = {}
    if (r.tier) answers.tier = { choice: top(r.tier), probabilities: r.tier }
    if (r.risky !== undefined) answers.risky = { noul: r.risky }
    if (r.skill) answers.skill = { choice: top(r.skill), probabilities: r.skill }
    if (r.subject) answers.subject = { choice: top(r.subject), probabilities: r.subject }
    if (r.output) answers.output = { choice: top(r.output), probabilities: r.output }
    return { ok: true, status: 200, json: async () => ({ answers }) }
  }) as unknown as typeof globalThis.fetch
  return { fetch: fakeFetch, calls }
}

test('doubt rounds up', () => {
  assert.equal(pickTier({ mechanical: 0.9, routine: 0.1 }), 'mechanical')
  assert.equal(pickTier({ mechanical: 0.6, routine: 0.3, complex: 0.1 }), 'routine')
  assert.equal(pickTier({ complex: 0.3, deep: 0.7 }), 'deep')
})

test('routine prompt: Sonnet, medium effort, skill picked', async () => {
  const jev = fakeJev({ tier: { routine: 0.9, complex: 0.1 }, risky: 0.1, skill: { none: 0.2, 'sql-queries': 0.8 } })
  const router = createRouter({ apiKey: 'k', skills: [{ name: 'sql-queries', description: 'Write SQL' }], fetch: jev.fetch })
  const r = await router.route('weekly signups by country in BigQuery')
  assert.deepEqual(r, {
    tier: 'routine', model: 'claude-sonnet-5-5', effort: 'medium', subject: null, output: null,
    specialist: false, skill: 'sql-queries', routed: true, why: 'Jev said routine (90%)',
  })
  assert.deepEqual(Object.keys(jev.calls[0].questions.skill.criteria), ['none', 'sql-queries'])
  assert.ok(jev.calls[0].questions.subject && jev.calls[0].questions.output, 'subject and output asked in the same call')
})

test('risky floors at Opus; follow-ups hold; hold expires', async () => {
  let t = 0
  const reply: any = { tier: { mechanical: 0.95, routine: 0.05 }, risky: 0.9 }
  const jev = fakeJev(reply)
  const router = createRouter({ apiKey: 'k', fetch: jev.fetch, now: () => t })
  assert.equal((await router.route('rotate the prod db password')).model, 'claude-opus-5-5')
  reply.risky = 0
  t += 60_000
  const held = await router.route('yes, go ahead')
  assert.equal(held.tier, 'complex')
  assert.match(held.why, /held at complex/)
  t += 11 * 60_000
  const fresh = await router.route('rename foo to bar')
  assert.equal(fresh.model, 'claude-haiku-4-5')
  assert.equal(fresh.effort, null)
})

test('Jev down: fallback tier, routed false', async () => {
  const router = createRouter({ apiKey: 'k', fetch: fakeJev('down').fetch, fallback: 'routine' })
  const r = await router.route('anything')
  assert.equal(r.routed, false)
  assert.equal(r.model, 'claude-sonnet-5-5')
})

test('openai provider: Luna/Sol/Astra with valid effort pairings', async () => {
  const cases: Array<[Record<string, number>, string, string]> = [
    [{ mechanical: 0.95, routine: 0.05 }, 'gpt-6-luna', 'low'],
    [{ routine: 0.9, complex: 0.1 }, 'gpt-6.1-sol', 'medium'],
    [{ complex: 0.9, deep: 0.1 }, 'gpt-6-astra', 'high'],
    [{ deep: 1 }, 'gpt-6-astra', 'xhigh'],
  ]
  for (const [tier, model, effort] of cases) {
    const router = createRouter({ apiKey: 'k', provider: 'openai', fetch: fakeJev({ tier, risky: 0 }).fetch })
    const r = await router.route('x')
    assert.equal(r.model, model)
    assert.equal(r.effort, effort)
  }
})

test('models and efforts can be overridden per tier', async () => {
  const router = createRouter({
    apiKey: 'k',
    provider: 'openai',
    models: { complex: 'gpt-6.1-sol' },
    efforts: { complex: null },
    fetch: fakeJev({ tier: { complex: 0.9, deep: 0.1 }, risky: 0 }).fetch,
  })
  const r = await router.route('x')
  assert.equal(r.model, 'gpt-6.1-sol')
  assert.equal(r.effort, null)
})

const deepScience: Reply = { tier: { complex: 0.05, deep: 0.95 }, risky: 0, subject: { science: 0.97, math: 0.03 }, output: { explanation: 0.9, analysis: 0.1 } }

test('hard science goes to Fable at balanced focus, Opus at token-efficient', async () => {
  const balanced = await createRouter({ apiKey: 'k', fetch: fakeJev(deepScience).fetch }).route('x')
  assert.equal(balanced.model, 'claude-fable-5-1')
  assert.equal(balanced.specialist, true)
  assert.equal(balanced.subject, 'science')
  const lean = await createRouter({ apiKey: 'k', focus: 0, fetch: fakeJev(deepScience).fetch }).route('x')
  assert.equal(lean.model, 'claude-opus-5-5')
  assert.equal(lean.effort, 'high') // deep's xhigh, one step down at token-efficient focus
})

test('a follow-up holds the specialist; changing focus releases it', async () => {
  const reply = { current: deepScience }
  const router = createRouter({ apiKey: 'k', fetch: fakeJev(reply).fetch })
  assert.equal((await router.route('derive it')).model, 'claude-fable-5-1')
  reply.current = { tier: { deep: 1 }, risky: 0, subject: { general: 0.9, science: 0.1 } }
  const followUp = await router.route('yes, go ahead')
  assert.equal(followUp.model, 'claude-fable-5-1')
  assert.match(followUp.why, /held on claude-fable-5-1/)
  router.setFocus(0)
  assert.equal((await router.route('and the next step')).model, 'claude-opus-5-5')
})

test('task focus never goes below Sonnet; quick answers think one step less', async () => {
  const simple: Reply = { tier: { mechanical: 0.99, routine: 0.01 }, risky: 0, output: { quick_answer: 0.9, explanation: 0.1 } }
  const r = await createRouter({ apiKey: 'k', focus: 4, fetch: fakeJev(simple).fetch }).route('x')
  assert.equal(r.model, 'claude-sonnet-5-5')
  assert.equal(r.effort, 'medium') // routine's medium, +1 for task focus, -1 for a quick answer
})

test('openai has no specialists, so focus only moves effort there', async () => {
  const r = await createRouter({ apiKey: 'k', provider: 'openai', fetch: fakeJev(deepScience).fetch }).route('x')
  assert.equal(r.model, 'gpt-6-astra')
  assert.equal(r.specialist, false)
})

test('tables are exported for the Python parity check', () => {
  assert.equal(Object.keys(FOCUS).length, 5)
  assert.ok(PRESETS.anthropic.specialists?.science?.deep)
})
