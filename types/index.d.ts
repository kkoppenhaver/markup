// State contract for the markup-review mod. Each value lives in $.state under the plugin's name.
export type NoteStatus = 'new' | 'applying' | 'applied'

export type NoteFile = {
  name: string
  path: string
  pngPath?: string
  page: string
  sentAt: string
  edits: number
  marks: number
  /** Screenshots dropped onto the page; the files sit beside the notes in the inbox. */
  images: number
  /** Comments anchored to selected passages (Google Docs style). */
  comments: number
  /** The general note about the whole page (was the TL;DR before 0.6). */
  note: string
  /** One or two sentences, derived from the json: what was retyped and what was drawn. */
  summary: string
  status: NoteStatus
  text: string
}

export type ServerInfo = {
  cwd: string
  port: number
  url: string
  target: string
  page: string
  /** The same page over the LAN (http://<lan ip>:port/...), when the server listens on every interface. */
  lanUrl?: string
  /** Over Tailscale, when the tailscale CLI answered. */
  tailscaleUrl?: string
}

declare module 'claude-code' {
  interface PluginState {
    'markup-review': {
      notes: Shaped<NoteFile[]>
      server: Shaped<ServerInfo | null>
    }
  }
}
