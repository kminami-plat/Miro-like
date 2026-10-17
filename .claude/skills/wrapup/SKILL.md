---
name: wrapup
description: End-of-session ritual — distill learnings into CLAUDE.md and write a handoff note
disable-model-invocation: true
---

End the working session cleanly. Do these in order:

1. **Harvest corrections.** Scan this conversation for anything the user corrected you on, or project facts you discovered the hard way (conventions, landmines, commands). If — and only if — a fact will matter in *future* sessions, add it to CLAUDE.md as a single tight line. Most sessions yield 0–2 lines; adding more is padding. Never restate what the code already shows.

2. **Write the handoff.** Overwrite `HANDOFF.md` at the repo root with: what was accomplished (2–3 lines), what is in progress and its exact state (branch, failing test, next step), and any decisions made with their why. Write it for a colleague resuming cold tomorrow — that colleague is usually a fresh Claude session, so name files and commands explicitly.

3. **Leave the tree honest.** Report `git status` — uncommitted work should be either committed (offer `/commit`) or explicitly listed in the handoff as intentionally uncommitted.

Keep the whole output short; this is a ritual, not a report.
