# jev-router: notes for AI assistants

## Setting this up for someone

- Installing the Claude Code plugin never builds anything. The plugin runs no processes; it only reads and writes small files in `~/.config/jev/`.
- **Don't build or install the menu bar widget unless the person says yes first.** That covers `widget/scripts/bundle.sh` (with or without `--install`), `swift build` and `swift run` in `widget/`, and copying or opening `Jev Bar.app`. Tell them what it does (it compiles a Swift app, signs it ad hoc, and with `--install` copies it to `~/Applications` and opens it) and ask. Only pass `--yes` after they've said yes in this conversation.
- Never write, print or commit a Jev API key. Each person saves their own to `~/.config/jev/api_key`.

## Working on the code

- Tests: `claude plugin test .`, `node --test tests/jev-router.spec.ts tests/contract.spec.ts`, `python3 -m unittest discover -s tests`, and on a Mac `(cd widget && swift run JevCoreChecks)`. Running the checks builds a small check program; that's fine when you're developing here, since it isn't installing anything for the person.
- `lib/jev-router.ts` and `lib/jev_router.py` mirror each other; so do `lib/contract.ts` and `widget/Sources/JevCore/Contract.swift`. Change both sides together.
- The widget's water and CO₂ figures are display-only estimates. Nothing in routing reads them; keep it that way.
