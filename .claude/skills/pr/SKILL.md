---
name: pr
description: Push the current branch and open a well-described pull request
disable-model-invocation: true
allowed-tools: Bash(git *), Bash(gh *)
---

## Current state

!`git status --short && git log --oneline @{upstream}..HEAD 2>/dev/null || git log --oneline -5`

## Procedure

1. Refuse politely if on the default branch — offer to create a branch first.
2. Ensure the tree is clean (offer `/commit` if not) and push with `-u`.
3. Open the PR with `gh pr create`. Description structure:
   - **What** — 1–3 sentences, plain language, written for a reviewer who hasn't seen this conversation.
   - **Why** — the motivation or linked issue. Never invent issue numbers.
   - **How to verify** — exact commands or click-path a reviewer can run.
   - **Notes** — anything unusual: known gaps, follow-ups, decisions that could be contested.
4. Keep the title in the repo's existing PR title style (check `gh pr list --limit 5` if unsure).
5. Print the PR URL as the final line.
