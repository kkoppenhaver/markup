# Markup

This exact thing has happened to me so many times: I'd ask Claude Code for a landing page or a blog post, it would hand me back an entire page that I would have copy and design feedback on, and even using voice mode I found it hard to describe exactly the changes I wanted. What I really wanted was to mark up the page the way I'd mark up a printout and hand it back.

This plugin puts a [tldraw](https://tldraw.dev) canvas over any local page so you can draw arrows, scribble notes, and retype the copy right where it sits, then, with one keystroke, you can hand all that feedback back to Claude.

![The review layer over a blog post: a red arrow at a heading, a sentence struck through in the copy, a caption circled with a sticky note saying "drop this line?" beside it, an empty screenshot slot with its × control, and the TL;DR box, with the image and TL;DR buttons beside the drawing toolbar and Send to Claude in the top bar](docs/review-page.png)

## Get it running in Claude Code

```
/plugin marketplace add kkoppenhaver/markup
/plugin install markup-review@markup
```

Or from a local checkout:

```
claude --plugin-dir /path/to/markup
```

The plugin includes a mod (a hooks module that runs inside Claude Code), which needs **Claude Code 2.1.290 or later**. The server needs **Python 3.8 or later**. There are no other dependencies, since tldraw loads from a CDN.

## Open any page for review with one command

Run `/markup` in Claude Code and it starts the bundled server, opens the review page in your browser, and adds a Review pane beside the chat. With no target, Claude opens the page the conversation was just about, or asks you which folder and page if none is in play, so you never land on a directory listing.

```
/markup                               open the page you were just working on (or Claude asks which)
/markup dist                          serve a built folder
/markup http://localhost:3000         proxy a running dev server
/markup --page /pricing               open a specific page
/markup --lan                         also get a link for your phone
```

Claude also gets two tools, `review_open` and `review_notes`, so saying "let me mark this up" works too.

The page under review stays current: edit a file, or let Claude apply a round, and the frame reloads on its own. More on that, and on reviewing from your phone, below.

## Mark it up like a printout

What you can do on the page, in one list:

- **Draw** on it: pen, arrows, circles, rectangles, sticky notes, text. Each mark arrives with the element it points at.
- **Retype the copy** in place, and strike words out with Cmd+Shift+X. Claude gets before and after, keyed to the element.
- **Delete** a heading or paragraph outright. It arrives as a deletion and Claude removes it from the underlying file.
- **Drop or paste screenshots** where they belong. They show up as figures with an editable caption, so you see the text flow around them.
- **Fill, remove or add screenshot slots.** `[Screenshot: ...]` lines are drop zones, each with a × to remove it, and the image button beside the drawing toolbar (**+ Image**, or I) adds a new slot wherever you click.
- **Comment on a passage.** Select text in Edit copy and press Comment, and the passage is highlighted with your comment attached, Google Docs style.
- **Write a note**, the one note that is about the whole page rather than a spot on it. Claude reads it first.
- **Send with Cmd+Enter.** Everything lands as a prompt in Claude Code, and the Review pane beside the chat lists each round with a one-line summary of what changed.
- **Keep going across reloads.** Marks, edits, slots and screenshots persist per page, the frame reloads itself when the source changes, and edits Claude has already applied are dropped rather than painted onto the wrong line.

The review page has three modes:

- **Draw** (Ctrl+1) gives you the tldraw tools: D pen, A arrow, N sticky note, T text, R rectangle, E eraser, and V select.
- **Edit copy** (Ctrl+2, or the backtick key) lets you click into any text and retype it. Cmd+Shift+X strikes words out. Select a passage and a **Comment** button appears beside it; your comment goes to Claude with the quoted passage, and the highlight stays on the page until you send.
- **Browse** (Ctrl+3) makes the page behave normally again.

When you need to add, remove or edit screenshots, your page is ready for that. Drag an image file onto the spot where it belongs, or paste one with Cmd+V, and it appears there as a figure with a caption you can edit, so you see how the text flows around it. Any `[Screenshot: ...]` placeholder line on the page shows up as a dashed drop zone that lights up while you drag; drop there to replace the line, or drop on an existing image to replace that image. Each zone has a × to remove it. **+ Image** then a click adds a new slot wherever you point, and opens the file picker; cancel it and the empty slot stays for later.

For the big-picture verdict, Ctrl+/ opens the **Note** box in the bottom corner. It's the place for "too much copy above the fold" or "this section is done, cut the struck sentence": a note about the page, not a spot on it. It goes at the top of what Claude receives, and the skill tells Claude to read it before touching anything. The note and the comments clear once they are sent, so the next round starts blank; edits and marks stay until the source catches up with them.

## Send it with Cmd+Enter

When you're done, press **Cmd+Enter**. The notes land in `.review/inbox/` in your project as a markdown file, a JSON file, a PNG of the strokes, and one file per screenshot you placed.

The mod sees the file within a second, shows a toast, and starts a Claude turn with the notes, so pressing Cmd+Enter in the browser is the same as typing a message. The Review pane lists each round and marks it applied when the turn ends.

If the mod isn't loaded, a prompt hook carries any unread notes along with your next message instead.

## Your page always stays current

**Hot reload.** When the server is serving a folder, it watches the folder and reloads the frame as soon as a file changes, which is how you watch Claude's edits land after you send a round. When it's proxying a dev server, the dev server's own hot reload passes straight through. Either way your marks, retyped text and placed screenshots are still there after the reload, and any edit Claude has already applied is dropped rather than painted onto the wrong line.

**From your phone or another machine.** Run `/markup --lan` (or ask Claude for a link for your phone) and the server also listens on your local network. Claude hands you a second URL, something like `http://192.168.0.12:8791/__review/...`, and a Tailscale one if you have Tailscale installed. Open it on the phone and you're reviewing the same page, which pairs well with Claude Code's Remote Control: the session and the server stay on your Mac, you drive both from the couch. It's plain http on purpose. Touch works on the canvas, but a phone is better for retyping copy and writing the TL;DR than for drawing.

Without `--lan` the server binds to 127.0.0.1 and nothing leaves your computer.

## Notes Claude can act on

Claude gets your note, each comment with the passage it quotes, each copy edit as a CSS selector with the before and after text (`~~text~~` means delete, and an element you removed outright is listed as deleted), and each mark (arrow, scribble, note, or text) with the element it points at. A pen tap a few pixels wide is reported as a dot, so Claude knows to treat it as a stray. Here's what a round looks like:

```
page: /pricing
## Note
Too much copy above the fold. Cut the second paragraph.
## Comments (1)
1. on `section#hero > p:nth-of-type(1)` ("ship faster"): is this still our line, or did marketing retire it?
## Copy edits (1)
- `section#hero > p:nth-of-type(2)`
  - before: We help teams ship faster with less friction.
  - after: ~~We help teams ship faster with less friction.~~
- `section#hero > h2:nth-of-type(2)`
  - before: Trusted by teams everywhere
  - deleted: the whole element is gone from the page
## Marks on the page (2, top to bottom)
1. arrow on `h1` ("Pricing that scales")
2. note: "make this the headline" on `h2:nth-of-type(1)` ("Simple, honest plans")
## New screenshot slots (1)
1. after `main > p:nth-of-type(9)` ("The build takes about thirty seconds…"): [Screenshot: the terminal during a build. Caption: One track, thirty seconds.]
## Images (1)
1. `kit.png` (2880×1640, 2x screen) replacing the placeholder `main > p:nth-of-type(6)` ("[Screenshot: the album kit…")
   - file: /project/.review/inbox/20261106-013000-pricing-img-1.png
   - caption: The Midway kit. Twenty-one titles, each with its own prompt.
```

It also reads the PNG, since the strokes show things the text can't (like what you circled).

## Find your way around the code

```
markup/
├── .claude-plugin/plugin.json      manifest
├── .claude-plugin/marketplace.json  so this repo installs as a marketplace
├── hooks/hooks.json                names the mod module, plus the fallback prompt hook
├── hooks/register.tsx              the mod: /markup, review_open and review_notes tools, inbox watcher, Review pane
├── types/index.d.ts                the mod's state contract
├── skills/markup-review/SKILL.md   how Claude applies notes
├── scripts/review_server.py        static server or dev-server proxy, plus the inbox endpoint
├── scripts/inject_notes.py         fallback hook for sessions without mods
├── scripts/watch_inbox.py          fallback watcher for sessions without mods
└── assets/review.html, review.js   the tldraw layer
```

The mod is what makes it feel seamless. It owns the server process for the session, polls the inbox, and submits arriving notes as a prompt. The skill and scripts work without it.

## Rough edges I know about

- tldraw shows a small "get a license" badge in local use, and a tldraw license removes it. We're working with the tldraw folks on the best way to handle this!

- Copy edits map to a CSS selector. Turning that into the right component in your codebase is Claude's job, and it uses the selector plus the surrounding text to get there.

- It's built for mouse and trackpad. Touch works, but we're still improving it!

## Give it a try

Install it, run `/markup` on whatever Claude built for you last, and scribble on it. I'd love to hear what you'd want next, so open an issue on our repo at `https://github.com/kkoppenhaver/markup` and tell me about it.
