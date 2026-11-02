import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'markup-review',
  component: 'Pane',
  requestId: 'markup-review',
  props: {
    title: 'Review',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 24 },
    view: {},
  },
} as const

test('the pane explains itself before a server runs, on every surface', async ($, on) => {
  on('command.register', () => ({ value: { command: 'markup' } }))
  on('tool.register', () => ({ value: {} }))
  on('fs.exists', () => ({ value: false }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const line = await ui.find({ type: 'Text', text: /No review server/ })
    expect(line?.text).toBe('No review server running.')
    const hint = await ui.find({ type: 'Text', text: /markup/ })
    expect(hint?.text).toBe('Run /markup to start one.')
    await ui.unmount()
  }
})

test('a value an earlier version stored is declined', async ($, on) => {
  on('state.get', () => ({ value: { value: [{ name: 'old.md' }], version: 1 } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /No notes yet/ }))?.text).toBe('No notes yet. Mark up the page and press Cmd+Enter.')
  await ui.unmount()
})
