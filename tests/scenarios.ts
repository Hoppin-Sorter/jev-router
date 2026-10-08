import type { Reply, WidgetSettings } from './harness'

// The single-prompt scenarios scenarios.test.ts runs through the plugin: varied prompts, as
// Jev would answer them, and settings, as the menu bar widget writes them, with the model,
// effort, skill hint and status line each should get. tests/simulate.ts reads them too.

export const HAIKU = 'claude-haiku-4-5-20251001'
export const SONNET = 'claude-sonnet-5-5'
export const OPUS = 'claude-opus-5-5'
export const FABLE = 'claude-fable-5-1'
/** What `step` sends when the router leaves the request alone. */
export const SESSION = { model: OPUS, effort: 'xhigh' }

export type Case = {
  /** Which part of routing the scenario is about, for the report. */
  group: string
  name: string
  prompt: string
  reply: Reply | 'error'
  settings?: WidgetSettings
  noKey?: true
  expect: {
    model: string
    /** null: no effort sent (Haiku takes none). */
    effort: string | null
    /** Whether Jev was asked; default true. */
    asked?: boolean
    /** The skill the hint names; absent means no hint. */
    hint?: string
    /** Whether the request offered Jev a skill question. */
    skillQuestion?: boolean
    /** The status line after the prompt; null means cleared. Absent, not checked. */
    status?: string | null
  }
}

export const none = { none: 1 }
export const hardChemistry: Reply = { tier: { complex: 0.1, deep: 0.9 }, risky: 0, skill: none, subject: { science: 0.95, math: 0.05 }, output: { explanation: 0.9, analysis: 0.1 } }
// Unsure between tiers, so the focus level decides: 60% mechanical, 75% by routine, all by complex.
export const borderline: Reply = { tier: { mechanical: 0.6, routine: 0.15, complex: 0.25 }, risky: 0, skill: none }
export const sqlTask: Reply = { tier: { routine: 0.85, complex: 0.15 }, risky: 0, skill: { 'data:sql-queries': 0.85, none: 0.1, 'pdf-viewer:open': 0.05 }, subject: { data: 0.9, software: 0.1 } }

export const CASES: Case[] = [
  // Difficulty picks the tier.
  {
    group: 'Difficulty',
    name: 'a rename goes to Haiku, with no effort setting',
    prompt: 'rename foo to userCount in utils.ts',
    reply: { tier: { mechanical: 0.95, routine: 0.05 }, risky: 0, skill: none },
    expect: { model: HAIKU, effort: null, status: 'Jev → Haiku 4.5' },
  },
  {
    group: 'Difficulty',
    name: 'a clearly specified feature goes to Sonnet',
    prompt: 'add a dark mode toggle to settings',
    reply: { tier: { routine: 0.9, complex: 0.1 }, risky: 0, skill: none },
    expect: { model: SONNET, effort: 'xhigh', status: 'Jev → Sonnet 5.5' },
  },
  {
    group: 'Difficulty',
    name: 'a bug with an unclear cause goes to Opus',
    prompt: 'checkout double-charges some users; find out why',
    reply: { tier: { complex: 0.8, deep: 0.2 }, risky: 0, skill: none, subject: { software: 0.9, data: 0.1 } },
    expect: { model: OPUS, effort: 'xhigh', status: 'Jev → Opus 5.5 · software' },
  },
  {
    group: 'Difficulty',
    name: 'system architecture goes to Opus, not Fable: software has no specialist',
    prompt: 'design the sharding strategy for our event store',
    reply: { tier: { deep: 0.9, complex: 0.1 }, risky: 0, skill: none, subject: { software: 0.9, general: 0.1 } },
    expect: { model: OPUS, effort: 'xhigh', status: 'Jev → Opus 5.5 · software' },
  },
  {
    group: 'Difficulty',
    name: 'doubt rounds up: half sure it is mechanical still gets Sonnet',
    prompt: 'tidy up this function',
    reply: { tier: { mechanical: 0.5, routine: 0.3, complex: 0.2 }, risky: 0, skill: none },
    expect: { model: SONNET, effort: 'xhigh' },
  },

  // The subject can swap in a specialist.
  {
    group: 'Subject',
    name: 'hard chemistry goes to the Fable specialist',
    prompt: 'derive the transition state energy for this SN2 reaction and explain the solvent effect',
    reply: hardChemistry,
    expect: { model: FABLE, effort: 'xhigh', status: 'Jev → Fable 5.1 · science' },
  },
  {
    group: 'Subject',
    name: 'a hard proof goes to the Fable specialist',
    prompt: 'prove that every bounded monotone sequence of reals converges',
    reply: { tier: { deep: 0.9, complex: 0.1 }, risky: 0, skill: none, subject: { math: 0.9, science: 0.1 }, output: { explanation: 0.9, analysis: 0.1 } },
    expect: { model: FABLE, effort: 'xhigh', status: 'Jev → Fable 5.1 · math' },
  },
  {
    group: 'Subject',
    name: 'mid-level science stays on Opus: the specialist is for the deepest tier only',
    prompt: 'explain why a catalyst does not change the equilibrium constant',
    reply: { tier: { complex: 0.9, deep: 0.1 }, risky: 0, skill: none, subject: { science: 0.95, general: 0.05 } },
    expect: { model: OPUS, effort: 'xhigh', status: 'Jev → Opus 5.5 · science' },
  },
  {
    group: 'Subject',
    name: 'a hard law question counts as business and gets no specialist yet',
    prompt: 'does a non-compete signed in California hold up if I move to Texas?',
    reply: { tier: { deep: 0.9, complex: 0.1 }, risky: 0, skill: none, subject: { business: 0.9, general: 0.1 }, output: { explanation: 0.8, plan_or_decision: 0.2 } },
    expect: { model: OPUS, effort: 'xhigh', status: 'Jev → Opus 5.5 · business' },
  },
  {
    group: 'Subject',
    name: 'an unsure subject is ignored, so no specialist',
    prompt: 'what happens to a protein at high temperature, mathematically?',
    reply: { tier: { deep: 0.9, complex: 0.1 }, risky: 0, skill: none, subject: { science: 0.45, general: 0.35, math: 0.2 } },
    expect: { model: OPUS, effort: 'xhigh', status: 'Jev → Opus 5.5' },
  },
  {
    group: 'Subject',
    name: 'at Lean focus the premium specialist sits out',
    prompt: 'derive the transition state energy for this SN2 reaction',
    reply: hardChemistry,
    settings: { focus: 1 },
    expect: { model: OPUS, effort: 'xhigh', status: 'Jev → Opus 5.5 · science' },
  },
  {
    group: 'Subject',
    name: 'with Specialists switched off, hard chemistry stays on Opus',
    prompt: 'derive the transition state energy for this SN2 reaction',
    reply: hardChemistry,
    settings: { specialists: false },
    expect: { model: OPUS, effort: 'xhigh' },
  },
  {
    group: 'Subject',
    name: 'at Token efficient focus with effort on, hard chemistry gets Opus one effort step down',
    prompt: 'derive the transition state energy for this SN2 reaction',
    reply: hardChemistry,
    settings: { focus: 0, effort: true },
    expect: { model: OPUS, effort: 'high', status: 'Jev → Opus 5.5 · high · science' },
  },

  // Focus moves the same borderline prompt between tiers (effort on).
  {
    group: 'Focus',
    name: 'borderline prompt at Token efficient: Haiku',
    prompt: 'update the copyright year in the footer and check nothing else uses it',
    reply: borderline,
    settings: { focus: 0, effort: true },
    expect: { model: HAIKU, effort: null, status: 'Jev → Haiku 4.5' },
  },
  {
    group: 'Focus',
    name: 'borderline prompt at Lean: Sonnet, medium effort',
    prompt: 'update the copyright year in the footer and check nothing else uses it',
    reply: borderline,
    settings: { focus: 1, effort: true },
    expect: { model: SONNET, effort: 'medium', status: 'Jev → Sonnet 5.5 · medium' },
  },
  {
    group: 'Focus',
    name: 'borderline prompt at Balanced: Sonnet, medium effort',
    prompt: 'update the copyright year in the footer and check nothing else uses it',
    reply: borderline,
    settings: { focus: 2, effort: true },
    expect: { model: SONNET, effort: 'medium' },
  },
  {
    group: 'Focus',
    name: 'borderline prompt at Thorough: Opus, high effort',
    prompt: 'update the copyright year in the footer and check nothing else uses it',
    reply: borderline,
    settings: { focus: 3, effort: true },
    expect: { model: OPUS, effort: 'high', status: 'Jev → Opus 5.5 · high' },
  },
  {
    group: 'Focus',
    name: 'borderline prompt at Task focused: Opus, effort one step up',
    prompt: 'update the copyright year in the footer and check nothing else uses it',
    reply: borderline,
    settings: { focus: 4, effort: true },
    expect: { model: OPUS, effort: 'xhigh' },
  },
  {
    group: 'Focus',
    name: 'at Task focused even a rename gets Sonnet',
    prompt: 'rename foo to userCount in utils.ts',
    reply: { tier: { mechanical: 0.99, routine: 0.01 }, risky: 0, skill: none },
    settings: { focus: 4, effort: true },
    expect: { model: SONNET, effort: 'high', status: 'Jev → Sonnet 5.5 · high' },
  },
  {
    group: 'Focus',
    name: 'a deep task at Task focused gets the maximum effort',
    prompt: 'design the sharding strategy for our event store',
    reply: { tier: { deep: 1 }, risky: 0, skill: none },
    settings: { focus: 4, effort: true },
    expect: { model: OPUS, effort: 'max', status: 'Jev → Opus 5.5 · max' },
  },
  {
    group: 'Focus',
    name: 'a quick factual answer thinks one step less',
    prompt: 'which port does Postgres listen on by default?',
    reply: { tier: { routine: 0.9, complex: 0.1 }, risky: 0, skill: none, output: { quick_answer: 0.9, explanation: 0.1 } },
    settings: { effort: true },
    expect: { model: SONNET, effort: 'low', status: 'Jev → Sonnet 5.5 · low' },
  },

  // Risky work floors at Opus.
  {
    group: 'Risk',
    name: 'a risky one-liner goes to Opus anyway',
    prompt: 'rotate the production database password',
    reply: { tier: { mechanical: 0.95, routine: 0.05 }, risky: 0.9, skill: none },
    expect: { model: OPUS, effort: 'xhigh', status: 'Jev → Opus 5.5' },
  },
  {
    group: 'Risk',
    name: 'the risk floor holds at Token efficient too',
    prompt: 'delete the old billing records from prod',
    reply: { tier: { mechanical: 0.95, routine: 0.05 }, risky: 0.9, skill: none },
    settings: { focus: 0 },
    expect: { model: OPUS, effort: 'xhigh' },
  },
  {
    group: 'Risk',
    name: 'below the risk floor, a one-liner stays on Haiku',
    prompt: 'bump the log level in the local config',
    reply: { tier: { mechanical: 0.95, routine: 0.05 }, risky: 0.5, skill: none },
    expect: { model: HAIKU, effort: null },
  },

  // The router's modes and the widget's switches.
  {
    group: 'Modes and switches',
    name: 'router off: Jev is not asked and the session model is kept',
    prompt: 'rename foo to bar',
    reply: { tier: { mechanical: 0.95, routine: 0.05 }, risky: 0, skill: none },
    settings: { mode: 'off' },
    expect: { ...SESSION, asked: false, status: null },
  },
  {
    group: 'Modes and switches',
    name: 'shadow mode asks Jev and says what it would pick, but switches nothing and hints nothing',
    prompt: 'weekly signups by country in BigQuery',
    reply: sqlTask,
    settings: { mode: 'shadow' },
    expect: { ...SESSION, status: 'Jev (shadow) would pick Sonnet 5.5 · data · /data:sql-queries' },
  },
  {
    group: 'Modes and switches',
    name: 'a matching skill is hinted',
    prompt: 'weekly signups by country in BigQuery',
    reply: sqlTask,
    expect: { model: SONNET, effort: 'xhigh', hint: 'data:sql-queries', skillQuestion: true, status: 'Jev → Sonnet 5.5 · data · /data:sql-queries' },
  },
  {
    group: 'Modes and switches',
    name: 'with Skills switched off, Jev is not asked about skills and nothing is hinted',
    prompt: 'weekly signups by country in BigQuery',
    reply: sqlTask,
    settings: { skills: false },
    expect: { model: SONNET, effort: 'xhigh', skillQuestion: false, status: 'Jev → Sonnet 5.5 · data' },
  },
  {
    group: 'Modes and switches',
    name: 'a skill Jev is under 50% sure of is not hinted',
    prompt: 'pull some numbers for the board deck',
    reply: { tier: { routine: 0.9, complex: 0.1 }, risky: 0, skill: { 'data:sql-queries': 0.45, none: 0.35, 'pdf-viewer:open': 0.2 } },
    expect: { model: SONNET, effort: 'xhigh', status: 'Jev → Sonnet 5.5' },
  },
  {
    group: 'Modes and switches',
    name: 'with Effort switched on, effort follows the tier',
    prompt: 'checkout double-charges some users; find out why',
    reply: { tier: { complex: 0.8, deep: 0.2 }, risky: 0, skill: none },
    settings: { effort: true },
    expect: { model: OPUS, effort: 'high', status: 'Jev → Opus 5.5 · high' },
  },

  // When Jev can't be asked, the session's own model carries on.
  {
    group: 'Jev unavailable',
    name: 'without a key nothing is routed, and the status line says why',
    prompt: 'rename foo to bar',
    reply: { tier: { mechanical: 1 }, risky: 0, skill: none },
    noKey: true,
    expect: { ...SESSION, asked: false, status: 'Jev: no API key (run /jev)' },
  },
  {
    group: 'Jev unavailable',
    name: 'if Jev fails, the session model is kept and the status line says why',
    prompt: 'add a dark mode toggle to settings',
    reply: 'error',
    expect: { ...SESSION, status: 'Jev: HTTP 500; kept the session model' },
  },
]
