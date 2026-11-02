#!/usr/bin/env python3
"""Monitor: watch .review/inbox and print one line per new notes file. Never exits on its own.
Runs in the session working directory, or pass a project directory as the first argument."""
import json
import os
import sys
import time

project = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
inbox = os.path.join(project, ".review", "inbox")
seen = set(os.listdir(inbox)) if os.path.isdir(inbox) else set()

while True:
    try:
        if os.path.isdir(inbox):
            for name in sorted(os.listdir(inbox)):
                if name in seen or not name.endswith(".md"):
                    continue
                seen.add(name)
                path = os.path.join(inbox, name)
                time.sleep(0.3)  # let the server finish writing the json/png siblings
                summary = ""
                try:
                    data = json.load(open(path[:-3] + ".json"))
                    tldr = (data.get("tldr") or "").strip().replace("\n", " ")
                    summary = " | %d edits, %d marks" % (len(data.get("edits") or []), len(data.get("marks") or []))
                    if tldr:
                        summary += ' | TL;DR: "%s"' % (tldr[:160] + ("..." if len(tldr) > 160 else ""))
                except Exception:
                    pass
                print("REVIEW NOTES ARRIVED: %s%s. Read the file (and its .png), apply the notes, reply per note." % (path, summary), flush=True)
    except Exception as e:  # keep watching through transient errors
        print("watch_inbox error: %s" % e, file=sys.stderr, flush=True)
    time.sleep(0.7)
