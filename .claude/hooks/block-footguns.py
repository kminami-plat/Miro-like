#!/usr/bin/env python3
"""PreToolUse hook: block destructive Bash commands before they run.

Scans the whole command string, so it catches footguns hidden inside
compound commands (`cd x && git push --force`) that prefix-based deny
rules miss. Exit 2 blocks the call; stderr is shown to Claude.

Add your own entries to RULES from your own incident history.
"""

import json
import re
import sys

RULES = [
    # Filesystem
    (
        r"\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*"
        r"(/|/\*|~|~/|~/\*|\$HOME|\$HOME/|\.\.|\.\./?\*?|\*)(\s|$|;|&|\|)",
        "recursive delete of /, home, parent dir, or a bare wildcard",
    ),
    (
        r"\bchmod\s+(-[a-zA-Z]+\s+)*-R\s+0?777\b|\bchmod\s+0?777\s+(-R\s+)?/",
        "world-writable permissions applied recursively or to system paths",
    ),
    (r"\bdd\b[^;&|]*\bof=/dev/", "raw write to a device"),
    (r"\bmkfs(\.\w+)?\b", "formatting a filesystem"),
    (r">\s*/dev/(sd|disk|nvme)", "redirecting output onto a disk device"),
    # Git: discarding work or rewriting shared history
    (
        r"\bgit\s+push\b[^;&|]*\s(--force(?!-with-lease)|-f)\b",
        "force push (use --force-with-lease if you really must, and ask first)",
    ),
    (r"\bgit\s+reset\s+[^;&|]*--hard\b", "git reset --hard discards uncommitted work"),
    (r"\bgit\s+clean\s+[^;&|]*-[a-zA-Z]*f", "git clean -f deletes untracked files"),
    (
        r"\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$|;|&)",
        "discarding all working-tree changes",
    ),
    (
        r"\bgit\s+(commit|push)\b[^;&|]*--no-verify\b",
        "--no-verify skips the repo's hooks; fix the failing check instead",
    ),
    (r"\bgit\s+stash\s+(clear|drop)\b", "permanently deleting stashed work"),
    (r"\bgit\s+branch\s+[^;&|]*-D\b", "force-deleting a branch that may be unmerged"),
    # Privilege and remote code
    (r"(^|[;&|(]|\$\(|`)\s*sudo\s", "privilege escalation"),
    (
        r"\b(curl|wget)\b[^;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b",
        "piping a download straight into a shell",
    ),
    # Databases
    (r"\bDROP\s+(TABLE|DATABASE|SCHEMA)\b", "destructive SQL"),
    (r"\bTRUNCATE\s+(TABLE\s+)?\w", "destructive SQL"),
]

COMPILED = [
    (re.compile(p, re.IGNORECASE if "DROP" in p or "TRUNCATE" in p else 0), why)
    for p, why in RULES
]


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        return 0

    if payload.get("tool_name") != "Bash":
        return 0
    command = payload.get("tool_input", {}).get("command", "")

    for pattern, why in COMPILED:
        if pattern.search(command):
            print(
                f"BLOCKED by .claude/hooks/block-footguns.py: {why}.\n"
                f"Command: {command}\n"
                "Do not retry or rephrase this command to get around the block. "
                "Explain to the user what you were trying to achieve. If it is "
                "truly needed, the user can run it themselves with the ! prefix.",
                file=sys.stderr,
            )
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
