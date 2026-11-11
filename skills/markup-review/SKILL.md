---
name: markup-review
description: Let the user review a web page by drawing on it and retyping its copy, then act on the notes. Use when the user says "read my notes", "let me mark this up", "open review mode", "review layer", "markup review", or wants to give feedback on a page Claude built by scribbling instead of describing. Also use when review notes arrive from the markup-review page.
---

# Markup review

The user marks up a live page the way they would mark up a printout: arrows, circles, sticky notes, retyped sentences, strike-throughs, comments pinned to selected passages, and one note about the whole page. They press Cmd+Enter in the browser and the notes arrive here as a prompt from the markup-review mod, with the file paths. Your job is to open the layer when asked, then apply what comes back.

## Open the review layer

Call the `review_open` tool (listed as `mcp__markup-review__review_open`). The user can also run `/markup`; with no target that command hands the choice to you with the same rules as below.

**Which page.** Never open the project root when you can name the page. If this conversation just built, edited, previewed or discussed a page, open that one: `root` is the folder its URL paths are relative to (`site`, `dist`, `public`, a docs folder), or `proxy` is the dev server already running, and `page` is its path. If no page is in play, do not guess: use the AskUserQuestion tool to ask which folder or dev server to serve and which page to open, offering the candidates you can see in the project, then call `review_open` with the answer. A directory listing in the review frame means this step was skipped.

- For static files, pass `root`: the folder that serves the pages, such as `site` or `dist`. The project root only when the HTML lives there.
- When the user is on a phone, on Remote Control, or wants a link for another device, pass `lan: true`. The server then listens on every interface and the result includes a LAN URL (and a Tailscale one when that CLI is installed) to hand over. It is plain http on purpose: tldraw treats https on a real hostname as production and stops without a license key, so do not put the page behind an https tunnel.
- For a running dev server (Vite, Next, Astro, Rails), pass `proxy`, such as `http://localhost:3000`. Find the port from the running process or the project config. The proxy strips frame-blocking headers so the page loads inside the review frame, and passes the dev server's hot-reload websocket through. For a static root, the server watches the folder and the review page reloads the frame when a file changes, so applied notes show up on their own.
- Pass `page` for a specific path, including a query string, such as `/pricing` or `/?theme=notebook`.

The tool starts the bundled Python server from the project directory (notes land in `.review/inbox/` there), reuses a server that is already running for this project, opens the URL in the browser, and shows a Review pane. Add `.review/` to `.gitignore` if the project is a git repo and the line is missing.

Tell the user in two lines how it works: draw with the tldraw tools, backtick switches to editing the copy (select text there and press Comment to pin a comment to it), Ctrl+/ is the note box, Cmd+Enter sends.

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
## Note
## Comments (n)
1. on `selector` ("the passage selected"): the comment
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
2. The note is the verdict. Let it set the direction before touching anything. Then take each comment: it quotes the passage it is about and names the element. A comment can be an instruction ("tighten this"), a question ("is this still true?") or a reaction. Act on instructions in the source, answer questions in your reply, and say in one line what you did with each. Comments and the note clear from the page once sent, so do not expect to see them again next round.
3. Apply each copy edit to the source, not to the served HTML. `~~text~~` in an "after" means delete that text. `¶` in an "after" means the user pressed Enter there: split the paragraph at that point. An edit with `deleted:` instead of `after:` means the user removed that whole element (a heading, a paragraph, a list item): take it out of the source. Keep the user's words exactly; do not improve them.
4. Act on each mark. A `dot` is a pen tap a few pixels wide with no text, almost always accidental: skip it and say so. An arrow or circle with no text means "look here"; use the anchor's selector and the screenshot to work out what is wrong, and if it is not clear, ask about that one mark rather than guessing. A sticky note or text shape is an instruction.
5. Place each image. A `## Images` section lists screenshots the user dropped or pasted onto the page, one file each in the inbox, with where it went (replacing a `[Screenshot: ...]` placeholder, replacing an existing image, or after an element), the caption they typed, and alt text. The inbox is not the destination: move the file into the project's media folder with a name taken from the page and anchor, resize it to the site's convention (a 2x-screen capture is twice the size it should display at), and put a figure with that caption and alt where the notes say, removing the placeholder. Match the figure markup the site already uses.
6. Add each new slot. A `## New screenshot slots` section lists placeholder lines the user added with **+ Image** and left empty, each by the element it follows and the text they typed. Insert that line into the source after the anchor, in the style the page already uses for placeholders (a bold bracketed line, or a figure stub), so the next round can drop a screenshot on it.
7. Reply with one line per note saying what changed, in the same order as the file. Mention anything you skipped and why.
8. Leave the inbox alone. Do not delete notes files and never clear the user's canvas; they clear it when a round is done.

If the user says "read my notes" and no prompt has arrived, call `review_notes` for the latest files, or check the review tab through the Chrome extension: `window.__review.get()` returns the same data live. If neither helps, ask them to press Cmd+Enter in the review tab.

## Screenshots

In any mode, dragging an image file onto the page, or pasting one with Cmd+V, puts it into the page as a figure at that spot. Dropped on a `[Screenshot: ...]` placeholder line, it replaces the line and takes the caption from it. Dropped on an existing image, it replaces that image. Anywhere else, it goes after the paragraph under the pointer. The caption is a text under the image; the user edits it in edit-copy mode. A paste with no position goes to the first placeholder on screen, or to the cursor in edit mode.

Every placeholder shows a × in its corner. Clicking it on a placeholder from the source deletes that element (it arrives as a deleted copy edit); on a slot the user added it just removes the slot. **+ Image** (the image button in the pill beside the drawing toolbar, or I), then a click on the page, adds an empty slot after the block under the pointer and opens the file picker; cancelling the picker leaves the slot for later. An image dropped on an added slot arrives as a figure "after" the slot's anchor, since the slot itself is not in the source.

## Shortcuts the user has

- Ctrl+1 / Ctrl+2 / Ctrl+3: Draw, Edit copy, Browse. Backtick flips between Draw and Edit.
- In Draw: D pen, A arrow, N sticky note, T text, R rectangle, E eraser, V select, Cmd+Z undo. The wheel scrolls the page. I starts placing an image (same as the + Image button beside the toolbar).
- In Edit copy: click into text and retype. Cmd+Shift+X strikes the selection through.
- In Edit copy: select text and press the Comment button that appears (or Cmd+Option+M) to pin a comment to that passage. Click a highlighted passage to edit or remove its comment.
- Ctrl+/: note box for the whole page (also the last button beside the toolbar). Cmd+Enter: send to Claude. Clear all needs two clicks.

Marks and edits persist per page in the browser, so a half-finished review survives a reload. A saved edit is re-applied only while the page still shows the text it was made against; once the source changes (the edit was applied, or elements were added), the stale edit is dropped on reload and the page toasts how many went.
