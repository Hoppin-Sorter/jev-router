# jev-router

A Claude Code plugin that asks [Jev](https://docs.typesafe.ai) (TypeSafe's fast decision model) two things before every prompt:

1. **Which Claude model does this task need?** Simple edits go to Haiku, everyday coding to Sonnet, hard or risky work to Opus.
2. **Which installed skill, if any, fits?** If one clearly does, Claude gets a hidden note to use it.

One Jev call per prompt, about 0.3 seconds.

```
you: rename foo to userCount in utils.ts      →  Haiku 4.5
you: add a dark mode toggle to settings       →  Sonnet 5.5
you: checkout double-charges users, find why  →  Opus 5.5   (risky)
you: weekly signups by country in BigQuery    →  Sonnet 5.5 + hint: data:sql-queries
```

> **Early access.** This uses Claude Code's function-hooks plugin API, which can change between releases. Built and tested on Claude Code 2.1.289.

## Install

```bash
claude plugin marketplace add Hoppin-Sorter/jev-router
claude plugin install jev-router@jev-router
```

Then add your own Jev API key (next section). Type `/jev` in a session to confirm it found the key.

## Your API key (bring your own)

**This plugin ships with no API key.** Everyone who installs it uses their own TypeSafe account and pays for their own usage. Nobody can use your key unless you give it to them.

1. Create a key at [console.typesafe.ai](https://console.typesafe.ai) and copy it.
2. Save it on your machine, readable only by you:
   ```bash
   mkdir -p ~/.config/jev && pbpaste > ~/.config/jev/api_key && chmod 600 ~/.config/jev/api_key
   ```
   (`pbpaste` is macOS; elsewhere, write the key to that file any way you like.) The plugin also reads `TYPESAFE_API_KEY` or `JEV_API_KEY` from the environment.

How the key is handled:
- It is read from your machine at each prompt and sent **only** to `api.typesafe.ai` over HTTPS, as the request's `Authorization` header.
- It is never written anywhere, never shown in `/jev` or the status line (they show only *where* it was found), and never put in Claude's context.
- It lives outside the repo, and `.gitignore` blocks common key filenames (`api_key`, `*.key`, `.env`) in case you fork this. Don't paste your key into a chat with Claude or into an issue.

Without a key the plugin does nothing and your model is left alone.

## How it decides

| Jev says | Model | Needs Jev this sure |
|---|---|---|
| mechanical | Haiku 4.5 | 85% |
| routine | Sonnet 5.5 | 70% |
| complex | Opus 5.5 | 50% |
| deep | Opus 5.5 (or Fable 5.1, see config) | — |

- **Doubt rounds up.** The cheapest tier wins only when Jev's probability that it is enough clears the bar above.
- **Risky prompts floor at Opus.** Anything Jev rates likely to touch production, credentials, permissions, billing, or irreversible deletion (≥ 0.7) never goes below Opus.
- **No mid-task downgrades.** Within an active stretch the tier only goes up, so "yes, go ahead" stays on the model that planned the work and the prompt cache stays warm. It resets after 10 idle minutes or `/jev reset`.
- **Effort (optional).** With `effortRouting` on, reasoning effort follows the tier too: routine → medium, complex → high, deep → xhigh. Off by default, which keeps your session's effort.
- **Skills** are chosen from your installed skills and commands, with `none` as an option. A hint is added only at 50%+ confidence.
- **Not routed:** slash commands, notifications, and subagents (they keep their own model).

## Commands

| Command | Does |
|---|---|
| `/jev` | Status, key check, and the last 10 decisions |
| `/jev auto` / `/jev off` | Turn routing on / off |
| `/jev pin <tier>` | Force one tier (skill hints keep running) |
| `/jev reset` | Forget the held tier; judge the next prompt fresh |

## Config

Set in `/plugin configure jev-router@jev-router`:

| Option | Default | |
|---|---|---|
| `deepModel` | `claude-opus-5-5` | Model for the deepest tier. Set `claude-fable-5-1` for a stronger (and pricier) top tier. |
| `skillHints` | `true` | Tell Claude which installed skill Jev picked. |
| `effortRouting` | `false` | Also set reasoning effort by tier: routine → medium, complex → high, deep → xhigh. Haiku takes none. Off keeps your session's effort. |

## Cost

Jev is billed per input token on your TypeSafe account. Check [current pricing](https://docs.typesafe.ai/models). Each prompt sends your message plus a short list of your skills, so cost grows a little with how many skills you have. Routing simple prompts to Sonnet or Haiku usually saves more on the Claude side than Jev costs.

## What gets sent to TypeSafe

Per prompt, to `https://api.typesafe.ai/v1/systemone`: the first 6,000 characters of your message, and the name plus first 200 characters of the description of each installed skill or command. Nothing else (no files, no conversation history). If that's not acceptable for a project, run `/jev off`.

## Limits

- Effort routing is a fixed mapping from the tier, not a separate judgment by Jev. With it off, effort stays at your session setting (it is always dropped for Haiku, which doesn't take one).
- Jev's accuracy is strongest on English. See TypeSafe's [known weaknesses](https://docs.typesafe.ai/model-jaggedness/jev-1.13).
- If Jev is slow (> 3 s), errors, or the key is missing, the prompt goes through unrouted.

## Development

```bash
claude plugin validate .   # manifest + hooks
claude plugin test .       # the tests in tests/
claude --plugin-dir .      # load it for one session
```

## Credits

Built on [Jev](https://typesafe.ai) by TypeSafe AI. This project is independent and not affiliated with or endorsed by TypeSafe or Anthropic.

## License

MIT
