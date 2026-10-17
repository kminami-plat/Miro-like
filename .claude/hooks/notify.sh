#!/usr/bin/env bash
# Stop hook: desktop notification when Claude finishes a turn.
# Turns long-running sessions into true background work — you stop
# checking the terminal compulsively. Runs async; never blocks.
# Delete this hook if you find per-turn notifications noisy in short
# interactive sessions (its value is in the long ones).

if command -v osascript >/dev/null 2>&1; then # macOS
  osascript -e 'display notification "Finished — ready for your review" with title "Claude Code"' >/dev/null 2>&1
elif command -v notify-send >/dev/null 2>&1; then # Linux
  notify-send "Claude Code" "Finished — ready for your review" >/dev/null 2>&1
fi
exit 0
