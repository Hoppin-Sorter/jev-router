# jev-router

Stop paying top-model prices for "rename this variable." Before each prompt, jev-router asks [Jev](https://docs.typesafe.ai) (TypeSafe's fast decision model) two things:

1. **What is this task?** How hard it is, what subject it's about (code, science, math, data, writing, business…) and what kind of output it wants.
2. **Which of your skills, if any, fits?** If one clearly does, the agent is nudged to use it.

From that, code picks the model (a subject specialist where the evidence supports one, like Fable 5.1 for hard science and math), and optionally the reasoning effort. A **focus** setting (0–4) trades quality against cost. It works with **Claude** and **OpenAI (GPT-6)** models.

One Jev call per prompt, about 0.3 seconds and a fraction of a cent.

```
you: rename foo to userCount in utils.ts      →  Haiku 4.5    |  GPT-6 Luna (low)
you: add a dark mode toggle to settings       →  Sonnet 5.5   |  GPT-6.1 Sol (medium)
you: checkout double-charges users, find why  →  Opus 5.5     |  GPT-6 Astra (high)   (risky)
you: weekly signups by country in BigQuery    →  Sonnet 5.5 + hint: data:sql-queries
```

## Which one do I use?

| You use | Use this | Picks the model for each prompt? |
|---|---|---|
| **Claude Code** (terminal, desktop app, IDE) | the [plugin](#install-the-claude-code-plugin) | Yes, automatically |
| **Claude Agent SDK** | the plugin, [loaded by the SDK](#use-with-the-claude-agent-sdk) | Yes (untested end to end) |
| **Your own app on the Claude API** | the [router library](#use-in-your-own-agent) | Yes |
| **Your own app on the OpenAI API** | the [router library](#use-with-openai-models-and-chatgpt) with `provider: "openai"` | Yes |
| **Codex CLI** (ChatGPT sign-in or API key) | [`jev_router.py --run codex`](#codex-cli) | For each run you launch with it. Codex has no way yet to switch models by itself mid-session |
| **The ChatGPT app / chatgpt.com** | not supported | No. The app has no hook for outside code to choose its model |
| **A Mac, to watch and steer it** | the [menu bar widget](#menu-bar-widget-macos) (optional) | Works alongside the plugin |

Everything needs your own Jev key, so start with [Your API key](#your-api-key-bring-your-own).

> **Early access.** The plugin uses Claude Code's function-hooks plugin API, which can change between releases. Built and tested on Claude Code 2.1.293. The OpenAI model names and settings come from OpenAI's docs as of October 2026; the Codex launcher has not been run against a real Codex install yet.

## Install the Claude Code plugin

```bash
claude plugin marketplace add Hoppin-Sorter/jev-router
claude plugin install jev-router@jev-router
```

Then add your own Jev API key (next section). Type `/jev` in a session to confirm it found the key.

## Your API key (bring your own)

**Nothing here ships with an API key.** Everyone who installs the plugin or copies the router uses their own TypeSafe account and pays for their own usage. Nobody can use your key unless you give it to them.

1. Create a key at [console.typesafe.ai](https://console.typesafe.ai) and copy it.
2. Save it on your machine, readable only by you:
   ```bash
   mkdir -p ~/.config/jev && pbpaste > ~/.config/jev/api_key && chmod 600 ~/.config/jev/api_key
   ```
   (`pbpaste` is macOS; elsewhere, write the key to that file any way you like.) The plugin and the command-line tool also read `TYPESAFE_API_KEY` or `JEV_API_KEY` from the environment.

How the key is handled:
- It is read from your machine at each prompt and sent **only** to `api.typesafe.ai` over HTTPS, as the request's `Authorization` header.
- It is never written anywhere, never shown in `/jev` or the status line (they show only *where* it was found), and never put in Claude's context.
- It lives outside the repo, and `.gitignore` blocks common key filenames (`api_key`, `*.key`, `.env`) in case you fork this. Don't paste your key into a chat with Claude or into an issue.

Without a key the plugin does nothing and your model is left alone.

## How it decides

**1. Difficulty sets the tier.**

| Jev says | Model | Needs Jev this sure (balanced focus) |
|---|---|---|
| mechanical | Haiku 4.5 | 85% |
| routine | Sonnet 5.5 | 70% |
| complex | Opus 5.5 | 50% |
| deep | Opus 5.5 (or Fable 5.1, see config) | — |

**2. The subject can swap in a specialist.** Today there are two, and only because public benchmarks back them: hard **science** and hard **math** go to **Fable 5.1** (it leads graduate-level science tests). Everywhere else Opus or Sonnet match or beat it for less, so the tier's model stays. [Your own eval](#tune-it-with-your-own-eval) can add or remove specialists.

**3. Focus trades quality against cost.**

| Focus | What changes |
|---|---|
| 0 Token efficient | Cheaper tiers win more easily; effort one step lower; no premium specialists (Fable) |
| 1 Lean | Cheaper tiers win a bit more easily; no premium specialists |
| 2 Balanced (default) | The thresholds above; specialists on |
| 3 Thorough | Doubt rounds up harder |
| 4 Task focused | Doubt rounds up hardest; never below Sonnet; effort one step higher |

**4. Output type tunes effort.** A quick factual answer thinks one step less than the tier's effort.

And at every focus level:
- **Risky prompts floor at Opus.** Anything Jev rates likely to touch production, credentials, permissions, billing, or irreversible deletion (≥ 0.7) never goes below Opus.
- **No mid-task downgrades.** Within an active stretch the tier only goes up, and a task that started on a specialist stays on it, so "yes, go ahead" stays on the model that planned the work and the prompt cache stays warm. It resets after 10 idle minutes or `/jev reset`.
- **Effort is optional in the plugin.** With effort on, it follows the tier (routine → medium, complex → high, deep → xhigh), moved by focus and output type. Off by default, which keeps your session's effort.
- **Skills** are chosen from your installed skills and commands, with `none` as an option. A hint is added only at 50%+ confidence.
- **Routed:** prompts you type, prompts from the Agent SDK, and the prompts scheduled routines fire.
- **Not routed:** slash commands, background notifications, and subagents (they keep their own model).

## Is this session using Jev?

Look under the prompt. The plugin pins one status line there as soon as a session starts:

| Status line | Means |
|---|---|
| `Jev: auto` | Connected, waiting for the first prompt |
| `Jev → Sonnet 5.5 · data · /data:sql-queries` | Jev's pick for this task: model, effort if routed, subject, skill hint |
| `Jev (shadow) would pick Haiku 4.5` | Shadow mode: logged, nothing switched |
| `Jev → Opus 5.5 (pinned)` / `(you)` | A tier you pinned, or a model you nudged |
| `Jev: no API key (run /jev)` | Installed, but it can't ask Jev, so your model is left alone |
| `Jev: timed out; kept Opus 5.5` | Jev didn't answer in time this prompt; the model stayed as it was |
| nothing | The router is off. If `/jev` isn't a command either, the plugin isn't installed in this session |

`/jev` gives the full picture: mode, focus, where the key was found and the last 10 decisions.

Change focus, mode and the switches with [`/jev`](#commands) or the [menu bar widget](#menu-bar-widget-macos). Your choices are remembered across sessions and shared through `~/.config/jev/settings.json`. The widget's **− / +** moves a session's model down or up one tier right away, mid-turn included; routing picks up again with the next task.

**Shadow mode** asks Jev and logs what it would pick, but leaves the session's model alone and hints no skill. Use it to see how routing would behave before you let it switch anything. It still costs one Jev call per prompt.

## Menu bar widget (macOS)

`widget/` is an optional menu bar app, **Jev Bar**, for macOS 14 or later. It shows what the router is doing and lets you steer it without typing commands.

- **Menu bar:** an icon and the model family, like `⑂ Sonnet`. The icon is an eye in shadow mode and a pause sign when the router is off.
- **Off / Shadow / On** at the top of the panel.
- **Now:** the latest pick (model, tier, subject, effort, skill), Jev's confidence and latency, and whether that session is working or idle and for how long. **− / +** move that session's model down or up one tier on its next request.
- **Focus:** a 5-step slider from Token efficient to Task focused, like `/jev focus`, plus the Effort, Skills and Specialists switches.
- **Saved:** for Today, 7 days or 30 days, what your Claude Code requests were worth at API list prices, against the same tokens all on Opus 5.5, minus what Jev cost, with a bar showing the model mix. These are list-price values; a Pro or Max plan bills differently.
- **Recent:** the last five decisions. Never your prompt text.
- **⋯ menu:** **Customize** shows or hides each card, and turns on the optional **Water & CO₂** line (below). **Pop out** opens a small floating pill (model, focus, today's savings) that stays on top on every Space; drag it anywhere. **Floating icon** puts a small Jev icon on screen; park it just above Claude's reply box, say. It belongs to the Claude Code session on screen: it shows only while Claude is in front with a Code session open, keeps to the conversation area right of the sidebar (and left of a terminal or preview pane), follows it when you move the window or collapse the sidebar, and disappears in a chat or any other app. Telling a session from a chat and finding the sidebar reads Claude's window through Accessibility, so Jev Bar asks for that access (⋯ → **Allow Accessibility access…**); without it the icon keeps to the whole Claude window in every tab. **Only show over Claude** turns all this off, and the icon then stays on top on every Space. Click it and it turns into an X with a dial above it: drag the focus slider (Task focused at the top, Token efficient at the bottom) and click the circles to switch the router (on → shadow → off), effort, skills and specialists. Click the X to close it, drag the icon to move it. It's off until you turn it on.

The widget is never built for you. Installing the plugin doesn't build it, and nothing in jev-router runs the build script on its own. When you want it, build it yourself (needs Xcode or the Command Line Tools, Swift 5.9+):

```bash
cd widget
swift run JevCoreChecks          # optional: checks the pricing, settings and transcript logic
scripts/bundle.sh --install      # asks first, then builds "Jev Bar.app" and signs it ad hoc;
                                 # asks again before copying it to ~/Applications and opening it
```

`bundle.sh` asks before it builds and again before it installs, and answers no if there's no terminal to ask on. Pass `--yes` only if you've already decided, for example in your own setup script. If an AI assistant is setting jev-router up for you, it should ask you before building the widget too (see `CLAUDE.md`).

The app is signed ad hoc, not notarized. If macOS blocks the first launch, Control-click the app in Finder and choose **Open**. To start it at login, add it under System Settings → General → Login Items.

### Water & CO₂ (optional)

Turn on **⋯ → Customize → Water & CO₂ (estimate)** for a small note under **Saved**, like:

```
🍃 Saved ≈ 0.37 mL water · ≈ 136 mg CO₂e in 30 days
   ≈ 0.34 Wh, like an LED bulb on for 2 min
```

It's off by default and display only: the router never reads it, so it has no effect on which model Jev picks. It covers the last 30 days unless you pick another window under **⋯ → Customize → Water & CO₂ over**; it doesn't follow the Saved picker, because one day's figure is usually too small to mean much. The second line compares the energy to something everyday: minutes of a 10 W LED bulb below 15 Wh, phone charges (about 15 Wh each) from there up.

It's a rough estimate. Anthropic doesn't publish per-model energy figures, so it treats API list price as a stand-in for compute and converts the dollars saved:

| Step | Factor | Basis |
|---|---|---|
| Energy | 60 Wh per $ of list-price usage | [Epoch AI](https://epoch.ai/gradient-updates/how-much-energy-does-chatgpt-use)'s ~0.3 Wh for a typical GPT-4o query, which is about $0.005 at list price |
| Water | 1.1 L per kWh | [Google's Gemini figures](https://cloud.google.com/blog/products/infrastructure/measuring-the-environmental-impact-of-ai-inference) (0.26 mL per 0.24 Wh, data-center cooling only) |
| CO₂e | 0.4 kg per kWh | about the US grid average (location-based; providers buying clean power report less) |

Hover over the note for the assumptions. When routing cost more than Opus 5.5 would have (say, a lot of Fable), it reads **Used** instead of **Saved**. The factors live in `widget/Sources/JevCore/Impact.swift`.

### How the widget and the plugin talk

Through three small files in `~/.config/jev/`. There's no server and nothing leaves your Mac.

| File | Written by | Holds |
|---|---|---|
| `settings.json` | both | mode (`auto`, `shadow` or `off`), focus 0–4, the effort/skills/specialists switches, a one-shot `nudge` for one session, and `updatedAt`. The newer write wins, so `/jev`, the widget and other sessions stay in sync. |
| `last.json` | plugin | the latest decision, the session it came from, and whether that session is working |
| `decisions.jsonl` | plugin | one decision per line, newest last, trimmed to about 500 lines. Model, tier, subject, skill, confidence, latency and Jev cost. **No prompt text.** |

The **Saved** card reads token usage from Claude Code's own transcripts in `~/.claude/projects/` (each request counted once) and caches what it has read, so only changed files are read again. Prices per million tokens (input / output / cache read), from Anthropic's pricing page in October 2026: Haiku 4.5 $1 / $5 / $0.10, Sonnet 5.5 $2 / $10 / $0.20, Opus 5.5 $4 / $20 / $0.20, Fable 5.1 $10 / $50 / $0.25, Opus 5 $5 / $25 / $0.50, Fable 5 $10 / $50 / $1.00. Cache writes cost 1.25× input (5-minute) or 2× (1-hour). Jev is $0.042 per million input tokens. Requests on other models are left out and counted separately.

## Commands

| Command | Does |
|---|---|
| `/jev` | Status, key check, and the last 10 decisions (model, tier and reason; prompts aren't stored) |
| `/jev auto` / `/jev off` | Turn routing on / off |
| `/jev shadow` | Ask Jev and log its pick, but don't switch the model or hint a skill |
| `/jev pin <tier>` | Force one tier (skill hints keep running) |
| `/jev reset` | Forget the held tier; judge the next prompt fresh |
| `/jev focus <0-4 or name>` | Set focus: token-efficient, lean, balanced, thorough, task-focused |
| `/jev effort\|skills\|specialists on\|off` | Turn one feature on or off |

## Config

Set in `/plugin configure jev-router@jev-router`. Choices made with `/jev` or the widget override these once you use them.

| Option | Default | |
|---|---|---|
| `focus` | `balanced` | Starting focus until you change it. |
| `deepModel` | `claude-opus-5-5` | Model for the deepest tier on every subject. Set `claude-fable-5-1` for a stronger (and pricier) top tier everywhere. |
| `skillHints` | `true` | Tell Claude which installed skill Jev picked. |
| `effortRouting` | `false` | Also set reasoning effort (see above). Haiku takes none. Off keeps your session's effort. |

## Tune it with your own eval

The specialists table is only as good as the evidence behind it. `eval/run_eval.py` answers each prompt in `eval/prompts.jsonl` (28 to start, across seven subjects and two difficulties) with Haiku, Sonnet, Opus and Fable through your `claude` CLI, has a judge model grade the answers blind, and suggests the cheapest model within half a point of the best for each subject and difficulty.

```bash
python3 eval/run_eval.py --dry-run          # the plan and a rough cost, no calls
python3 eval/run_eval.py --limit 4          # a small first run
python3 eval/run_eval.py --subjects science,math --judge fable
```

It writes `eval/results/summary.md` and `suggested-specialists.json`, which you paste into `CLAUDE_SPECIALISTS` in `lib/jev-router.ts` and `lib/jev_router.py`. The full set is 140 calls, about $8 at API prices, or a share of your plan's limits when your CLI is signed in to a Claude plan. Runs load no settings, plugins, hooks, MCP servers or skills, and use no tools, so the router itself doesn't steer them; that works with a Claude plan sign-in or an API key. Opus 5.5 needs Claude Code 2.1.280 or newer; point `--claude-bin` at a newer CLI if yours is older. `--jobs 6` works on six prompts at once, and `--resume` picks up a run that stopped. Swap in your own prompts for the best results.

A judge can favor answers like its own, so grade the same answers again with another one: `python3 eval/rejudge.py --answers eval/results/answers.jsonl --judge sonnet` writes `rejudge-sonnet.jsonl` and prints each model's average under both judges. It makes only judge calls, so it costs a fraction of the first run.

`eval/usecases.jsonl` is a larger set to pass with `--prompts`: 143 prompts across 13 areas (coding, app building, design, visuals, generative art, data, strategy, law, writing, science and math, operations, everyday, risky operations), each labelled with a difficulty. `node eval/jev_readings.ts --skills skills.json` uses the same set for a different check: it sends the prompts to the live Jev API and compares Jev's difficulty, subject, risk and skill answers with the labels, for about 4 cents (`--dry-run` shows the estimate first). `skills.json` is a list of `{ "name", "description" }` for the skills your sessions offer.

## Use with the Claude Agent SDK

The [Agent SDK](https://code.claude.com/docs/en/agent-sdk/plugins) runs Claude Code as a library and loads local plugins. Clone this repo, then point the SDK at it:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "…",
  options: { plugins: [{ type: "local", path: "/absolute/path/to/jev-router" }] },
})) {
  // the init message's `plugins` list should include jev-router
}
```

Python: `ClaudeAgentOptions(plugins=[{"type": "local", "path": "/absolute/path/to/jev-router"}])`.

Set `TYPESAFE_API_KEY` in the environment the SDK runs in (on a server, use your secrets manager). This path follows Anthropic's plugin docs but hasn't been tested end to end yet. If you try it, please open an issue with how it went.

## Use in your own agent

For an agent you build yourself on the Claude API, use the router directly. One file, no dependencies: [`lib/jev-router.ts`](lib/jev-router.ts) (Node 18+, Bun, Deno) or [`lib/jev_router.py`](lib/jev_router.py) (Python 3.9+, standard library). Copy it into your project and call it with each new user prompt:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { createRouter } from "./jev-router";

const client = new Anthropic();
const router = createRouter({
  apiKey: process.env.TYPESAFE_API_KEY!, // your own key, never hard-coded
  skills: [{ name: "sql-queries", description: "Write correct, performant SQL" }],
});

const r = await router.route(userMessage);
// r = { tier, model, effort, subject, output, specialist, skill, routed, why }
const reply = await client.messages.create({
  model: r.model,
  max_tokens: 16000,
  ...(r.effort && { output_config: { effort: r.effort } }),
  messages: [{ role: "user", content: userMessage }],
});
```

```python
import os
import anthropic
from jev_router import Router

client = anthropic.Anthropic()
router = Router(api_key=os.environ["TYPESAFE_API_KEY"],
                skills=[{"name": "sql-queries", "description": "Write correct, performant SQL"}])

r = router.route(user_message)  # Route(tier, model, effort, subject, output, specialist, skill, routed, why)
reply = client.messages.create(
    model=r.model,
    max_tokens=16000,
    messages=[{"role": "user", "content": user_message}],
    **({"output_config": {"effort": r.effort}} if r.effort else {}),
)
```

- **Same rules as the plugin:** doubt rounds up, risky prompts floor at Opus, and one router instance holds its tier for 10 minutes so follow-ups stay on the same model. Call `reset()` when a new task starts.
- **`r.skill`** is the name of the skill Jev picked, or none. How you load it is up to your agent (for example, add that skill's instructions to the system prompt).
- **If Jev fails** (no network, bad key, over 3 s), `routed` is false and you get the `fallback` tier (default `complex`), so a request never blocks on the router.
- **Options:** `provider` (`"anthropic"` default, or `"openai"`), `focus` (0–4; `setFocus()` / `set_focus()` changes it later), `models`, `efforts` and `specialists` to change any tier's model, effort or subject specialists, `holdMs` / `hold_seconds` (0 turns holding off), `timeoutMs` / `timeout`, `fallback`.
- Off-the-shelf tools like Cursor generally don't let outside code switch their model per prompt, so the router fits agents where you make the API call yourself. For Codex, see [below](#codex-cli).

## Use with OpenAI models and ChatGPT

The same router picks between OpenAI's GPT-6 models. Pass `provider: "openai"` (TypeScript) or `provider="openai"` (Python):

| Jev says | Model | Reasoning effort |
|---|---|---|
| mechanical | `gpt-6-luna` | low |
| routine | `gpt-6.1-sol` | medium |
| complex | `gpt-6-astra` | high |
| deep | `gpt-6-astra` | xhigh |

Every pairing is valid for its model, and the other rules (doubt rounds up, risky prompts floor at `complex`, tier holding) are the same as above. To spend less, move `complex` to Sol: `models: { complex: "gpt-6.1-sol" }`.

### OpenAI API

```ts
import OpenAI from "openai";
import { createRouter } from "./jev-router";

const client = new OpenAI();
const router = createRouter({ apiKey: process.env.TYPESAFE_API_KEY!, provider: "openai" });

const r = await router.route(userMessage);
const reply = await client.responses.create({
  model: r.model,
  ...(r.effort && { reasoning: { effort: r.effort } }),
  input: userMessage,
});
```

```python
import os
from openai import OpenAI
from jev_router import Router

client = OpenAI()
router = Router(api_key=os.environ["TYPESAFE_API_KEY"], provider="openai")

r = router.route(user_message)
reply = client.responses.create(
    model=r.model,
    **({"reasoning": {"effort": r.effort}} if r.effort else {}),
    input=user_message,
)
```

On the Chat Completions API, pass `reasoning_effort=r.effort` instead.

### Codex CLI

`lib/jev_router.py` is also a command. It asks Jev, then launches Codex with the right model and effort for that one run. Python 3.9+ is the only requirement.

```bash
# see the decision
python3 lib/jev_router.py "fix the failing test in auth.spec.ts"
# {"tier": "routine", "model": "gpt-6.1-sol", "effort": "medium", "skill": null, "routed": true, ...}

# run it: non-interactive, or an interactive session
python3 lib/jev_router.py --run codex-exec "fix the failing test in auth.spec.ts"
python3 lib/jev_router.py --run codex "fix the failing test in auth.spec.ts"
```

`--run` runs `codex exec -m <model> -c model_reasoning_effort="<effort>" "<prompt>"` for you (plain `codex` for the interactive form). Add `--focus` (0–4 or a name) to trade quality against cost (without it, the focus saved in `~/.config/jev/settings.json` by the plugin or the widget is used, else balanced), and `--skills-dir DIR` (repeatable; default `~/.codex/skills`) to let Jev pick from your skills; a pick becomes a one-line suggestion at the top of the prompt. Each run is independent, so there is no tier holding between runs.

- **Why per run, not automatic?** Codex doesn't let a plugin or hook change the model between turns. [A request for that](https://github.com/openai/codex/issues/45904) is open. Until it ships, the launcher is the way to get routing. Inside an interactive Codex session you can still follow Jev's suggestion by hand with `/model`.
- Add a shell alias if you like: `alias cx='python3 /path/to/jev_router.py --run codex'`.

### The ChatGPT app

Not supported. The ChatGPT app (and chatgpt.com) has no hook for outside code to pick its model, so nothing here can switch it for you. If you use ChatGPT through Codex, use the Codex launcher above.

## Cost

Jev is billed per input token on your TypeSafe account. Check [current pricing](https://docs.typesafe.ai/models). Each prompt sends your message plus a short list of your skills, so cost grows a little with how many skills you have. Routing simple prompts to Sonnet or Haiku usually saves more on the Claude side than Jev costs.

## What gets sent to TypeSafe

Per prompt, to `https://api.typesafe.ai/v1/systemone`: the first 6,000 characters of your message, and the name plus first 200 characters of the description of each installed skill or command. Nothing else (no files, no conversation history). Your prompt also goes to Anthropic or OpenAI as it normally would, whichever model you use. If sending prompts to TypeSafe isn't acceptable for a project, run `/jev off` (plugin) or don't call the router. Shadow mode still sends them.

Nothing on disk keeps your prompts: the plugin's own history and the files in `~/.config/jev/` hold the decision only (model, tier, subject, skill, reason, timing). Versions before 0.6 kept the first 80 characters of each prompt in the plugin's history; 0.6 drops them when it reads that history and stops writing them.

## Limits

- Effort routing is a mapping from the tier, focus and output type, not a separate judgment by Jev. With it off, effort stays at your session setting (it is always dropped for Haiku, which doesn't take one).
- Jev's accuracy is strongest on English. See TypeSafe's [known weaknesses](https://docs.typesafe.ai/model-jaggedness/jev-1.13).
- If Jev is slow (> 3 s), errors, or the key is missing, the prompt goes through unrouted.

## Development

AI assistants working in this repo: read `CLAUDE.md` first. In short, don't build or install the widget for someone without asking them.

```bash
claude plugin validate .                      # plugin manifest + hooks
claude plugin test .                          # plugin tests (tests/router.test.ts)
node --test tests/jev-router.spec.ts tests/contract.spec.ts   # TypeScript router, ~/.config/jev contract
python3 -m unittest discover -s tests         # Python router, Codex launcher, eval harness, TS/Python parity, widget fixtures
(cd widget && swift run JevCoreChecks)        # widget logic, on a Mac (or any machine with Swift)
claude --plugin-dir .                         # load the plugin for one session
```

The rubric, thresholds and decision logic live in `lib/jev-router.ts`; the plugin imports them, and `lib/jev_router.py` mirrors them. Change both together. The same goes for `lib/contract.ts` and `widget/Sources/JevCore/Contract.swift`, the two sides of the `~/.config/jev/` files. `widget/Fixtures/expected.json` holds hand-worked savings numbers that both the Swift checks and `tests/test_widget_fixtures.py` verify.

## Credits

Built on [Jev](https://typesafe.ai) by TypeSafe AI. This project is independent and not affiliated with or endorsed by TypeSafe or Anthropic.

## License

MIT
