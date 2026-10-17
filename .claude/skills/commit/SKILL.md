---
name: commit
description: Create a well-scoped git commit from current changes, matching the repo's message style
allowed-tools: Bash(git *)
---

## Current state

!`git status --short && git diff --stat HEAD`

## Recent message style

!`git log --oneline -8`

## Procedure

1. Review the changes above. If they contain **more than one logical change**, say so and propose splitting into separate commits; stage and commit them one at a time.
2. Stage only what belongs to this commit (`git add <paths>` — never `git add -A` blindly).
3. Write the message in the style of the recent log above: same tense, same prefix conventions (e.g. `feat:`/`fix:` if the repo uses them), subject ≤ 72 chars, body only when the *why* isn't obvious from the diff.
4. Never mention files that aren't in the commit; never invent ticket numbers.
5. Show the final `git log -1 --stat` as confirmation.
