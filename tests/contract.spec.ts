// Tests for the shared ~/.config/jev/ contract (lib/contract.ts): `node --test tests/`
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { appendDecision, DEFAULT_SHARED, estimateTokens, jevCost, parseSettings, type DecisionRecord } from '../lib/contract.ts'

test('settings.json: bad fields take defaults, junk is rejected', () => {
  assert.equal(parseSettings('not json'), undefined)
  assert.equal(parseSettings('[1,2]'), undefined)
  const s = parseSettings('{"mode":"shadow","focus":9,"effort":"yes","skills":false,"nudge":{"target":"s","by":2,"id":"x"},"updatedAt":7}')!
  assert.equal(s.mode, 'shadow')
  assert.equal(s.focus, DEFAULT_SHARED.focus)
  assert.equal(s.effort, false)
  assert.equal(s.skills, false)
  assert.equal(s.nudge, null)
  assert.equal(s.updatedAt, 7)
  const n = parseSettings('{"nudge":{"target":"s","by":-1,"id":"x"}}')!
  assert.deepEqual(n.nudge, { target: 's', by: -1, id: 'x' })
})

test('decisions.jsonl keeps the newest lines', () => {
  const d = (at: number): DecisionRecord => ({ at, session: 's', tier: 'routine', model: 'm', why: '' })
  let text = ''
  for (let i = 0; i < 7; i++) text = appendDecision(text, d(i), 5)
  const lines = text.trim().split('\n').map(l => JSON.parse(l) as DecisionRecord)
  assert.deepEqual(lines.map(l => l.at), [2, 3, 4, 5, 6])
  assert.ok(text.endsWith('\n'))
})

test('Jev cost is $0.042 per million input tokens', () => {
  assert.equal(estimateTokens('x'.repeat(4000)), 1000)
  assert.ok(Math.abs(jevCost(1_000_000) - 0.042) < 1e-12)
})
