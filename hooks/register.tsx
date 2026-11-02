// markup-review mod: runs the bundled review server, watches .review/inbox, and hands notes to Claude.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { NoteFile, ServerInfo } from '../types'

const PLUGIN = 'markup-review'
const PANE = 'markup-review'
const TOOL_OPEN = `mcp__${PLUGIN}__review_open`
const TOOL_NOTES = `mcp__${PLUGIN}__review_notes`

const notes = atom({ plugin: 'markup-review', key: 'notes' } as const, [] as NoteFile[], { shape: 'notes-1' })
const server = atom({ plugin: 'markup-review', key: 'server' } as const, null as ServerInfo | null, { shape: 'server-1' })

type Eng = EngineInterface
type OpenOptions = { root?: string; proxy?: string; page?: string }

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

async function readNote($: Eng, inbox: string, name: string): Promise<NoteFile> {
  const path = `${inbox}/${name}`
  const text = await $.fs.read(path)
  let edits = 0
  let marks = 0
  let tldr = ''
  const jsonName = field(text, 'json')
  if (jsonName && (await $.fs.exists(`${inbox}/${jsonName}`))) {
    try {
      const data = JSON.parse(await $.fs.read(`${inbox}/${jsonName}`)) as { edits?: unknown[]; marks?: unknown[]; tldr?: string }
      edits = (data.edits ?? []).length
      marks = (data.marks ?? []).length
      tldr = String(data.tldr ?? '').trim()
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
    tldr,
    status: 'new',
    text,
  }
}

async function markDelivered($: Eng, cwd: string, names: string[]) {
  const statePath = `${cwd}/.review/.delivered.json`
  let delivered: string[] = []
  try {
    if (await $.fs.exists(statePath)) delivered = JSON.parse(await $.fs.read(statePath)) as string[]
  } catch {
    delivered = []
  }
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
  return [
    `Review notes arrived from the markup-review page. The user sent them from the browser with Cmd+Enter. Apply them now, following the markup-review skill: read the TL;DR first, apply each copy edit to the source exactly as written (~~text~~ means delete that text), act on each mark using its anchor, reply with one line per note in the order given, and do not delete inbox files or clear the canvas.`,
    '',
    ...parts,
  ].join('\n')
}

// ---------- server ----------
async function portFor($: Eng, cwd: string): Promise<{ port: number; reuse?: string }> {
  for (let port = 8791; port < 8811; port++) {
    try {
      const res = await $.http.fetch(`http://127.0.0.1:${port}/__review/ping`)
      if (res.ok) {
        try {
          const j = JSON.parse(res.text) as { inbox?: string }
          if (j.inbox === inboxOf(cwd)) return { port, reuse: `http://127.0.0.1:${port}/__review/` }
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
  const current = await read($, server)
  if (current && current.cwd === cwd && current.target === target) {
    try {
      const res = await $.http.fetch(`http://127.0.0.1:${current.port}/__review/ping`)
      if (res.ok) return { ...current, page, url: `http://127.0.0.1:${current.port}/__review/?url=${encodeURIComponent(page)}` }
    } catch {
      // it died; start again
    }
  }
  const found = await portFor($, cwd)
  if (found.reuse) {
    const info: ServerInfo = { cwd, port: found.port, target, page, url: `${found.reuse}?url=${encodeURIComponent(page)}` }
    await update($, server, () => info)
    return info
  }
  const port = found.port
  const argv = ['python3', `${$.plugin.root}/scripts/review_server.py`, '--port', String(port), '--inbox', inboxOf(cwd), '--path', page, '--quiet']
  if (opts.proxy) argv.push('--proxy', opts.proxy)
  else argv.push('--root', target)
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
            if (m) {
              settled = true
              resolve({ cwd, port, target, page, url: m[1] ?? `http://127.0.0.1:${port}/__review/` })
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

function parseArgs(args: string): OpenOptions {
  const out: OpenOptions = {}
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? ''
    if (t === '--page' || t === '-p') out.page = tokens[++i]
    else if (/^https?:\/\//.test(t)) out.proxy = t.replace(/\/$/, '')
    else if (t.startsWith('/') && !t.includes('.') && !out.root && tokens.length === 1 && t.length > 1 && !t.startsWith('/Users') && !t.startsWith('/home')) out.page = t
    else out.root = t
  }
  return out
}

async function openReview($: Eng, cwd: string, opts: OpenOptions): Promise<{ url: string; opened: boolean }> {
  const info = await startServer($, cwd, opts)
  const opened = await openBrowser($, info.url)
  $.ui.status(`review: ${info.url}`)
  void $.ui.open({ id: PANE, title: 'Review' })
  return { url: info.url, opened }
}

// ---------- the mod ----------
type Watch = { seen: Set<string>; polling: boolean; applying: number }

async function poll($: Eng, cwd: string, watch: Watch) {
  if (watch.polling) return
  watch.polling = true
  try {
    const inbox = inboxOf(cwd)
    const fresh = (await listNoteFiles($, inbox)).filter(n => !watch.seen.has(n))
    if (fresh.length === 0) return
    await $.clock.sleep(400) // let the server finish writing the json and png beside the markdown
    const arrived: NoteFile[] = []
    for (const name of fresh) {
      watch.seen.add(name)
      arrived.push({ ...(await readNote($, inbox, name)), status: 'applying' as const })
    }
    await update($, notes, list => [...arrived, ...list].slice(0, 50))
    await markDelivered($, cwd, fresh)
    const summary = arrived
      .map(a => `${a.edits} edit${a.edits === 1 ? '' : 's'}, ${a.marks} mark${a.marks === 1 ? '' : 's'}${a.tldr ? `, "${a.tldr.slice(0, 70)}${a.tldr.length > 70 ? '…' : ''}"` : ''}`)
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
      description: 'Open the markup review layer over this project (a folder, or a dev server URL to proxy)',
      argumentHint: '[folder | http://localhost:3000] [--page /path]',
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
    try {
      const { url, opened } = await openReview($, cwd, parseArgs(e.args))
      return {
        text: [
          `Review layer: ${url}${opened ? '' : ' (open it in your browser)'}`,
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
      const { url, opened } = await openReview($, cwd, { root: input.root, proxy: input.proxy, page: input.page })
      return { result: { url, opened, inbox: inboxOf(cwd) } }
    } catch (err) {
      return { deny: `markup-review: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  on('tool.call', { tool: TOOL_NOTES }, async $ => {
    const list = await read($, notes)
    return { result: { inbox: inboxOf(await $.session.cwd()), notes: list.map(({ text, ...rest }) => rest) } }
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
    const room = Math.max(1, Math.floor(((e.props.placement === 'dock' ? e.props.scroll.bodyRows : 30) - 5) / 4))

    return (
      <Box flexDirection="column">
        {srv ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text weight="semibold">Server on port {srv.port}</Text>
            <Text dimColor wrap="truncate">{srv.target}</Text>
            <Link href={srv.url} label="Review page" />
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
              {n.edits} edits, {n.marks} marks, {n.status}
            </Text>
            {n.tldr ? <Text italic wrap="truncate">{n.tldr}</Text> : null}
          </Box>
        ))}
      </Box>
    )
  })
}
