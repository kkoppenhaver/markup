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
  tldr: string
  status: NoteStatus
  text: string
}

export type ServerInfo = {
  cwd: string
  port: number
  url: string
  target: string
  page: string
}

declare module 'claude-code' {
  interface PluginState {
    'markup-review': {
      notes: Shaped<NoteFile[]>
      server: Shaped<ServerInfo | null>
    }
  }
}
