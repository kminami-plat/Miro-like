#!/usr/bin/env bash
# PostToolUse hook: auto-format whatever file Claude just edited.
# Detects the right formatter by extension; silently no-ops when the
# formatter isn't installed. Exit 0 always — formatting must never block.

file=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))' 2>/dev/null)
[ -n "$file" ] && [ -f "$file" ] || exit 0

case "$file" in
  *.py)
    command -v ruff >/dev/null 2>&1 && ruff format "$file" >/dev/null 2>&1 ;;
  *.js|*.jsx|*.ts|*.tsx|*.css|*.json)
    command -v prettier >/dev/null 2>&1 && prettier --write "$file" >/dev/null 2>&1 ;;
  *.go)
    command -v gofmt >/dev/null 2>&1 && gofmt -w "$file" ;;
  *.rs)
    command -v rustfmt >/dev/null 2>&1 && rustfmt --edition 2021 "$file" >/dev/null 2>&1 ;;
  *.sh)
    command -v shfmt >/dev/null 2>&1 && shfmt -w "$file" >/dev/null 2>&1 ;;
esac
exit 0
