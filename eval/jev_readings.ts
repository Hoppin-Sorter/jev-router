// How well does Jev read real prompts? Sends every prompt in a labelled library (eval/usecases.jsonl)
// to the live Jev API, with the skills your sessions offer, exactly as the plugin asks, and compares
// Jev's difficulty, subject, risk and skill answers with the labels. Also records the model and effort
// the router would pick at Balanced focus. Costs Jev calls on your own key ($0.042 per million input
// tokens); --dry-run shows the estimate and calls nothing.
//
//   node eval/jev_readings.ts --skills skills.json --dry-run
//   node eval/jev_readings.ts --skills skills.json --out eval/results/jev-readings.json
//
// --skills is a JSON list of { name, description }: the skills your Claude Code sessions offer.
// The key comes from TYPESAFE_API_KEY, JEV_API_KEY or ~/.config/jev/api_key, and is never printed.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { buildRequest, choose, CLAUDE_SPECIALISTS, decide, JEV_URL, TIER_EFFORT, TIERS, type JevAnswers, type Skill, type Tier } from '../lib/jev-router.ts'

type Item = { id: string; subject: string; tier: Tier; prompt: string; jev_subjects: string[]; risky: boolean; skills: string[] }

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!
  if (!a.startsWith('--')) continue
  const next = process.argv[i + 1]
  if (next && !next.startsWith('--')) args.set(a.slice(2), process.argv[++i]!)
  else args.set(a.slice(2), 'true')
}
const promptsPath = args.get('prompts') ?? 'eval/usecases.jsonl'
const skillsPath = args.get('skills')
const outPath = args.get('out') ?? 'eval/results/jev-readings.json'
const concurrency = Number(args.get('concurrency') ?? 4)
const limit = args.has('limit') ? Number(args.get('limit')) : undefined
const PRICE_PER_MTOK = 0.042
// The plugin's models (Claude Code IDs), default deepModel.
const MODELS: Record<Tier, string> = { mechanical: 'claude-haiku-4-5-20251001', routine: 'claude-sonnet-5-5', complex: 'claude-opus-5-5', deep: 'claude-opus-5-5' }

let items: Item[] = readFileSync(promptsPath, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
if (limit) items = items.slice(0, limit)
const skills: Skill[] = skillsPath ? JSON.parse(readFileSync(skillsPath, 'utf8')) : []

const bodies = items.map(it => JSON.stringify(buildRequest(it.prompt, { skills })))
const estTokens = bodies.reduce((n, b) => n + Math.ceil(b.length / 4), 0)
console.log(`${items.length} prompts, ${skills.length} skills offered, about ${Math.round(estTokens / 1000)}k input tokens, about $${(estTokens / 1e6 * PRICE_PER_MTOK).toFixed(3)}`)
if (args.has('dry-run')) process.exit(0)

function apiKey(): string {
  const env = process.env.TYPESAFE_API_KEY?.trim() || process.env.JEV_API_KEY?.trim()
  if (env) return env
  try {
    const k = readFileSync(`${homedir()}/.config/jev/api_key`, 'utf8').trim()
    if (k) return k
  } catch {}
  throw new Error('No Jev key: set TYPESAFE_API_KEY or save it to ~/.config/jev/api_key')
}
const key = apiKey()

async function ask(body: string): Promise<{ answers?: JevAnswers; tokens?: number; ms: number; error?: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = Date.now()
    try {
      const res = await fetch(JEV_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(20_000),
      })
      const ms = Date.now() - started
      if (!res.ok) {
        if (res.status >= 500 && attempt === 0) continue
        return { ms, error: `HTTP ${res.status}` }
      }
      const parsed = (await res.json()) as { answers?: JevAnswers; usage?: { input_tokens?: number } }
      return { answers: parsed.answers, tokens: parsed.usage?.input_tokens, ms }
    } catch (err) {
      if (attempt === 0) continue
      return { ms: Date.now() - started, error: err instanceof Error ? err.message : 'request failed' }
    }
  }
  return { ms: 0, error: 'request failed' }
}

const results: unknown[] = new Array(items.length)
let next = 0
let done = 0
async function worker() {
  while (next < items.length) {
    const i = next++
    const it = items[i]!
    const r = await ask(bodies[i]!)
    const a = r.answers
    let route: unknown = null
    if (a?.tier) {
      const d = decide(a, { focus: 2 })
      const c = choose({ models: MODELS, efforts: TIER_EFFORT, specialists: CLAUDE_SPECIALISTS }, d.tier!, { subject: d.subject, output: d.output, focus: 2 })
      const ideal = choose({ models: MODELS, efforts: TIER_EFFORT, specialists: CLAUDE_SPECIALISTS }, it.tier, { focus: 2 })
      route = { tier: d.tier, subject: d.subject ?? null, output: d.output ?? null, skill: d.skill?.name ?? null, model: c.model, effort: c.effort, idealModel: ideal.model, why: d.why }
    }
    results[i] = { ...it, ms: r.ms, tokens: r.tokens ?? null, error: r.error ?? null, answers: a ?? null, route }
    done++
    process.stdout.write(`\r${done}/${items.length}${r.error ? ` (${it.id}: ${r.error})` : ''}        `)
  }
}
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
console.log()

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify({ ranAt: new Date().toISOString(), skillsOffered: skills.length, results }, null, 1))

// A short summary; the report has the detail.
type Row = Item & { error: string | null; answers: JevAnswers | null; route: { tier: Tier; subject: string | null; skill: string | null } | null; tokens: number | null }
const rows = results as Row[]
const ok = rows.filter(r => r.route)
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : 'n/a')
const tierExact = ok.filter(r => r.route!.tier === r.tier).length
const tierNear = ok.filter(r => Math.abs(TIERS.indexOf(r.route!.tier) - TIERS.indexOf(r.tier)) <= 1).length
const subj = ok.filter(r => r.jev_subjects.length && r.route!.subject && r.jev_subjects.includes(r.route!.subject)).length
const risky = rows.filter(r => r.risky)
const flagged = risky.filter(r => (r.answers?.risky?.noul ?? 0) >= 0.7).length
const falseAlarms = rows.filter(r => !r.risky && (r.answers?.risky?.noul ?? 0) >= 0.7).length
const wantSkill = ok.filter(r => r.skills.some(s => s !== 'none'))
const skillRight = wantSkill.filter(r => r.route!.skill && r.skills.includes(r.route!.skill)).length
const noSkill = ok.filter(r => !r.skills.length || r.skills.includes('none'))
const extraHints = noSkill.filter(r => r.route!.skill && !r.skills.includes(r.route!.skill)).length
const tokens = rows.reduce((n, r) => n + (r.tokens ?? 0), 0)
console.log(`answered ${ok.length}/${rows.length}; difficulty exact ${pct(tierExact, ok.length)}, within one ${pct(tierNear, ok.length)}; subject in the labelled set ${pct(subj, ok.length)}`)
console.log(`risky flagged ${flagged}/${risky.length}, false alarms ${falseAlarms}; right skill hinted ${skillRight}/${wantSkill.length}; hints where none was expected ${extraHints}/${noSkill.length}`)
console.log(`${tokens} input tokens reported, about $${(tokens / 1e6 * PRICE_PER_MTOK).toFixed(3)}; saved to ${outPath}`)
