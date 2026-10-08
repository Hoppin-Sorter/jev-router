import { expect, test } from 'claude-code/testing'
import { JEV, step, submit, world, type Reply } from './harness'
import { CASES, FABLE, hardChemistry, none, OPUS, SONNET } from './scenarios'

// Simulations: the scenarios in scenarios.ts through the plugin's real code, checking the
// model and effort each request is sent with, the skill hint, and the status line under the
// prompt; then a few that play out over several prompts.
//
// Jev's answers are scripted, so these check what the router does with them. Whether Jev
// reads real prompts this way is a separate check against the live API.

for (const c of CASES) {
  test(c.name, async ($, on) => {
    const w = world(on, { current: c.reply }, c.noKey ? {} : undefined)
    if (c.settings) w.widget(c.settings)
    const entered = await submit($, c.prompt)
    await step($)

    const sent = w.steps[0]!
    expect(sent.model).toBe(c.expect.model)
    if (c.expect.effort === null) expect(sent.effort).toBeUndefined()
    else expect(sent.effort).toBe(c.expect.effort)
    expect(w.requests.length).toBe(c.expect.asked === false ? 0 : 1)
    const hint = (entered.context ?? []).join('\n')
    if (c.expect.hint) expect(hint).toContain(`"${c.expect.hint}" skill`)
    else expect(hint).toBe('')
    if (c.expect.skillQuestion !== undefined) expect('skill' in (w.requests[0]?.questions ?? {})).toBe(c.expect.skillQuestion)
    if (c.expect.status !== undefined) expect(w.statuses.at(-1)).toBe(c.expect.status ?? undefined)
  })
}

// Over several prompts: the widget changing things while a task is under way.

test('lowering focus in the widget mid-task drops Fable on the next prompt', async ($, on) => {
  const reply: { current: Reply } = { current: hardChemistry }
  const w = world(on, reply)
  w.widget({ focus: 2 })
  await submit($, 'derive the transition state energy for this SN2 reaction')
  await step($)
  expect(w.steps[0]?.model).toBe(FABLE)

  w.widget({ focus: 0 })
  reply.current = { tier: { mechanical: 0.95, routine: 0.05 }, risky: 0, skill: none, subject: { general: 0.9, science: 0.1 } }
  await submit($, 'yes, go ahead')
  await step($)
  // The task keeps its deep tier, but at Token efficient the premium specialist sits out.
  expect(w.steps[1]?.model).toBe(OPUS)
})

test("the widget's nudge moves a Fable task down to Opus on its next request", async ($, on) => {
  const w = world(on, { current: hardChemistry })
  w.widget({ effort: true })
  await submit($, 'derive the transition state energy for this SN2 reaction')
  await step($)
  expect(w.steps[0]?.model).toBe(FABLE)
  expect(w.steps[0]?.effort).toBe('xhigh')

  w.widget({ effort: true, nudge: { target: 'sess-a', by: -1, id: 'n1' } })
  await step($)
  // Deep → complex: science has no specialist at complex, so Opus at complex's effort.
  expect(w.steps[1]?.model).toBe(OPUS)
  expect(w.steps[1]?.effort).toBe('high')
  expect(w.statuses.at(-1)).toBe('Jev → Opus 5.5 (you)')
  const log = w.files.get(`${JEV}/decisions.jsonl`)!.trim().split('\n').map(l => JSON.parse(l))
  expect(log.at(-1)).toMatchObject({ model: OPUS, tier: 'complex', manual: true })
})

test('turning the router off in the widget hands the next prompt back to the session model', async ($, on) => {
  const w = world(on, { current: { tier: { routine: 0.9, complex: 0.1 }, risky: 0, skill: none } })
  await submit($, 'add a dark mode toggle to settings')
  await step($)
  expect(w.steps[0]?.model).toBe(SONNET)

  w.widget({ mode: 'off' })
  await submit($, 'now add a light mode toggle too')
  await step($)
  expect(w.requests.length).toBe(1)
  expect(w.steps[1]?.model).toBe(OPUS)
  expect(w.statuses.at(-1)).toBeUndefined()
})
