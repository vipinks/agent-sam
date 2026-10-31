import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConveyorError } from 'electron-conveyor/react'
import { SettingsView } from '@/app/components/workbench/settings-view'
import { useMcpServersStore } from '@/conveyor/stores/mcp-servers'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The MCP Servers section, as wiring: what each row and each dialog reaches.
 *
 * The rules behind the screen — which servers are running, what a trust state reads as, whether Start
 * is permitted — are `tests/mcp/mcp-settings-rules-test.ts`'s, and the files underneath are
 * `tests/mcp/mcp-servers-test.ts`'s. What can only be seen here is the composition: that both scopes
 * are listed with their badges and states, that an add refuses on the field it belongs to and then
 * dispatches in the order the design names, that a delete stops before it removes, that an untrusted
 * project row cannot be started until it is trusted, that a secret goes up once and never comes back,
 * and that the log viewer renders what main last answered.
 *
 * Main is simulated, not faked: `fakeMcp` below holds both config files, the running registry, the
 * trust records and the log buffers, and answers each call the way the module does — a write changes
 * its state, and the next read reports the change. So the row that appears after an add is the row
 * main's answer makes appear.
 *
 * A failed call is the one thing the fake does not invent: `failWith` installs a code, and the suite
 * asserts the section's own words for it rather than main's message, because the code is the contract.
 */

/** One server as a config file holds it, in the shape the section draws a row from. */
interface FakeServer {
  id: string
  command: string
  args?: string[]
  cwd?: string | null
  env?: Record<string, string>
  enabled?: boolean
  /** Project scope only; a user server has no trust record. */
  trust?: 'matched' | 'mismatched' | 'absent'
  secrets?: Array<{ name: string; set: boolean }>
  /** Absent in the file is off, and the view normalizes it — see `listing`. */
  autoApprove?: boolean
  /** A test-only marker: main never sends this, and the edit form must never paint it. */
  storedSecret?: string
}

/** Main's half of the section: both files, the running registry, and the log buffers. */
interface FakeState {
  user: FakeServer[]
  project: FakeServer[]
  /** Tools per running server, by id. A server absent from this map is not running. */
  tools: Record<string, string[]>
  logs: Record<string, string[]>
}

const ROOT = 'C:/w'

/** A provider that ships, because the screen draws the Providers section beside this one. */
const PROVIDERS = [{ id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' }]

/** The state every test starts from unless it says otherwise: one server per scope. */
function initialState(over: Partial<FakeState> = {}): FakeState {
  return {
    user: [{ id: 'filesystem', command: 'npx', args: ['-y', 'server-filesystem', '.'], enabled: true }],
    project: [{ id: 'docs', command: 'node', args: ['tools/docs.js'], enabled: false, trust: 'absent' }],
    tools: {},
    logs: {},
    ...over,
  }
}

/** One listing entry, as `mcp.listServers` reports it. */
function listing(server: FakeServer, scope: 'user' | 'project') {
  return {
    id: server.id,
    transport: 'stdio' as const,
    command: server.command,
    args: server.args ?? [],
    cwd: server.cwd ?? null,
    env: server.env ?? {},
    enabled: server.enabled ?? false,
    scope,
    trust: scope === 'project' ? (server.trust ?? 'absent') : null,
    secrets: server.secrets ?? [],
    // Normalized the way main normalizes it: a row's toggle has two positions, and the key not being in
    // the file is not one of them.
    autoApprove: server.autoApprove ?? false,
  }
}

/** Install main's half over a stub, and hand back the state it keeps. */
function fakeMcp(stub: BridgeStub, initial: FakeState): { state: FakeState } {
  const state = structuredClone(initial)
  const file = (scope: 'user' | 'project') => (scope === 'user' ? state.user : state.project)

  stub.on('listServers', () => ({
    user: state.user.map((server) => listing(server, 'user')),
    project: state.project.map((server) => listing(server, 'project')),
    errors: [],
  }))

  stub.on('listRunningTools', () =>
    Object.entries(state.tools).flatMap(([serverId, tools]) => tools.map((name) => ({ serverId, tool: { name } })))
  )

  stub.on('addServer', (input) => {
    const { scope, server } = input as { scope: 'user' | 'project'; server: { id: string } }
    file(scope).push({ ...(server as FakeServer), trust: 'absent', secrets: [] })
    return { id: server.id }
  })

  stub.on('updateServer', (input) => {
    const { scope, serverId, patch } = input as {
      scope: 'user' | 'project'
      serverId: string
      patch: {
        command?: string
        args?: string[]
        cwd?: string | null
        env?: Record<string, string>
        autoApprove?: boolean
      }
    }
    const server = file(scope).find((candidate) => candidate.id === serverId)
    if (server) {
      if ('command' in patch) server.command = patch.command as string
      if ('args' in patch) server.args = patch.args
      if ('cwd' in patch) server.cwd = patch.cwd
      if ('env' in patch) server.env = patch.env
      if ('autoApprove' in patch) server.autoApprove = patch.autoApprove
      // The real command stops a running server and clears a project grant before the write.
      if (scope === 'project') server.trust = 'absent'
    }
    delete state.tools[serverId]
    return { id: serverId }
  })

  stub.on('removeServer', (input) => {
    const { scope, serverId } = input as { scope: 'user' | 'project'; serverId: string }
    const next = file(scope).filter((server) => server.id !== serverId)
    if (scope === 'user') state.user = next
    else state.project = next
    delete state.tools[serverId]
    return { id: serverId }
  })

  stub.on('setEnabled', (input) => {
    const { scope, serverId, enabled } = input as { scope: 'user' | 'project'; serverId: string; enabled: boolean }
    const server = file(scope).find((candidate) => candidate.id === serverId)
    if (server) server.enabled = enabled
    return { id: serverId, enabled }
  })

  // The flag's write, and the consequence the real one has: for a project server it changes the config
  // the grant was made against, so the next read compares the hash and reports a mismatch. Modelled here
  // rather than left to the test, because the *screen* is what this file is about — the rule is main's,
  // and `tests/mcp/mcp-servers-test.ts` proves it against a real file.
  stub.on('setAutoApprove', (input) => {
    const { scope, serverId, value } = input as {
      scope: 'user' | 'project'
      serverId: string
      value: boolean
    }
    const server = file(scope).find((candidate) => candidate.id === serverId)
    if (server) {
      server.autoApprove = value
      if (scope === 'project' && server.trust === 'matched') server.trust = 'mismatched'
    }
    return { id: serverId, autoApprove: value }
  })

  stub.on('setTrust', (input) => {
    const { serverId, trusted } = input as { serverId: string; trusted: boolean }
    const server = state.project.find((candidate) => candidate.id === serverId)
    if (server) server.trust = trusted ? 'matched' : 'absent'
    return { id: serverId, trusted, configHash: trusted ? 'hash' : null }
  })

  stub.on('setSecret', (input) => {
    const { scope, serverId, name } = input as { scope: 'user' | 'project'; serverId: string; name: string }
    const server = file(scope).find((candidate) => candidate.id === serverId)
    const secrets = (server?.secrets ?? []).filter((secret) => secret.name !== name)
    secrets.push({ name, set: true })
    if (server) server.secrets = secrets
    return { id: serverId, name }
  })

  stub.on('clearSecret', (input) => {
    const { scope, serverId, name } = input as { scope: 'user' | 'project'; serverId: string; name: string }
    const server = file(scope).find((candidate) => candidate.id === serverId)
    if (server)
      server.secrets = (server.secrets ?? []).map((secret) =>
        secret.name === name ? { ...secret, set: false } : secret
      )
    return { id: serverId, name }
  })

  stub.on('getServerLogs', (input) => {
    const { serverId } = input as { serverId: string }
    return { serverId, lines: state.logs[serverId] ?? [] }
  })

  stub.on('startServer', (input) => {
    const { serverId } = input as { serverId: string }
    state.tools[serverId] = ['one', 'two']
    return { id: serverId, tools: state.tools[serverId].map((name) => ({ name })) }
  })

  stub.on('stopServer', (input) => {
    const { serverId } = input as { serverId: string }
    delete state.tools[serverId]
    return { id: serverId, running: false }
  })

  return { state }
}

/**
 * A stub whose settings answers are the ones this suite describes, and whose MCP half is main.
 *
 * `overrides` is where a test replaces one member to make it fail: a failing call is the one thing the
 * fake does not model, because a refusal is main's business and its code is what the section reads.
 */
function stubSettings(over: Partial<FakeState> = {}, overrides: Record<string, (input: unknown) => unknown> = {}) {
  const stub = createBridgeStub({
    listProviders: () => PROVIDERS,
    defaultModels: () => ({}),
    listConfigured: () => [],
    isEncryptionAvailable: () => true,
    listFilesFlat: () => [],
  })
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
  const { state } = fakeMcp(stub, initialState(over))
  // After the fake, so a test can replace one of main's answers without the fake overwriting it.
  for (const [method, handler] of Object.entries(overrides)) stub.on(method, handler)
  setActiveStub(stub)
  return { stub, state }
}

/** The screen, over its own query client so one test's cache cannot answer the next one's read. */
function renderSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsView />
    </QueryClientProvider>
  )
}

/** Open the section: the tab a reader clicks, and the moment the mirror refreshes. */
async function openMcp(): Promise<void> {
  await userEvent.click(screen.getByRole('tab', { name: 'MCP Servers' }))
  await screen.findByRole('heading', { name: 'MCP servers' })
}

/** One server's row, by the id it names. */
function row(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-slot="mcp-server-row"][data-server-id="${id}"]`)
  if (!found) throw new Error(`no row for ${id}`)
  return found
}

/** Every row, in document order. */
function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="mcp-server-row"]')]
}

/** What one row says it is doing, as the marker carries it: running, or stopped. */
function runningState(id: string): string | null {
  return row(id).querySelector<HTMLElement>('[data-slot="mcp-running"]')?.dataset.state ?? null
}

/** The words the section's own alerts are showing. */
function alerts(): string[] {
  return screen.queryAllByRole('alert').map((node) => node.textContent ?? '')
}

/** Every method the section called on main, in order. */
function mcpMethods(stub: BridgeStub): string[] {
  return stub.methodsOn('mcp')
}

/** The input a call carried, by method name. */
function inputOf(stub: BridgeStub, method: string): Record<string, unknown> {
  const call = stub.calls.find((candidate) => candidate.method === method)
  if (!call) throw new Error(`no call to ${method}`)
  return call.args[0] as Record<string, unknown>
}

beforeEach(() => {
  localStorage.clear()
  // The mirror is a module-level store and the section draws the last answer it holds: a test that left
  // it full would decide the next one's first paint.
  useMcpServersStore.setState({ loading: true, listing: null, running: [], error: null })
})

describe('the server list', () => {
  it('lists both scopes with scope badges, enable state and running state', async () => {
    stubSettings({ tools: { filesystem: ['read_file', 'list_directory'], docs: ['search'] } })
    renderSettings()
    await openMcp()

    expect(rows().map((node) => node.dataset.serverId)).toEqual(['filesystem', 'docs'])
    expect(within(row('filesystem')).getByText('User')).toBeTruthy()
    expect(within(row('docs')).getByText('Project')).toBeTruthy()

    // The running column is the derivation, not a claim: two tools for one server, one for the other.
    expect(runningState('filesystem')).toBe('running')
    expect(within(row('filesystem')).getByText(/2 tools/)).toBeTruthy()
    expect(runningState('docs')).toBe('running')
    expect(within(row('docs')).getByText(/1 tool\b/)).toBeTruthy()

    // The flag is the file's, and the row shows it: one server of the two is switched on.
    expect(
      within(row('filesystem')).getByRole('switch', { name: 'Enable filesystem' }).getAttribute('data-state')
    ).toBe('checked')
    expect(within(row('docs')).getByRole('switch', { name: 'Enable docs' }).getAttribute('data-state')).toBe(
      'unchecked'
    )
  })

  it('shows every server stopped when a launch hydrates with nothing running', async () => {
    stubSettings()
    renderSettings()
    await openMcp()

    // The ordinary state of a fresh launch: main reports no tools at all, which is not a failed read.
    expect(rows().every((node) => runningState(node.dataset.serverId as string) === 'stopped')).toBe(true)
    expect(within(row('filesystem')).getByText('Stopped')).toBeTruthy()
    expect(within(row('docs')).getByText('Stopped')).toBeTruthy()
  })

  it('reads both scopes once when the section opens, and never on a timer', async () => {
    const { stub } = stubSettings()
    renderSettings()
    await openMcp()

    await waitFor(() => expect(mcpMethods(stub)).toContain('listServers'))
    expect(inputOf(stub, 'listServers')).toEqual({ rootPath: ROOT })
    expect(mcpMethods(stub).filter((method) => method === 'listServers')).toHaveLength(1)
    expect(mcpMethods(stub).filter((method) => method === 'listRunningTools')).toHaveLength(1)
  })
})

/** The dialog's own field, by the label it states. */
async function field(label: string): Promise<HTMLElement> {
  return await screen.findByLabelText(label)
}

/** Open the add dialog from the section's own button. */
async function openAdd(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: 'Add Server' }))
  await screen.findByText('Add a server')
}

/** Type a field's value, so the form sees real edits rather than a set value. */
async function type(label: string, value: string): Promise<void> {
  await userEvent.type(await field(label), value)
}

/** Press one of the dialog's own buttons. */
async function press(name: string): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name }))
}

/** What the dialog is refusing, and where. Empty when it is refusing nothing. */
function fieldErrors(): string[] {
  return screen.queryAllByRole('alert').map((node) => node.textContent ?? '')
}

describe('the add dialog', () => {
  it('refuses a bad id, a blank command, and a duplicate in the chosen scope, each on its own field', async () => {
    const { stub } = stubSettings()
    renderSettings()
    await openMcp()

    await openAdd()
    await type('Server id', 'Not A Slug!')
    await type('Command', 'node')
    await press('Save server')

    // The slug rule is the protocol's own, applied here so the refusal lands on the field it belongs to
    // instead of being discovered by main and reported somewhere the user has to go looking.
    expect(fieldErrors().some((text) => /lower-case/.test(text))).toBe(true)
    expect(mcpMethods(stub)).not.toContain('addServer')

    await userEvent.clear(await field('Server id'))
    await type('Server id', 'fresh')
    await userEvent.clear(await field('Command'))
    await press('Save server')

    // A command is required, and the complaint is about the command rather than about the draft as a
    // whole: the id typed above is perfectly good.
    expect(fieldErrors().some((text) => /command/i.test(text))).toBe(true)
    expect(mcpMethods(stub)).not.toContain('addServer')

    // A duplicate is a duplicate *per scope*, so the id of a project server is free in the user scope
    // and taken in the project one.
    await type('Command', 'node')
    await press('Save server')
    await waitFor(() => expect(mcpMethods(stub)).toContain('addServer'))
    expect(inputOf(stub, 'addServer')).toMatchObject({ scope: 'user', server: { id: 'fresh' } })

    await openAdd()
    await press('Project')
    await type('Server id', 'docs')
    await type('Command', 'node')
    await press('Save server')

    expect(fieldErrors().some((text) => /already exists/.test(text))).toBe(true)
    expect(mcpMethods(stub).filter((method) => method === 'addServer')).toHaveLength(1)
  })

  it('sends the config first and then each secret row, in order, with no secret in the config payload', async () => {
    const { stub } = stubSettings()
    renderSettings()
    await openMcp()

    await openAdd()
    await press('Project')
    await type('Server id', 'notebook')
    await type('Command', 'uvx')
    await type('Arguments', 'notebook-mcp\n--port\n4312')
    await type('Working directory', 'C:/w/tools')

    await press('Add environment variable')
    await type('Environment name 1', 'LOG_LEVEL')
    await type('Environment value 1', 'debug')

    await press('Add secret')
    await type('Secret name 1', 'TOKEN')
    await type('Secret value 1', 'plaintext-first')
    await press('Add secret')
    await type('Secret name 2', 'API_KEY')
    await type('Secret value 2', 'second-secret')

    await press('Save server')

    await waitFor(() => expect(mcpMethods(stub)).toContain('setSecret'))
    // The order the design names: the server exists before a secret is stored against it, so a secret
    // can never name a server that is not there. Both secret rows follow the add, in the order typed.
    expect(mcpMethods(stub)).toEqual([
      'listServers',
      'listRunningTools',
      'addServer',
      'setSecret',
      'setSecret',
      'listServers',
      'listRunningTools',
    ])

    expect(inputOf(stub, 'addServer')).toEqual({
      scope: 'project',
      rootPath: ROOT,
      server: {
        id: 'notebook',
        command: 'uvx',
        args: ['notebook-mcp', '--port', '4312'],
        cwd: 'C:/w/tools',
        env: { LOG_LEVEL: 'debug' },
        enabled: false,
      },
    })

    // No ciphertext and no plaintext secret crosses the boundary in the config payload: the secrets
    // travel as plaintext, once each, through the call that encrypts them.
    const addPayload = JSON.stringify(inputOf(stub, 'addServer'))
    expect(addPayload).not.toContain('secretEnv')
    expect(addPayload).not.toContain('plaintext-first')

    const secrets = stub.calls
      .filter((call) => call.method === 'setSecret')
      .map((call) => call.args[0] as Record<string, unknown>)
    expect(secrets.map((input) => [input.name, input.value])).toEqual([
      ['TOKEN', 'plaintext-first'],
      ['API_KEY', 'second-secret'],
    ])
    expect(secrets[0]).toMatchObject({ scope: 'project', rootPath: ROOT, serverId: 'notebook' })
  })
})

describe('a row’s own controls', () => {
  it('persists the enable switch and leaves trust alone', async () => {
    const { stub, state } = stubSettings()
    renderSettings()
    await openMcp()

    await userEvent.click(within(row('docs')).getByRole('switch', { name: 'Enable docs' }))

    await waitFor(() => expect(mcpMethods(stub)).toContain('setEnabled'))
    expect(inputOf(stub, 'setEnabled')).toEqual({ scope: 'project', rootPath: ROOT, serverId: 'docs', enabled: true })
    // Switching a server on is a statement about whether it may run now, not about what it would run,
    // so it must not touch the grant — the hash does not cover the flag, and neither does this control.
    expect(mcpMethods(stub)).not.toContain('setTrust')
    expect(state.project[0].trust).toBe('absent')

    // And the row follows main's answer rather than its own optimism: the refresh is what moved it.
    await waitFor(() =>
      expect(row('docs').querySelector<HTMLElement>('[data-slot="mcp-enabled"]')?.dataset.state).toBe('checked')
    )
  })

  it('confirms a delete by naming the id, stops a running server first, then removes it', async () => {
    const { stub } = stubSettings({
      tools: { docs: ['search'] },
      project: [{ id: 'docs', command: 'node', enabled: true, trust: 'matched' }],
    })
    renderSettings()
    await openMcp()

    await userEvent.click(within(row('docs')).getByRole('button', { name: 'Delete docs' }))

    // The confirmation names the server rather than asking about "this server": the row is one of
    // several, and a dialog that does not say which one is a dialog nobody can answer safely.
    expect(screen.getByText('Remove docs?')).toBeTruthy()
    // The warning is the dialog's own: a running server is stopped before it is forgotten, and that is
    // said where the confirmation is rather than left to be discovered.
    expect(screen.getByRole('alertdialog').textContent ?? '').toMatch(/stopped first/i)

    await userEvent.click(screen.getByRole('button', { name: 'Remove server' }))

    await waitFor(() => expect(mcpMethods(stub)).toContain('removeServer'))
    // A running server is stopped before it is forgotten: leaving a process behind would run something
    // no file names any more, with no row left to stop it from.
    expect(mcpMethods(stub).indexOf('stopServer')).toBeLessThan(mcpMethods(stub).indexOf('removeServer'))
    expect(inputOf(stub, 'removeServer')).toEqual({ scope: 'project', rootPath: ROOT, serverId: 'docs' })

    await waitFor(() => expect(rows().some((node) => node.dataset.serverId === 'docs')).toBe(false))
  })
})

describe('the row’s process controls as a status light', () => {
  /** The class tokens on the glyph a control draws; an SVG states its class as an attribute. */
  function glyphTokens(control: HTMLElement): string[] {
    return (control.querySelector('svg')?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
  }

  /** One row's Start, and its Stop, by the slots the row marks them with. */
  function processControl(id: string, slot: 'mcp-start' | 'mcp-stop'): HTMLButtonElement {
    const control = row(id).querySelector<HTMLButtonElement>(`[data-slot="${slot}"]`)
    if (!control) throw new Error(`no ${slot} on ${id}`)
    return control
  }

  it('greens the play while running, reddens the stop, and leaves both muted when stopped', async () => {
    stubSettings({
      // Two user servers, one of them answering: the default fixture has a single user row, and this claim
      // needs the same row drawn in both states at once so the two inks are compared on one screen.
      user: [
        { id: 'filesystem', command: 'npx', args: ['-y', 'server-filesystem', '.'], enabled: true },
        { id: 'memory', command: 'npx', args: ['-y', 'server-memory'], enabled: true },
      ],
      tools: { filesystem: ['read_file'] },
    })
    renderSettings()
    await openMcp()

    // Running: play doubles as the status light, so it takes the running green, and stop is the danger
    // action for the process that is actually there.
    const runningPlay = processControl('filesystem', 'mcp-start')
    const runningStop = processControl('filesystem', 'mcp-stop')
    expect(glyphTokens(runningPlay)).toContain('text-green-500')
    expect(glyphTokens(runningStop)).toContain('text-red-500')
    expect(runningStop.disabled).toBe(false)

    // Stopped: there is nothing to stop, so stop is withheld and muted, and play is back to the neutral
    // ink of a control that is merely offered rather than reporting.
    const stoppedPlay = processControl('memory', 'mcp-start')
    const stoppedStop = processControl('memory', 'mcp-stop')
    expect(glyphTokens(stoppedPlay)).toContain('text-muted-foreground')
    expect(glyphTokens(stoppedStop)).toContain('text-muted-foreground')
    expect(stoppedStop.disabled).toBe(true)
  })
})

describe('the trust gate', () => {
  it('disables Start on an untrusted project row, and Trust grants it', async () => {
    const { stub, state } = stubSettings({ project: [{ id: 'docs', command: 'node', enabled: true, trust: 'absent' }] })
    renderSettings()
    await openMcp()

    expect(within(row('docs')).getByText('Not trusted yet')).toBeTruthy()
    expect((within(row('docs')).getByRole('button', { name: 'Start docs' }) as HTMLButtonElement).disabled).toBe(true)

    await userEvent.click(within(row('docs')).getByRole('button', { name: 'Trust' }))

    await waitFor(() => expect(mcpMethods(stub)).toContain('setTrust'))
    // Granted against the config as it stands: main recomputes the hash, which is why nothing but the
    // id and the answer travels.
    expect(inputOf(stub, 'setTrust')).toEqual({ rootPath: ROOT, serverId: 'docs', trusted: true })
    expect(state.project[0].trust).toBe('matched')

    await waitFor(() =>
      expect((within(row('docs')).getByRole('button', { name: 'Start docs' }) as HTMLButtonElement).disabled).toBe(
        false
      )
    )
    expect(within(row('docs')).getByText('Trusted')).toBeTruthy()
  })

  it('names the changed config on a mismatched row, and Re-trust recomputes', async () => {
    const { stub, state } = stubSettings({
      project: [{ id: 'docs', command: 'node', enabled: true, trust: 'mismatched' }],
    })
    renderSettings()
    await openMcp()

    // The sentence names what happened. A changed server was trusted once and is not any more, and the
    // difference matters: the repair is a re-grant rather than a first grant.
    expect(within(row('docs')).getByText(/changed since it was trusted/i)).toBeTruthy()
    expect((within(row('docs')).getByRole('button', { name: 'Start docs' }) as HTMLButtonElement).disabled).toBe(true)

    await userEvent.click(within(row('docs')).getByRole('button', { name: 'Re-trust' }))

    await waitFor(() => expect(mcpMethods(stub)).toContain('setTrust'))
    expect(inputOf(stub, 'setTrust')).toEqual({ rootPath: ROOT, serverId: 'docs', trusted: true })
    expect(state.project[0].trust).toBe('matched')
    await waitFor(() => expect(within(row('docs')).getByRole('button', { name: 'Revoke' })).toBeTruthy())
  })

  it('leaves a user server out of the gate entirely', async () => {
    stubSettings()
    renderSettings()
    await openMcp()

    // A user server has no trust record to read and none to grant: the file is the user's own. So the
    // row carries no trust line, and Start is offered on the flag alone.
    expect(within(row('filesystem')).queryByText(/trusted/i)).toBeNull()
    expect(within(row('filesystem')).queryByRole('button', { name: 'Trust' })).toBeNull()
    expect(
      (within(row('filesystem')).getByRole('button', { name: 'Start filesystem' }) as HTMLButtonElement).disabled
    ).toBe(false)
  })
})

describe('the auto-approve flag on a row', () => {
  it('offers the auto-approve toggle with a badge while it is on, and its own tooltip throughout', async () => {
    const { stub, state } = stubSettings({
      project: [{ id: 'docs', command: 'node', enabled: true, trust: 'matched' }],
    })
    renderSettings()
    await openMcp()

    const control = () => within(row('docs')).getByRole('button', { name: 'Auto-approve tools for docs' })
    // Off to begin with, and it says so in the pressed state rather than only in its colour.
    expect(control().getAttribute('aria-pressed')).toBe('false')
    expect(row('docs').querySelector('[data-slot="mcp-auto-approve-badge"]')).toBeNull()
    // The tooltip names the two things a user needs before pressing it: every conversation, and the fact
    // that this is not a start. Without the second, the control reads like the power switch beside it.
    expect(control().getAttribute('title')).toMatch(/without asking in every conversation/)
    expect(control().getAttribute('title')).toMatch(/does not start the server/)

    await userEvent.click(control())

    await waitFor(() => expect(mcpMethods(stub)).toContain('setAutoApprove'))
    expect(inputOf(stub, 'setAutoApprove')).toEqual({
      scope: 'project',
      rootPath: ROOT,
      serverId: 'docs',
      value: true,
    })
    // The write is the flag and nothing else: no start, and no trust written here — the mismatch below is
    // the existing hash rule doing its job, and one Re-trust is how the user answers it.
    expect(mcpMethods(stub)).not.toContain('startServer')
    expect(mcpMethods(stub)).not.toContain('setTrust')
    expect(state.project[0].autoApprove).toBe(true)

    // The badge is what a glance at this section says about the server, drawn while the flag is on and
    // gone the moment it is not.
    await waitFor(() => expect(row('docs').querySelector('[data-slot="mcp-auto-approve-badge"]')).not.toBeNull())
    expect(control().getAttribute('aria-pressed')).toBe('true')

    await userEvent.click(control())

    await waitFor(() => expect(row('docs').querySelector('[data-slot="mcp-auto-approve-badge"]')).toBeNull())
    expect(state.project[0].autoApprove).toBe(false)
  })

  it('shows the mismatched warning after flagging a trusted project row, and withholds Start until Re-trust', async () => {
    const { stub } = stubSettings({ project: [{ id: 'docs', command: 'node', enabled: true, trust: 'matched' }] })
    renderSettings()
    await openMcp()

    // The row starts in order, with Start offered.
    expect((within(row('docs')).getByRole('button', { name: 'Start docs' }) as HTMLButtonElement).disabled).toBe(false)
    expect(within(row('docs')).getByText('Trusted')).toBeTruthy()

    await userEvent.click(within(row('docs')).getByRole('button', { name: 'Auto-approve tools for docs' }))

    // Flagging changes what the server may do, so the grant made for the old behaviour no longer covers
    // it: the existing comparison reports a mismatch, and Start is withheld until the user re-trusts.
    await waitFor(() => expect(within(row('docs')).getByText(/changed since it was trusted/i)).toBeTruthy())
    expect((within(row('docs')).getByRole('button', { name: 'Start docs' }) as HTMLButtonElement).disabled).toBe(true)

    await userEvent.click(within(row('docs')).getByRole('button', { name: 'Re-trust' }))

    await waitFor(() =>
      expect((within(row('docs')).getByRole('button', { name: 'Start docs' }) as HTMLButtonElement).disabled).toBe(
        false
      )
    )
    // The confirmation is the line that has to say what was granted, and a grant that now covers calls
    // nobody is asked about is a stronger one than either half alone — so it names the flag in words
    // rather than leaving the badge to carry that meaning on its own.
    expect(within(row('docs')).getByText(/its tools run without asking/i)).toBeTruthy()
    await waitFor(() => expect(mcpMethods(stub)).toContain('setTrust'))
  })

  it('leaves a flagged user row out of the trust gate, which governs the project scope only', async () => {
    stubSettings({ user: [{ id: 'filesystem', command: 'npx', enabled: true, autoApprove: true }] })
    renderSettings()
    await openMcp()

    expect(row('filesystem').querySelector('[data-slot="mcp-auto-approve-badge"]')).not.toBeNull()
    expect(
      within(row('filesystem'))
        .getByRole('button', { name: 'Auto-approve tools for filesystem' })
        .getAttribute('aria-pressed')
    ).toBe('true')
    expect(
      (within(row('filesystem')).getByRole('button', { name: 'Start filesystem' }) as HTMLButtonElement).disabled
    ).toBe(false)
    expect(within(row('filesystem')).queryByText(/trusted/i)).toBeNull()
  })
})

describe('the add dialog and the flag', () => {
  it('defaults the checkbox off and sends the flag only when it is ticked', async () => {
    const { stub } = stubSettings()
    renderSettings()
    await openMcp()

    await openAdd()
    const box = () => screen.getByRole('checkbox', { name: /Auto-approve tools/ })
    expect(box().getAttribute('data-state')).toBe('unchecked')

    await type('Server id', 'quiet')
    await type('Command', 'node')
    await press('Save server')

    await waitFor(() => expect(mcpMethods(stub)).toContain('addServer'))
    // Absent rather than `false`: a server added without the tick is written exactly as one added before
    // the flag existed, so nothing downstream has to tell "turned off" apart from "nobody has said".
    expect(inputOf(stub, 'addServer')).toMatchObject({ server: { id: 'quiet', command: 'node', enabled: false } })
    expect((inputOf(stub, 'addServer').server as Record<string, unknown>).autoApprove).toBeUndefined()

    // And a fresh dialog is off again: the tick decides whether a server runs unattended, so it is never
    // carried over from a draft that was abandoned.
    await openAdd()
    expect(
      (screen.getByRole('checkbox', { name: /Auto-approve tools/ }) as HTMLElement).getAttribute('data-state')
    ).toBe('unchecked')
    await press('Cancel')

    await openAdd()
    await type('Server id', 'loud')
    await type('Command', 'node')
    await userEvent.click(screen.getByRole('checkbox', { name: /Auto-approve tools/ }))
    await press('Save server')

    await waitFor(() => expect(mcpMethods(stub).filter((method) => method === 'addServer')).toHaveLength(2))
    const adds = stub.calls
      .filter((call) => call.method === 'addServer')
      .map((call) => call.args[0] as Record<string, unknown>)
    expect((adds[1].server as Record<string, unknown>).autoApprove).toBe(true)
  })
})

describe('the edit dialog', () => {
  const editableProject = {
    id: 'docs',
    command: 'node',
    args: ['tools/docs.js', '--watch'],
    cwd: 'C:/w/tools',
    env: { LOG_LEVEL: 'debug' },
    enabled: true,
    autoApprove: true,
    trust: 'matched' as const,
    secrets: [
      { name: 'TOKEN', set: true },
      { name: 'API_KEY', set: false },
    ],
    storedSecret: 'plaintext-never-on-screen',
  }

  async function openEdit(id = 'docs'): Promise<void> {
    await userEvent.click(within(row(id)).getByRole('button', { name: `Edit ${id}` }))
    await screen.findByText(`Edit ${id}`)
  }

  it('prefills the stored record, keeps the id read-only, and never paints a stored secret', async () => {
    stubSettings({ project: [editableProject] })
    renderSettings()
    await openMcp()
    await openEdit()

    expect(((await field('Server id')) as HTMLInputElement).value).toBe('docs')
    expect(((await field('Server id')) as HTMLInputElement).readOnly).toBe(true)
    expect(((await field('Command')) as HTMLInputElement).value).toBe('node')
    expect(((await field('Arguments')) as HTMLTextAreaElement).value).toBe('tools/docs.js\n--watch')
    expect(((await field('Working directory')) as HTMLInputElement).value).toBe('C:/w/tools')
    expect(((await field('Environment name 1')) as HTMLInputElement).value).toBe('LOG_LEVEL')
    expect(((await field('Environment value 1')) as HTMLInputElement).value).toBe('debug')
    expect(
      (screen.getByRole('checkbox', { name: /Auto-approve tools/ }) as HTMLElement).getAttribute('data-state')
    ).toBe('checked')

    const token = (await field('New value for TOKEN')) as HTMLInputElement
    expect(token.type).toBe('password')
    expect(token.value).toBe('')
    expect(token.placeholder).toBe('Leave blank to keep, type to replace')
    expect(((await field('New value for API_KEY')) as HTMLInputElement).value).toBe('')

    // The id is a key, not a draft: renaming is delete-plus-add, and the dialog says so once.
    expect(screen.getByText('To change the id, delete the server and add it again')).toBeTruthy()

    // Main never sends the stored value, and the form never invents one to paint.
    expect(document.body.textContent ?? '').not.toContain(editableProject.storedSecret)
    expect(screen.queryByDisplayValue(editableProject.storedSecret)).toBeNull()
  })

  it('sends the config first, then the secret rows in order, and never puts a secret in the patch', async () => {
    const { stub } = stubSettings({ project: [editableProject] })
    renderSettings()
    await openMcp()
    await openEdit()

    await userEvent.clear(await field('Command'))
    await type('Command', 'node-next')
    await userEvent.clear(await field('Environment value 1'))
    await type('Environment value 1', 'trace')
    await userEvent.click(screen.getByRole('checkbox', { name: /Auto-approve tools/ }))

    await type('New value for TOKEN', 'replacement-token')
    await userEvent.click(screen.getByRole('button', { name: 'Clear API_KEY' }))
    await press('Save changes')

    await waitFor(() => expect(mcpMethods(stub)).toContain('updateServer'))
    expect(mcpMethods(stub)).toEqual([
      'listServers',
      'listRunningTools',
      'updateServer',
      'setSecret',
      'clearSecret',
      'listServers',
      'listRunningTools',
    ])

    // Only the fields that changed travel. An untouched cwd, args list or flag is not restated, so the
    // record keeps the absence the file had rather than acquiring a normalized copy of it.
    expect(inputOf(stub, 'updateServer')).toEqual({
      scope: 'project',
      rootPath: ROOT,
      serverId: 'docs',
      patch: {
        command: 'node-next',
        env: { LOG_LEVEL: 'trace' },
        autoApprove: false,
      },
    })
    expect(JSON.stringify(inputOf(stub, 'updateServer'))).not.toContain('replacement-token')

    const secrets = stub.calls
      .filter((call) => call.method === 'setSecret' || call.method === 'clearSecret')
      .map((call) => [call.method, call.args[0]])
    expect(secrets).toEqual([
      ['setSecret', { scope: 'project', rootPath: ROOT, serverId: 'docs', name: 'TOKEN', value: 'replacement-token' }],
      ['clearSecret', { scope: 'project', rootPath: ROOT, serverId: 'docs', name: 'API_KEY' }],
    ])
  })

  it('leaves the config untouched when the edit is cancelled', async () => {
    const { stub, state } = stubSettings({ project: [editableProject] })
    renderSettings()
    await openMcp()
    await openEdit()

    await userEvent.clear(await field('Command'))
    await type('Command', 'node-next')
    await press('Cancel')

    expect(mcpMethods(stub)).not.toContain('updateServer')
    expect(mcpMethods(stub)).not.toContain('setSecret')
    expect(mcpMethods(stub)).not.toContain('clearSecret')
    expect(state.project[0].command).toBe('node')
  })

  it('refuses a blank command and a bad stored secret name on their own fields', async () => {
    const { stub } = stubSettings({
      project: [
        {
          ...editableProject,
          secrets: [{ name: 'API-TOKEN', set: true }],
        },
      ],
    })
    renderSettings()
    await openMcp()
    await openEdit()

    await userEvent.clear(await field('Command'))
    await press('Save changes')
    expect(fieldErrors().some((text) => text === 'A command is required — this is what gets run.')).toBe(true)
    expect(mcpMethods(stub)).not.toContain('updateServer')

    await type('Command', 'node-next')
    await press('Save changes')
    expect(
      fieldErrors().some((text) => text === 'Secret names become environment variables: "API-TOKEN" is not one.')
    ).toBe(true)
    expect(mcpMethods(stub)).not.toContain('updateServer')
  })
})

describe('the secrets dialog', () => {
  it('lists key names with set markers and never renders a submitted value', async () => {
    const { stub } = stubSettings({
      user: [
        {
          id: 'filesystem',
          command: 'npx',
          enabled: true,
          secrets: [
            { name: 'TOKEN', set: true },
            { name: 'API_KEY', set: false },
          ],
        },
      ],
    })
    renderSettings()
    await openMcp()

    await userEvent.click(within(row('filesystem')).getByRole('button', { name: 'Secrets filesystem' }))

    // Names and flags: the value is not the dialog's to show, in either direction.
    expect(screen.getByText('TOKEN')).toBeTruthy()
    expect(screen.getByText('API_KEY')).toBeTruthy()
    expect(screen.getByText('Set')).toBeTruthy()
    expect(screen.getByText('Not set')).toBeTruthy()

    await userEvent.type(await field('New value for API_KEY'), 'typed-once')
    await userEvent.click(screen.getByRole('button', { name: 'Set API_KEY' }))

    await waitFor(() => expect(mcpMethods(stub)).toContain('setSecret'))
    expect(inputOf(stub, 'setSecret')).toEqual({
      scope: 'user',
      rootPath: ROOT,
      serverId: 'filesystem',
      name: 'API_KEY',
      value: 'typed-once',
    })

    // Submitted once, and gone: the field is cleared, the flag says set, and the plaintext is not in the
    // document anywhere — the dialog's state is a name and a boolean, and this is that claim made visible.
    await waitFor(() => expect((screen.getByLabelText('New value for API_KEY') as HTMLInputElement).value).toBe(''))
    expect(screen.queryAllByText('Not set')).toHaveLength(0)
    expect(screen.queryAllByText('Set').length).toBeGreaterThanOrEqual(2)
    expect(document.body.textContent ?? '').not.toContain('typed-once')

    // Clearing is the other half of the same sentence: the marker goes back, and no value travels.
    await userEvent.click(screen.getByRole('button', { name: 'Clear TOKEN' }))
    await waitFor(() => expect(mcpMethods(stub)).toContain('clearSecret'))
    expect(inputOf(stub, 'clearSecret')).toEqual({
      scope: 'user',
      rootPath: ROOT,
      serverId: 'filesystem',
      name: 'TOKEN',
    })
    await waitFor(() => expect(screen.getAllByText('Not set').length).toBeGreaterThanOrEqual(1))
  })
})

describe('the log viewer', () => {
  it('renders the buffer it is given and refetches only when Refresh is pressed', async () => {
    const { stub } = stubSettings({ logs: { docs: ['starting up', 'listening on stdio'] } })
    renderSettings()
    await openMcp()

    await userEvent.click(within(row('docs')).getByRole('button', { name: 'Logs docs' }))

    await waitFor(() => expect(mcpMethods(stub)).toContain('getServerLogs'))
    expect(inputOf(stub, 'getServerLogs')).toEqual({ serverId: 'docs' })
    expect(screen.getByText('starting up')).toBeTruthy()
    expect(screen.getByText('listening on stdio')).toBeTruthy()
    // Fetched on open and on nothing else: an interval here would be a buffer that reads itself.
    expect(mcpMethods(stub).filter((method) => method === 'getServerLogs')).toHaveLength(1)

    await userEvent.click(screen.getByRole('button', { name: 'Refresh logs' }))

    await waitFor(() => expect(mcpMethods(stub).filter((method) => method === 'getServerLogs')).toHaveLength(2))
  })
})

describe('a failure on the process', () => {
  it('surfaces the code’s own words for a spawn failure and for a start timeout', async () => {
    const { stub } = stubSettings(
      { project: [{ id: 'docs', command: 'node', enabled: true, trust: 'matched' }] },
      {
        startServer: () => {
          throw new ConveyorError('MCP_SPAWN_FAILED', 'main says the spawn failed at a path you have never seen')
        },
      }
    )
    renderSettings()
    await openMcp()

    await userEvent.click(within(row('docs')).getByRole('button', { name: 'Start docs' }))

    await waitFor(() => expect(alerts().some((text) => text.includes('could not be started'))).toBe(true))
    // The section's sentence, not main's message: the message is for a log and the code is the contract,
    // so what a reader is shown is derived from the code the call rejected with.
    expect(alerts().every((text) => !text.includes('main says'))).toBe(true)

    stub.on('startServer', () => {
      throw new ConveyorError('MCP_START_TIMEOUT', 'main says the handshake gave up after 10000ms')
    })
    await userEvent.click(within(row('docs')).getByRole('button', { name: 'Start docs' }))

    await waitFor(() => expect(alerts().some((text) => text.includes('did not answer in time'))).toBe(true))
    expect(alerts().every((text) => !text.includes('10000ms'))).toBe(true)

    // A configuration main cannot use is refused the same way, in the same section's words.
    stub.on('startServer', () => {
      throw new ConveyorError('MCP_CONFIG_INVALID', 'main says record #2 is malformed')
    })
    await userEvent.click(within(row('docs')).getByRole('button', { name: 'Start docs' }))
    await waitFor(() => expect(alerts().some((text) => text.includes('not one this app can run'))).toBe(true))
    expect(alerts().every((text) => !text.includes('main says'))).toBe(true)
  })
})
