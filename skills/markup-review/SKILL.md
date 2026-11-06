---
name: markup-review
description: Let the user review a web page by drawing on it and retyping its copy, then act on the notes. Use when the user says "read my notes", "let me mark this up", "open review mode", "review layer", "markup review", or wants to give feedback on a page Claude built by scribbling instead of describing. Also use when review notes arrive from the markup-review page.
---

# Markup review

The user marks up a live page the way they would mark up a printout: arrows, circles, sticky notes, retyped sentences, strike-throughs, and one TL;DR. They press Cmd+Enter in the browser and the notes arrive here as a prompt from the markup-review mod, with the file paths. Your job is to open the layer when asked, then apply what comes back.

## Open the review layer

Call the `review_open` tool (listed as `mcp__markup-review__review_open`). The user can also run `/markup`.

- For static files, pass `root`: the project root by default, or a built folder such as `dist`.
- For a running dev server (Vite, Next, Astro, Rails), pass `proxy`, such as `http://localhost:3000`. Find the port from the running process or the project config. The proxy strips frame-blocking headers so the page loads inside the review frame. Hot reload over websockets does not pass through; the page still works.
- Pass `page` for a specific path, including a query string, such as `/pricing` or `/?theme=notebook`.

The tool starts the bundled Python server from the project directory (notes land in `.review/inbox/` there), reuses a server that is already running for this project, opens the URL in the browser, and shows a Review pane. Add `.review/` to `.gitignore` if the project is a git repo and the line is missing.

Tell the user in two lines how it works: draw with the tldraw tools, backtick switches to editing the copy, Ctrl+/ is the TL;DR box, Cmd+Enter sends.

If the mod is not loaded (no `review_open` tool), fall back to running the server by hand from the project root and watching the inbox with the Monitor tool:

```
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/markup_server.py" --root . --port 8791 --path /
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/watch_inbox.py"
```

## When notes arrive

The prompt carries the notes file path, the strokes image path, and the file's text, which looks like:

```
page: /?theme=notebook
sent: 2026-11-02T01:14:09
json: 20261102-011409-index.json
marks_png: 20261102-011409-index.png

# Review notes for /?theme=notebook
## TL;DR
## Copy edits (n)
- `selector`
  - before: ...
  - after: ...
## Marks on the page (n, top to bottom)
1. arrow on `h1 > em` ("can.")
2. note: "..." near `...`
3. scribble on `...`
```

Do this, in order:

1. View the `.png` with Read. It holds the strokes themselves, which carry meaning the text cannot (what was circled, how hard it was crossed out). If the Chrome extension is connected, also screenshot the review tab for the page underneath.
2. The TL;DR is the verdict. Let it set the direction before touching anything.
3. Apply each copy edit to the source, not to the served HTML. `~~text~~` in an "after" means delete that text. Keep the user's words exactly; do not improve them.
4. Act on each mark. An arrow or circle with no text means "look here"; use the anchor's selector and the screenshot to work out what is wrong, and if it is not clear, ask about that one mark rather than guessing. A sticky note or text shape is an instruction.
5. Place each image. A `## Images` section lists screenshots the user dropped or pasted onto the page, one file each in the inbox, with where it went (replacing a `[Screenshot: ...]` placeholder, replacing an existing image, or after an element), the caption they typed, and alt text. The inbox is not the destination: move the file into the project's media folder with a name taken from the page and anchor, resize it to the site's convention (a 2x-screen capture is twice the size it should display at), and put a figure with that caption and alt where the notes say, removing the placeholder. Match the figure markup the site already uses.
6. Reply with one line per note saying what changed, in the same order as the file. Mention anything you skipped and why.
7. Leave the inbox alone. Do not delete notes files and never clear the user's canvas; they clear it when a round is done.

If the user says "read my notes" and no prompt has arrived, call `review_notes` for the latest files, or check the review tab through the Chrome extension: `window.__review.get()` returns the same data live. If neither helps, ask them to press Cmd+Enter in the review tab.

## Screenshots

In any mode, dragging an image file onto the page, or pasting one with Cmd+V, puts it into the page as a figure at that spot. Dropped on a `[Screenshot: ...]` placeholder line, it replaces the line and takes the caption from it. Dropped on an existing image, it replaces that image. Anywhere else, it goes after the paragraph under the pointer. The caption is a text under the image; the user edits it in edit-copy mode. A paste with no position goes to the first placeholder on screen, or to the cursor in edit mode.

## Shortcuts the user has

- Ctrl+1 / Ctrl+2 / Ctrl+3: Draw, Edit copy, Browse. Backtick flips between Draw and Edit.
- In Draw: D pen, A arrow, N sticky note, T text, R rectangle, E eraser, V select, Cmd+Z undo. The wheel scrolls the page.
- In Edit copy: click into text and retype. Cmd+Shift+X strikes the selection through.
- Ctrl+/: TL;DR box. Cmd+Enter: send to Claude. Clear all needs two clicks.

Marks and edits persist per page in the browser, so a half-finished review survives a reload. A saved edit is re-applied only while the page still shows the text it was made against; once the source changes (the edit was applied, or elements were added), the stale edit is dropped on reload and the page toasts how many went.
