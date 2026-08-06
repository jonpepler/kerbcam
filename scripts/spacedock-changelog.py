#!/usr/bin/env python3
"""Reduce a git-cliff changelog to what a player cares about.

SpaceDock listings are read by users, not contributors: Features and Bug Fixes
are the whole story, and CI/refactor/test churn is noise. Those still get a
one-line acknowledgement so the entry does not imply nothing else happened.

Reads the cliff changelog on stdin, writes the filtered version to stdout.
"""
import re, sys

KEEP = ("Features", "Bug Fixes")
text = sys.stdin.read()

groups, current = {}, None
for line in text.splitlines():
    m = re.match(r"^\*\*(.+?)\*\*\s*$", line.strip())
    if m:
        current = m.group(1).strip()
        groups.setdefault(current, [])
        continue
    if current and line.strip().startswith("-"):
        groups[current].append(line.rstrip())

out = []
for name in KEEP:
    entries = groups.get(name)
    if not entries:
        continue
    out.append(f"**{name}**")
    out.append("")
    out.extend(entries)
    out.append("")

others = [g for g in groups if g not in KEEP and groups[g]]
if others:
    out.append("Other changes: " + ", ".join(sorted(others)))
    out.append("")

sys.stdout.write("\n".join(out).rstrip() + "\n" if out else text)
