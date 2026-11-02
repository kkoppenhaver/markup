#!/usr/bin/env python3
"""UserPromptSubmit hook: if review notes are waiting in .review/inbox, add them to Claude's context.
Prints nothing when there is nothing new. Tracks what it has shown in .review/.delivered.json."""
import json
import os
import sys

project = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
inbox = os.path.join(project, ".review", "inbox")
state_path = os.path.join(project, ".review", ".delivered.json")
if not os.path.isdir(inbox):
    sys.exit(0)

try:
    delivered = set(json.load(open(state_path)))
except Exception:
    delivered = set()

new = sorted(f for f in os.listdir(inbox) if f.endswith(".md") and f not in delivered)
if not new:
    sys.exit(0)

out = ["Review notes are waiting in %s (%d new). Follow the markup-review skill: read each file, look at the matching .png with Read, apply the copy edits and act on the marks, then reply per note. Do not delete or clear anything." % (inbox, len(new)), ""]
budget = 8000
for name in new:
    path = os.path.join(inbox, name)
    try:
        text = open(path).read()
    except OSError:
        continue
    chunk = "----- %s -----\n%s" % (path, text.strip())
    if len(chunk) > budget:
        chunk = chunk[:budget] + "\n[truncated: read the file for the rest]"
    out.append(chunk)
    budget -= len(chunk)
    if budget <= 0:
        out.append("[more files not shown: list %s]" % inbox)
        break

delivered.update(new)
try:
    os.makedirs(os.path.dirname(state_path), exist_ok=True)
    json.dump(sorted(delivered), open(state_path, "w"))
except OSError:
    pass

print("\n".join(out))
