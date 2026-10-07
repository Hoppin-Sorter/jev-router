// Tests for the standalone router (lib/jev-router.ts): `node --test tests/`
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createRouter, pickTier, type JevAnswers } from '../lib/jev-router.ts'

const top = (p: Record<string, number>) => Object.entries(p).sort((a, b) => b[1] - a[1])[0]![0]
function fakeJev(reply: { tier?: Record<string, number>; risky?: number; skill?: Record<string, number> } | 'down') {
  const calls: any[] = []
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)))
    if (reply === 'down') throw new Error('connect ECONNREFUSED')
    const answers: JevAnswers = {}
    if (reply.tier) answers.tier = { choice: top(reply.tier), probabilities: reply.tier }
    if (reply.risky !== undefined) answers.risky = { noul: reply.risky }
    if (reply.skill) answers.skill = { choice: top(reply.skill), probabilities: reply.skill }
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
  assert.deepEqual(r, { tier: 'routine', model: 'claude-sonnet-5-5', effort: 'medium', skill: 'sql-queries', routed: true, why: 'Jev said routine (90%)' })
  assert.deepEqual(Object.keys(jev.calls[0].questions.skill.criteria), ['none', 'sql-queries'])
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
