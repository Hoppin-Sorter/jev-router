// Runs the router's decision code over a grid of prompt shapes and settings, and prints JSON
// for the simulation report: the model and effort for every combination, plus the scenarios
// tests/scenarios.test.ts runs through the plugin. Jev's answers are made up here, as in the
// tests; this shows what the router does with them, not how well Jev reads real prompts.
//
//   node tests/simulate.ts > simulation.json
import {
  choose,
  CLAUDE_SPECIALISTS,
  decide,
  FOCUS_LABELS,
  TIER_EFFORT,
  type ChoiceAnswer,
  type Focus,
  type JevAnswers,
  type Tier,
} from '../lib/jev-router.ts'
import { CASES } from './scenarios.ts'

// The plugin's models (Claude Code IDs) with the default deepModel.
const MODELS: Record<Tier, string> = {
  mechanical: 'claude-haiku-4-5-20251001',
  routine: 'claude-sonnet-5-5',
  complex: 'claude-opus-5-5',
  deep: 'claude-opus-5-5',
}
const NAMES: Record<string, string> = {
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-fable-5-1': 'Fable 5.1',
}

const answer = (probabilities: Record<string, number>): ChoiceAnswer => ({
  choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0],
  probabilities,
})

// How sure Jev is about the difficulty.
const SHAPES: Record<string, Record<string, number>> = {
  'Clearly mechanical': { mechanical: 0.95, routine: 0.05 },
  'Leans mechanical': { mechanical: 0.6, routine: 0.15, complex: 0.25 },
  'Clearly routine': { routine: 0.9, complex: 0.1 },
  'Split three ways': { mechanical: 0.3, routine: 0.3, complex: 0.3, deep: 0.1 },
  'Clearly complex': { complex: 0.85, deep: 0.15 },
  'Clearly deep': { deep: 0.9, complex: 0.1 },
}
// What the prompt is about, as Jev would label it. Law has no subject of its own: business.
const SUBJECTS: Record<string, Record<string, number>> = {
  Software: { software: 0.9, general: 0.1 },
  Science: { science: 0.9, math: 0.1 },
  Math: { math: 0.9, science: 0.1 },
  Data: { data: 0.9, software: 0.1 },
  Writing: { writing: 0.9, general: 0.1 },
  'Law (business)': { business: 0.9, general: 0.1 },
  General: { general: 0.9, writing: 0.1 },
  'Unsure (science 45%)': { science: 0.45, general: 0.35, math: 0.2 },
}
const OUTPUTS: Record<string, Record<string, number>> = {
  Explanation: { explanation: 0.9, analysis: 0.1 },
  'Quick answer': { quick_answer: 0.9, explanation: 0.1 },
}

const grid = []
for (const [shape, tierProbs] of Object.entries(SHAPES)) {
  for (const [subject, subjectProbs] of Object.entries(SUBJECTS)) {
    for (const focus of [0, 1, 2, 3, 4] as Focus[]) {
      for (const specialists of [true, false]) {
        for (const risky of [false, true]) {
          for (const [output, outputProbs] of Object.entries(OUTPUTS)) {
            const answers: JevAnswers = {
              tier: answer(tierProbs),
              risky: { noul: risky ? 0.9 : 0 },
              subject: answer(subjectProbs),
              output: answer(outputProbs),
            }
            // As the plugin does for a fresh prompt: decide, then choose with this session's plan.
            const d = decide(answers, { focus })
            const c = choose({ models: MODELS, efforts: TIER_EFFORT, specialists: specialists ? CLAUDE_SPECIALISTS : {} }, d.tier!, {
              subject: d.subject,
              output: d.output,
              focus,
            })
            grid.push({
              shape,
              subject,
              focus,
              focusLabel: FOCUS_LABELS[focus],
              specialists,
              risky,
              output,
              tier: d.tier,
              model: NAMES[c.model] ?? c.model,
              effort: c.effort,
              specialist: c.specialist,
              why: d.why,
            })
          }
        }
      }
    }
  }
}

const scenarios = CASES.map(c => {
  const r = c.reply === 'error' ? null : c.reply
  const tierPick = r?.tier ? answer(r.tier) : undefined
  const subjectPick = r?.subject ? answer(r.subject) : undefined
  const skillPick = r?.skill ? answer(r.skill) : undefined
  return {
    group: c.group,
    name: c.name,
    prompt: c.prompt,
    jev:
      c.reply === 'error'
        ? 'Jev fails (HTTP 500)'
        : {
            tier: tierPick && `${tierPick.choice} ${Math.round((tierPick.probabilities[tierPick.choice] ?? 0) * 100)}%`,
            subject: subjectPick && `${subjectPick.choice} ${Math.round((subjectPick.probabilities[subjectPick.choice] ?? 0) * 100)}%`,
            risky: r?.risky,
            skill: skillPick && skillPick.choice !== 'none' ? `${skillPick.choice} ${Math.round((skillPick.probabilities[skillPick.choice] ?? 0) * 100)}%` : undefined,
            output: r?.output ? answer(r.output).choice : undefined,
          },
    settings: { mode: 'auto', focus: 2, effort: false, skills: true, specialists: true, ...c.settings, key: !c.noKey },
    expect: {
      model: NAMES[c.expect.model] ?? c.expect.model,
      effort: c.expect.effort,
      askedJev: c.expect.asked !== false,
      hint: c.expect.hint ?? null,
      status: c.expect.status,
    },
  }
})

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), grid, scenarios }, null, 1))
