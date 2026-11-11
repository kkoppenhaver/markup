// markup-review mod: runs the bundled review server, watches .review/inbox, and hands notes to Claude.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { NoteFile, ServerInfo } from '../types'

const PLUGIN = 'markup-review'
const PANE = 'markup-review'
const TOOL_OPEN = `mcp__${PLUGIN}__review_open`
const TOOL_NOTES = `mcp__${PLUGIN}__review_notes`

const notes = atom({ plugin: 'markup-review', key: 'notes' } as const, [] as NoteFile[], { shape: 'notes-2' })
const server = atom({ plugin: 'markup-review', key: 'server' } as const, null as ServerInfo | null, { shape: 'server-1' })

type Eng = EngineInterface
type OpenOptions = { root?: string; proxy?: string; page?: string; lan?: boolean }

const inboxOf = (cwd: string) => `${cwd}/.review/inbox`
const isAbsolute = (p: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)

// ---------- inbox ----------
async function listNoteFiles($: Eng, inbox: string): Promise<string[]> {
  if (!(await $.fs.exists(inbox))) return []
  const entries = await $.fs.list(inbox)
  return entries.filter(e => e.kind === 'file' && e.name.endsWith('.md')).map(e => e.name).sort()
}

function field(text: string, name: string): string {
  const m = text.match(new RegExp(`^${name}: (.*)$`, 'm'))
  return m?.[1]?.trim() ?? ''
}

type Edit = { selector?: string; before?: string; after?: string; deleted?: boolean }
type Mark = { kind?: string; text?: string; anchor?: { selector?: string; text?: string } | null }
type Placed = { name?: string; place?: string; anchor?: { selector?: string; text?: string }; caption?: string }
type Slot = { anchor?: { selector?: string; text?: string }; text?: string }

const LABELS: Record<string, string> = { h1: 'title', h2: 'heading', h3: 'heading', h4: 'heading', p: 'paragraph', li: 'list item', figcaption: 'caption', a: 'link', blockquote: 'quote', button: 'button', td: 'cell', th: 'cell' }

function snip(text: string, words = 5): string {
  const w = (text ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  return w.length <= words ? w.join(' ') : `${w.slice(0, words).join(' ')}…`
}

function labelFor(selector: string): string {
  const tag = (selector.split('>').pop() ?? '').trim().replace(/[:#.[].*$/, '').toLowerCase()
  return LABELS[tag] ?? (tag || 'element')
}

// One or two sentences for the pane: what was retyped, then what was drawn. Deterministic, built from the json.
export function summarize(edits: Edit[], marks: Mark[], images: Placed[] = [], slots: Slot[] = []): string {
  const parts: string[] = []
  const retyped = edits.filter(e => !e.deleted && (e.after ?? '').trim())
  const cut = edits.filter(e => e.deleted || !(e.after ?? '').trim())
  if (retyped.length) {
    const shown = retyped.slice(0, 3).map(e => `${labelFor(e.selector ?? '')} "${snip(e.before ?? '')}" → "${snip(e.after ?? '')}"`)
    const more = retyped.length - shown.length
    parts.push(`Retyped ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`)
  }
  if (cut.length) {
    const shown = cut.slice(0, 2).map(e => `${labelFor(e.selector ?? '')} "${snip(e.before ?? '')}"`)
    const more = cut.length - shown.length
    parts.push(`Cut ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`)
  }
  if (marks.length) {
    const counts = new Map<string, number>()
    for (const m of marks) counts.set(m.kind ?? 'mark', (counts.get(m.kind ?? 'mark') ?? 0) + 1)
    const kinds = Array.from(counts, ([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`)
    const said = marks.map(m => (m.text ?? '').trim()).filter(Boolean).slice(0, 2).map(t => `"${snip(t, 8)}"`)
    const where = marks.map(m => m.anchor?.selector).filter((x): x is string => !!x).slice(0, 2).map(labelFor)
    const tail = said.length ? ` saying ${said.join(', ')}` : where.length ? ` on ${Array.from(new Set(where)).join(' and ')}` : ''
    parts.push(`Drew ${kinds.join(', ')}${tail}.`)
  }
  if (images.length) {
    const shown = images.slice(0, 2).map(im => {
      const what = im.place === 'image' ? 'over the image' : im.place === 'replace' ? 'on the placeholder' : `after the ${labelFor(im.anchor?.selector ?? '')}`
      return `${im.name ?? 'image'} ${what}${im.anchor?.text ? ` "${snip(im.anchor.text, 4)}"` : ''}`
    })
    const more = images.length - shown.length
    parts.push(`Placed ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`)
  }
  if (slots.length) {
    const where = slots.slice(0, 2).map(s => `after the ${labelFor(s.anchor?.selector ?? '')}${s.anchor?.text ? ` "${snip(s.anchor.text, 4)}"` : ''}`)
    const more = slots.length - where.length
    parts.push(`Added ${slots.length} empty screenshot ${slots.length === 1 ? 'slot' : 'slots'} ${where.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`)
  }
  return parts.join(' ')
}

async function readNote($: Eng, inbox: string, name: string): Promise<NoteFile> {
  const path = `${inbox}/${name}`
  const text = await $.fs.read(path)
  let edits = 0
  let marks = 0
  let images = 0
  let tldr = ''
  let summary = ''
  const jsonName = field(text, 'json')
  if (jsonName && (await $.fs.exists(`${inbox}/${jsonName}`))) {
    try {
      const data = JSON.parse(await $.fs.read(`${inbox}/${jsonName}`)) as { edits?: Edit[]; marks?: Mark[]; images?: Placed[]; slots?: Slot[]; tldr?: string }
      edits = (data.edits ?? []).length
      marks = (data.marks ?? []).length
      images = (data.images ?? []).length
      tldr = String(data.tldr ?? '').trim()
      summary = summarize(data.edits ?? [], data.marks ?? [], data.images ?? [], data.slots ?? [])
    } catch {
      // a half-written json file: counts stay at zero, the markdown still carries everything
    }
  }
  const pngName = field(text, 'marks_png').split(/\s+/)[0] ?? ''
  return {
    name,
    path,
    pngPath: pngName ? `${inbox}/${pngName}` : undefined,
    page: field(text, 'page'),
    sentAt: field(text, 'sent'),
    edits,
    marks,
    images,
    tldr,
    summary,
    status: 'new',
    text,
  }
}

async function readDelivered($: Eng, cwd: string): Promise<string[]> {
  const statePath = `${cwd}/.review/.delivered.json`
  try {
    if (await $.fs.exists(statePath)) return JSON.parse(await $.fs.read(statePath)) as string[]
  } catch {
    // unreadable state: treat as empty
  }
  return []
}

async function markDelivered($: Eng, cwd: string, names: string[]) {
  const statePath = `${cwd}/.review/.delivered.json`
  const delivered = await readDelivered($, cwd)
  const merged = Array.from(new Set([...delivered, ...names])).sort()
  try {
    await $.fs.write(statePath, JSON.stringify(merged))
  } catch {
    // the classic hook may re-deliver once; harmless
  }
}

function promptFor(arrived: NoteFile[]): string {
  const parts = arrived.map(n => {
    const lines = [`File: ${n.path}`]
    if (n.pngPath) lines.push(`Strokes image: ${n.pngPath} (view it with Read; the strokes carry meaning the text cannot)`)
    lines.push('', n.text.trim())
    return lines.join('\n')
  })
  const withImages = arrived.some(n => n.images > 0)
  return [
    `Review notes arrived from the markup-review page. The user sent them from the browser with Cmd+Enter. Apply them now, following the markup-review skill: read the TL;DR first, apply each copy edit to the source exactly as written (~~text~~ means delete that text), act on each mark using its anchor,${withImages ? ' place each image (move the file out of the inbox into the project\'s media folder, resize to the site\'s convention, and put a figure with the given caption and alt where the notes say),' : ''} reply with one line per note in the order given, and do not delete inbox files or clear the canvas.`,
    '',
    ...parts,
  ].join('\n')
}

// ---------- server ----------
// A running server for this project is reused unless the LAN was asked for and it only listens on loopback.
async function portFor($: Eng, cwd: string, target: string, needLan = false): Promise<{ port: number; reuse?: string; lan?: string }> {
  for (let port = 8791; port < 8811; port++) {
    try {
      const res = await $.http.fetch(`http://127.0.0.1:${port}/__review/ping`)
      if (res.ok) {
        try {
          const j = JSON.parse(res.text) as { inbox?: string; target?: string; lan?: string | null }
          if (j.inbox === inboxOf(cwd)) {
            // Only reuse a server that serves the same folder or dev server. One left over from an earlier
            // session with a different root answers every page with a 404 or a directory listing.
            const sameTarget = !j.target || j.target === target
            if (sameTarget && (!needLan || j.lan)) return { port, reuse: `http://127.0.0.1:${port}/__review/`, lan: j.lan ?? undefined }
            if (!sameTarget && (await quitServer($, port))) return { port }
          }
        } catch {
          // another service answered; try the next port
        }
      }
    } catch {
      return { port }
    }
  }
  return { port: 8791 + Math.floor(Math.random() * 1000) }
}

async function quitServer($: Eng, port: number): Promise<boolean> {
  try {
    await $.http.fetch(`http://127.0.0.1:${port}/__review/quit`, { method: 'POST' })
  } catch {
    return false
  }
  for (let i = 0; i < 20; i++) {
    await $.clock.sleep(100)
    try {
      await $.http.fetch(`http://127.0.0.1:${port}/__review/ping`)
    } catch {
      return true // the port is free
    }
  }
  return false
}

async function openBrowser($: Eng, url: string) {
  for (const argv of [['open', url], ['xdg-open', url], ['cmd', '/c', 'start', '', url]]) {
    try {
      const ran = await $.process.run(argv, { timeoutMs: 5000 })
      if (ran.exitCode === 0) return true
    } catch {
      // not this platform's opener
    }
  }
  return false
}

async function startServer($: Eng, cwd: string, opts: OpenOptions): Promise<ServerInfo> {
  const page = opts.page ?? '/'
  const target = opts.proxy ?? (opts.root ? (isAbsolute(opts.root) ? opts.root : `${cwd}/${opts.root}`) : cwd)
  const q = `?url=${encodeURIComponent(page)}`
  const current = await read($, server)
  if (current && current.cwd === cwd && current.target === target && (!opts.lan || current.lanUrl)) {
    try {
      const res = await $.http.fetch(`http://127.0.0.1:${current.port}/__review/ping`)
      if (res.ok) return { ...current, page, url: `http://127.0.0.1:${current.port}/__review/${q}`, lanUrl: current.lanUrl && current.lanUrl.replace(/\?.*$/, '') + q }
    } catch {
      // it died; start again
    }
  }
  const found = await portFor($, cwd, target, !!opts.lan)
  if (found.reuse) {
    const info: ServerInfo = { cwd, port: found.port, target, page, url: `${found.reuse}${q}`, lanUrl: found.lan ? `${found.lan}/__review/${q}` : undefined }
    await update($, server, () => info)
    return info
  }
  const port = found.port
  const argv = ['python3', `${$.plugin.root}/scripts/review_server.py`, '--port', String(port), '--inbox', inboxOf(cwd), '--path', page, '--quiet']
  if (opts.proxy) argv.push('--proxy', opts.proxy)
  else argv.push('--root', target)
  if (opts.lan) argv.push('--lan')
  const child = $.process.spawn({ argv, cwd })

  const info = await new Promise<ServerInfo>((resolve, reject) => {
    let buffer = ''
    let settled = false
    void (async () => {
      try {
        for await (const { text } of child) {
          buffer += text
          if (!settled) {
            const m = buffer.match(/review\s*:\s*(http\S+)/)
            // With --lan the server prints its lan (and tailscale) lines right after; wait one tick for them.
            if (m && (!opts.lan || /lan\s*:/.test(buffer) || /\n\s*$/.test(buffer.slice(m.index! + m[0].length)))) {
              settled = true
              const lan = buffer.match(/\blan\s*:\s*(http\S+)/)
              const ts = buffer.match(/tailscale\s*:\s*(http\S+)/)
              resolve({ cwd, port, target, page, url: m[1] ?? `http://127.0.0.1:${port}/__review/`, lanUrl: lan?.[1], tailscaleUrl: ts?.[1] })
            } else if (/Address already in use|Traceback|Errno/.test(buffer)) {
              settled = true
              reject(new Error(buffer.slice(-500)))
            }
          }
          if (buffer.length > 20000) buffer = buffer.slice(-4000)
        }
      } catch (err) {
        if (!settled) {
          settled = true
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      }
      // The child ended: forget it if it was ours.
      await update($, server, s => (s && s.port === port ? null : s))
      $.ui.status(undefined)
      if (!settled) {
        settled = true
        reject(new Error(`review server exited before it was ready: ${buffer.slice(-500)}`))
      }
    })()
  })
  await update($, server, () => info)
  return info
}

function handoffPrompt(lan: boolean): string {
  return [
    'The user ran /markup with no target. Open the markup review layer with the review_open tool (mcp__markup-review__review_open):',
    '- If this conversation just built, edited, previewed or discussed a specific page, open that page: set `root` to the folder that serves it (for a static site, the folder the page\'s URL paths are relative to, such as `site` or `dist`; never the project root when the pages live in a subfolder) or `proxy` to the dev server that is already running, and `page` to the page\'s path.',
    '- Otherwise do not guess. Use the AskUserQuestion tool to ask which folder or dev server to serve and which page to open, offering the likely candidates you can see in the project (a `site`, `dist`, `public` or `build` folder; a dev server from the project config), then call review_open with the answer.',
    lan ? '- The user passed --lan, so pass `lan: true` and hand over the LAN URL from the result.' : '',
    'Then tell the user in two lines how the layer works: draw with D, arrows A, sticky notes N; backtick switches to editing the copy; Ctrl+/ is the TL;DR box; Cmd+Enter sends.',
  ].filter(Boolean).join('\n')
}

function parseArgs(args: string): OpenOptions {
  const out: OpenOptions = {}
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? ''
    if (t === '--page' || t === '-p') out.page = tokens[++i]
    else if (t === '--lan') out.lan = true
    else if (/^https?:\/\//.test(t)) out.proxy = t.replace(/\/$/, '')
    else if (t.startsWith('/') && !t.includes('.') && !out.root && tokens.length === 1 && t.length > 1 && !t.startsWith('/Users') && !t.startsWith('/home')) out.page = t
    else out.root = t
  }
  return out
}

async function openReview($: Eng, cwd: string, opts: OpenOptions): Promise<{ url: string; opened: boolean; remote: string }> {
  const info = await startServer($, cwd, opts)
  const opened = await openBrowser($, info.url)
  $.ui.status(`review: ${info.url}`)
  void $.ui.open({ id: PANE, title: 'Review' })
  // What to hand someone on a phone or another machine. Plain http on purpose: tldraw treats https on a real hostname as production.
  const remote = opts.lan
    ? [info.lanUrl ? `On a phone or another machine on the same network: ${info.lanUrl}` : 'Could not work out the LAN address; check ifconfig.', info.tailscaleUrl ? `Over Tailscale: ${info.tailscaleUrl}` : ''].filter(Boolean).join(' ')
    : ''
  return { url: info.url, opened, remote }
}

// ---------- the mod ----------
type Watch = { seen: Set<string>; polling: boolean; applying: number }

async function poll($: Eng, cwd: string, watch: Watch) {
  if (watch.polling) return
  watch.polling = true
  try {
    const inbox = inboxOf(cwd)
    const unseen = (await listNoteFiles($, inbox)).filter(n => !watch.seen.has(n))
    if (unseen.length === 0) return
    // Several sessions can watch one project. The first to write a note's name into .delivered.json owns it;
    // the others list it in their pane as applied elsewhere and do not start a turn for it.
    const taken = new Set(await readDelivered($, cwd))
    const fresh = unseen.filter(n => !taken.has(n))
    const elsewhere = unseen.filter(n => taken.has(n))
    for (const name of elsewhere) watch.seen.add(name)
    if (elsewhere.length) {
      const seenElsewhere: NoteFile[] = []
      for (const name of elsewhere) seenElsewhere.push({ ...(await readNote($, inbox, name)), status: 'applied' as const })
      await update($, notes, list => [...seenElsewhere, ...list].slice(0, 50))
    }
    if (fresh.length === 0) return
    await markDelivered($, cwd, fresh)
    await $.clock.sleep(400) // let the server finish writing the json and png beside the markdown
    const arrived: NoteFile[] = []
    for (const name of fresh) {
      watch.seen.add(name)
      arrived.push({ ...(await readNote($, inbox, name)), status: 'applying' as const })
    }
    await update($, notes, list => [...arrived, ...list].slice(0, 50))
    const summary = arrived
      .map(a => `${a.edits} edit${a.edits === 1 ? '' : 's'}, ${a.marks} mark${a.marks === 1 ? '' : 's'}${a.images ? `, ${a.images} image${a.images === 1 ? '' : 's'}` : ''}${a.tldr ? `, "${a.tldr.slice(0, 70)}${a.tldr.length > 70 ? '…' : ''}"` : ''}`)
      .join('; ')
    $.ui.toast(`Review notes: ${summary}`)
    $.ui.status(`review: applying ${arrived.length} note file${arrived.length === 1 ? '' : 's'}`)
    void $.ui.open({ id: PANE, title: 'Review' })
    watch.applying += arrived.length
    void $.prompt.submit({ text: promptFor(arrived) })
  } finally {
    watch.polling = false
  }
}

export const register: Register = on => {
  const watch: Watch = { seen: new Set<string>(), polling: false, applying: 0 }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'markup',
      description: 'Open the markup review layer over a page. With no target, Claude opens the page you were just working on, or asks which one.',
      argumentHint: '[folder | http://localhost:3000] [--page /path] [--lan]',
    })
    await $.tool.register({
      name: 'review_open',
      description: 'Start the markup review server for the current project and open the review page in the browser. Pass root (a folder to serve) or proxy (a running dev server URL), and page (the path to open). Returns the review URL. Use when the user wants to mark up, scribble on, or give visual feedback on a page.',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: 'Folder to serve, relative to the project or absolute. Default: the project root.' },
          proxy: { type: 'string', description: 'A running dev server to wrap, such as http://localhost:3000. Overrides root.' },
          page: { type: 'string', description: 'Page path to open in the review layer. Default: /' },
          lan: { type: 'boolean', description: 'Also listen on the LAN so a phone or another machine on the same network, or over Tailscale, can open the review page. The result then includes that URL to pass on. Use when the user is on Remote Control, on a phone, or asks for a link for another device.' },
        },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'review_notes',
      description: 'List the review notes files in this project\'s .review/inbox with their TL;DR and counts, newest first. Use when the user says "read my notes" and you need the latest file paths.',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })

    // Files already in the inbox were handled by an earlier session; show them, do not re-announce them.
    const inbox = inboxOf(e.cwd)
    try {
      const existing = await listNoteFiles($, inbox)
      existing.forEach(n => watch.seen.add(n))
      const known = await read($, notes)
      if (known.length === 0 && existing.length > 0) {
        const old: NoteFile[] = []
        for (const name of existing.slice(-10).reverse()) old.push({ ...(await readNote($, inbox, name)), status: 'applied' as const })
        await update($, notes, () => old)
      }
    } catch {
      // no inbox yet
    }

    $.clock.every(1000, () => void poll($, e.cwd, watch))
    return next(e)
  })

  on('command.run', { command: 'markup' }, async ($, e) => {
    const cwd = await $.session.cwd()
    const opts = parseArgs(e.args)
    if (!opts.root && !opts.proxy && !opts.page) {
      // No target named. Serving the project root gives a directory listing, which is never what the user
      // wanted. Hand the choice to Claude, which knows what page the conversation was just about: `context`
      // is the note a command leaves the model, read as a hidden user message after the output row.
      return { text: 'No page named. Asking Claude to open the page you were just working on, or to ask you which one.', context: [handoffPrompt(!!opts.lan)] }
    }
    try {
      const { url, opened, remote } = await openReview($, cwd, opts)
      return {
        text: [
          `Review layer: ${url}${opened ? '' : ' (open it in your browser)'}${remote ? `\n${remote}` : ''}`,
          'Draw with D, arrows with A, sticky notes with N. Backtick switches to editing the copy. Ctrl+/ is the TL;DR box. Cmd+Enter sends the notes to Claude.',
        ].join('\n'),
      }
    } catch (err) {
      return { text: `Could not start the review server: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  on('tool.call', { tool: TOOL_OPEN }, async ($, e) => {
    const input = e as unknown as OpenOptions
    const cwd = await $.session.cwd()
    try {
      const { url, opened, remote } = await openReview($, cwd, { root: input.root, proxy: input.proxy, page: input.page, lan: input.lan })
      return { result: `Review layer: ${url}${opened ? ' (opened in the browser)' : ' (open it in the browser)'}.${remote ? ` ${remote}` : ''} Notes land in ${inboxOf(cwd)}. Tell the user: draw with D, arrows A, sticky notes N; backtick switches to editing copy; Ctrl+/ is the TL;DR box; Cmd+Enter sends.` }
    } catch (err) {
      return { deny: `markup-review: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  on('tool.call', { tool: TOOL_NOTES }, async $ => {
    const list = await read($, notes)
    const inbox = inboxOf(await $.session.cwd())
    if (list.length === 0) return { result: `No review notes yet. Inbox: ${inbox}` }
    const lines = list.map(n => `${n.sentAt} ${n.page} [${n.status}] ${n.edits} edits, ${n.marks} marks${n.images ? `, ${n.images} images` : ''}${n.tldr ? ` TL;DR: ${n.tldr}` : ''}${n.summary ? `\n  ${n.summary}` : ''}\n  file: ${n.path}${n.pngPath ? `\n  png: ${n.pngPath}` : ''}`)
    return { result: `Inbox: ${inbox}\n\n${lines.join('\n')}` }
  })

  on('turn.complete', async ($, e, next) => {
    if (watch.applying > 0 && e.agentId === undefined) {
      watch.applying = 0
      await update($, notes, list => list.map(n => (n.status === 'applying' ? { ...n, status: 'applied' as const } : n)))
      const srv = await read($, server)
      $.ui.status(srv ? `review: ${srv.url}` : undefined)
      $.ui.toast('Review notes applied. Check the page, then mark up the next round.')
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const srv = await read($, server)
    const list = await read($, notes)
    const room = Math.max(1, Math.floor(((e.props.placement === 'dock' ? e.props.scroll.bodyRows : 30) - 5) / 6))

    return (
      <Box flexDirection="column">
        {srv ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text weight="semibold">Server on port {srv.port}</Text>
            <Text dimColor wrap="truncate">{srv.target}</Text>
            <Link href={srv.url} label="Review page" />
            {srv.lanUrl && <Link href={srv.lanUrl} label="On the LAN (phone)" />}
            {srv.tailscaleUrl && <Link href={srv.tailscaleUrl} label="Over Tailscale" />}
            <Button key="open" label="Open in browser" onPress={() => void openBrowser($, srv.url)} />
          </Box>
        ) : (
          <Box flexDirection="column" marginBottom={1}>
            <Text dimColor>No review server running.</Text>
            <Text dimColor>Run /markup to start one.</Text>
          </Box>
        )}
        {list.length === 0 && <Text dimColor>No notes yet. Mark up the page and press Cmd+Enter.</Text>}
        {list.slice(0, room).map(n => (
          <Box flexDirection="column" marginBottom={1}>
            <Text weight="semibold" wrap="truncate">
              {n.sentAt.slice(11, 16) || '--:--'} {n.page}
            </Text>
            <Text dimColor>
              {n.edits} edits, {n.marks} marks{n.images ? `, ${n.images} images` : ''}, {n.status}
            </Text>
            {n.tldr ? <Text italic wrap="truncate">{n.tldr}</Text> : null}
            {n.summary ? <Text dimColor wrap="wrap">{n.summary}</Text> : null}
          </Box>
        ))}
      </Box>
    )
  })
}
