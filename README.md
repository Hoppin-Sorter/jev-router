# jev-router

Stop paying top-model prices for "rename this variable." Before each prompt, jev-router asks [Jev](https://docs.typesafe.ai) (TypeSafe's fast decision model) two things:

1. **What is this task?** How hard it is, what subject it's about (code, science, math, data, writing, business…) and what kind of output it wants.
2. **Which of your skills, if any, fits?** If one clearly does, the agent is nudged to use it.

From that, code picks the model (a subject specialist where the evidence supports one, like Fable 5.1 for hard science and math), and optionally the reasoning effort. A **focus slider** trades quality against cost. It works with **Claude** and **OpenAI (GPT-6)** models.

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

Everything needs your own Jev key, so start with [Your API key](#your-api-key-bring-your-own).

> **Early access.** The plugin uses Claude Code's function-hooks plugin API, which can change between releases. Built and tested on Claude Code 2.1.289. The OpenAI model names and settings come from OpenAI's docs as of October 2026; the Codex launcher has not been run against a real Codex install yet.

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

## The control bar

The plugin draws one line above the prompt with the current pick and focus. **Adjust** opens the controls:

```
Focus  Token efficient ○ ○ ● ○ ○ Task focused  (Balanced)
[ Router on ] [ Effort off ] [ Skills on ] [ Specialists on ]   Model − Opus 5.5 · science +   Done  Hide
```

- **Focus dots** set the quality/cost trade-off. Your choice is remembered across sessions.
- **Router / Effort / Skills / Specialists** turn each feature on or off.
- **Model − / +** moves this task's model down or up one tier right away, mid-turn included. Routing picks up again with the next task.
- **Hide** removes the bar; `/jev bar` brings it back. Set `focusBar` to `false` to start with it hidden.

## Commands

| Command | Does |
|---|---|
| `/jev` | Status, key check, and the last 10 decisions |
| `/jev auto` / `/jev off` | Turn routing on / off |
| `/jev pin <tier>` | Force one tier (skill hints keep running) |
| `/jev reset` | Forget the held tier; judge the next prompt fresh |
| `/jev focus <0-4 or name>` | Set focus: token-efficient, lean, balanced, thorough, task-focused |
| `/jev bar` | Show or hide the control bar |
| `/jev effort\|skills\|specialists on\|off` | Turn one feature on or off |

## Config

Set in `/plugin configure jev-router@jev-router`. The control bar's choices override these once you use it.

| Option | Default | |
|---|---|---|
| `focus` | `balanced` | Starting focus until you move the slider. |
| `focusBar` | `true` | Show the control bar above the prompt. |
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

It writes `eval/results/summary.md` and `suggested-specialists.json`, which you paste into `CLAUDE_SPECIALISTS` in `lib/jev-router.ts` and `lib/jev_router.py`. The full set is 140 calls, about $8 at API prices, or a share of your plan's limits when your CLI is signed in to a Claude plan. Runs use `--bare` and no tools, so the router itself doesn't steer them. Swap in your own prompts for the best results. A judge can favor answers like its own, so try a second `--judge`.

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

`--run` runs `codex exec -m <model> -c model_reasoning_effort="<effort>" "<prompt>"` for you (plain `codex` for the interactive form). Add `--focus` (0–4 or a name) to trade quality against cost, and `--skills-dir DIR` (repeatable; default `~/.codex/skills`) to let Jev pick from your skills; a pick becomes a one-line suggestion at the top of the prompt. Each run is independent, so there is no tier holding between runs.

- **Why per run, not automatic?** Codex doesn't let a plugin or hook change the model between turns. [A request for that](https://github.com/openai/codex/issues/45904) is open. Until it ships, the launcher is the way to get routing. Inside an interactive Codex session you can still follow Jev's suggestion by hand with `/model`.
- Add a shell alias if you like: `alias cx='python3 /path/to/jev_router.py --run codex'`.

### The ChatGPT app

Not supported. The ChatGPT app (and chatgpt.com) has no hook for outside code to pick its model, so nothing here can switch it for you. If you use ChatGPT through Codex, use the Codex launcher above.

## Cost

Jev is billed per input token on your TypeSafe account. Check [current pricing](https://docs.typesafe.ai/models). Each prompt sends your message plus a short list of your skills, so cost grows a little with how many skills you have. Routing simple prompts to Sonnet or Haiku usually saves more on the Claude side than Jev costs.

## What gets sent to TypeSafe

Per prompt, to `https://api.typesafe.ai/v1/systemone`: the first 6,000 characters of your message, and the name plus first 200 characters of the description of each installed skill or command. Nothing else (no files, no conversation history). Your prompt also goes to Anthropic or OpenAI as it normally would, whichever model you use. If sending prompts to TypeSafe isn't acceptable for a project, run `/jev off` (plugin) or don't call the router.

## Limits

- Effort routing is a mapping from the tier, focus and output type, not a separate judgment by Jev. With it off, effort stays at your session setting (it is always dropped for Haiku, which doesn't take one).
- Jev's accuracy is strongest on English. See TypeSafe's [known weaknesses](https://docs.typesafe.ai/model-jaggedness/jev-1.13).
- If Jev is slow (> 3 s), errors, or the key is missing, the prompt goes through unrouted.

## Development

```bash
claude plugin validate .                      # plugin manifest + hooks
claude plugin test .                          # plugin tests (tests/router.test.ts)
node --test tests/jev-router.spec.ts          # TypeScript router
python3 -m unittest discover -s tests         # Python router, Codex launcher, eval harness, TS/Python parity
claude --plugin-dir .                         # load the plugin for one session
```

The rubric, thresholds and decision logic live in `lib/jev-router.ts`; the plugin imports them, and `lib/jev_router.py` mirrors them. Change both together.

## Credits

Built on [Jev](https://typesafe.ai) by TypeSafe AI. This project is independent and not affiliated with or endorsed by TypeSafe or Anthropic.

## License

MIT
