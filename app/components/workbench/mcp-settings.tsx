import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { KeyRound, Loader2, Play, Plus, RefreshCw, ScrollText, Square, Trash2, Zap } from 'lucide-react'
import { conveyor } from '@/conveyor/client'
import { ConveyorError, useConveyorStore } from 'electron-conveyor/react'
import { workspaceStore } from '@/conveyor/stores/workspace'
import { useMcpServersStore, type McpServerListing } from '@/conveyor/stores/mcp-servers'
import { canStartServer, trustPresentation } from '@/conveyor/protocol/mcp-settings'
import { isSafeMcpSecretKey, isSafeMcpServerId } from '@/conveyor/protocol/mcp-ids'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { Textarea } from '../ui/textarea'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog'

/**
 * MCP servers: both config files, one row per server, and everything a row can do to one.
 *
 * The two reads this draws from belong to main, and the section holds the last answer in
 * `useMcpServersStore` rather than reading per row — one refresh per visit and one per action, which is
 * what makes a start visible in the same paint that shows the row that started it. Nothing here polls:
 * a process list that redraws itself on a timer is a screen that moves while nobody is looking at it.
 *
 * Everything a row *decides* — whether it is running, what its trust state reads as, whether Start is
 * permitted — is derived by `protocol/mcp-settings` rather than computed in the JSX, because a rule a
 * screen branches on is a rule a suite has to be able to reach without a screen. What is here is the
 * wiring: which call a button makes, and what a failure says.
 *
 * Failures are said in this section's own words, branched on the error *code* and never on main's
 * message — the message is for a log, and the code is the contract. Editing is delete-plus-add, exactly
 * as it is for a custom provider: a server's command is not a field that can be edited in place without
 * a rule for what happens to the trust granted against the old one.
 */
export function McpServersSection() {
  const rootPath = useConveyorStore(workspaceStore, (s) => s.rootPath) ?? null
  const listing = useMcpServersStore((s) => s.listing)
  const running = useMcpServersStore((s) => s.running)
  const loading = useMcpServersStore((s) => s.loading)
  const error = useMcpServersStore((s) => s.error)
  const refresh = useMcpServersStore((s) => s.refresh)

  /** What the last action that failed had to say, in this section's words. */
  const [notice, setNotice] = useState<string | null>(null)

  const reload = useCallback(() => refresh(rootPath), [refresh, rootPath])
  // On opening, and on every action below: the surface is unmounted while it is not on screen, so its
  // first read is the one moment the mirror can be arbitrarily old.
  useEffect(() => {
    void reload()
  }, [reload])

  const toolCountOf = (serverId: string) => running.find((entry) => entry.serverId === serverId)?.toolCount

  return (
    <div data-slot="mcp-servers" className="flex flex-col">
      <header className="mb-6 flex items-start justify-between gap-6">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">MCP servers</h1>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            Servers this app runs over stdio and hands to the agent as tools. A project server runs only once you trust
            the configuration as it stands, and it is stopped again the moment that configuration changes.
          </p>
        </div>
        <AddServerDialog
          rootPath={rootPath}
          listing={listing}
          onAdded={(id) => {
            setNotice(null)
            void reload()
            return id
          }}
        />
      </header>

      {/* A failed read is said here, above the lists rather than inside them: nothing is wrong with any
          one server, and a row that appeared to be the problem would be pointing at the wrong thing. */}
      {error != null && (
        <p data-slot="mcp-read-error" role="alert" className="mb-4 text-[12.5px] text-destructive">
          {readErrorMessage(error)}
        </p>
      )}

      {notice && (
        <p data-slot="mcp-notice" role="alert" className="mb-4 text-[12.5px] text-destructive">
          {notice}
        </p>
      )}

      {/* What either file refused to load, reported as the file reported it: one bad record does not
          stop its siblings, and hiding it would leave a server that exists and cannot be seen. */}
      {(listing?.errors ?? []).map((entry, index) => (
        <p
          key={`${entry.scope}-${entry.id ?? index}`}
          data-slot="mcp-config-error"
          className="mb-2 text-[12.5px] text-muted-foreground"
        >
          {entry.scope === 'user' ? 'User' : 'Project'} config: {entry.message}
        </p>
      ))}

      {loading && listing === null && <p className="text-[13px] text-muted-foreground">Loading servers…</p>}

      <ScopeList
        scope="user"
        title="User servers"
        servers={listing?.user ?? []}
        empty="No servers of your own yet. A server you add here is available in every folder."
        rootPath={rootPath}
        toolCountOf={toolCountOf}
        onChanged={() => void reload()}
        onFailed={setNotice}
      />

      <ScopeList
        scope="project"
        title="Project servers"
        servers={listing?.project ?? []}
        empty={
          rootPath === null
            ? 'Open a folder to see the servers configured in it.'
            : 'This folder configures no servers.'
        }
        rootPath={rootPath}
        toolCountOf={toolCountOf}
        onChanged={() => void reload()}
        onFailed={setNotice}
      />
    </div>
  )
}

/** One scope's list, under a heading that says which scope it is. */
function ScopeList({
  scope,
  title,
  servers,
  empty,
  rootPath,
  toolCountOf,
  onChanged,
  onFailed,
}: {
  scope: 'user' | 'project'
  title: string
  servers: McpServerListing[]
  empty: string
  rootPath: string | null
  toolCountOf: (serverId: string) => number | undefined
  onChanged: () => void
  onFailed: (notice: string) => void
}) {
  return (
    <section data-slot={`mcp-scope-${scope}`} className="mb-6">
      <h2 className="mb-2 text-[12.5px] font-medium tracking-wide text-muted-foreground uppercase">{title}</h2>
      {servers.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">{empty}</p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {servers.map((server) => (
            <ServerRow
              key={`${scope}:${server.id}`}
              server={server}
              rootPath={rootPath}
              toolCount={toolCountOf(server.id)}
              onChanged={onChanged}
              onFailed={onFailed}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * One server: what it is, what state it is in, and everything that can be done to it.
 *
 * The row's own controls are the ones the design names — the enable switch, the trust grant, Start,
 * Stop, Secrets, Logs and Delete — and each is a call plus a refresh. Nothing is written into the mirror
 * directly: main owns every fact here, so the row that moves is the row main's answer moved.
 */
function ServerRow({
  server,
  rootPath,
  toolCount,
  onChanged,
  onFailed,
}: {
  server: McpServerListing
  rootPath: string | null
  /** How many tools the running server offers, or undefined when it is not running. */
  toolCount: number | undefined
  onChanged: () => void
  onFailed: (notice: string) => void
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const setEnabled = conveyor.mcp.setEnabled.useMutation()
  const setAutoApprove = conveyor.mcp.setAutoApprove.useMutation()
  const setTrust = conveyor.mcp.setTrust.useMutation()
  const start = conveyor.mcp.startServer.useMutation()
  const stop = conveyor.mcp.stopServer.useMutation()
  const remove = conveyor.mcp.removeServer.useMutation()

  const isRunning = toolCount !== undefined
  const trust = server.scope === 'project' ? trustPresentation(server.trust ?? 'absent') : null
  const startAllowed = canStartServer({ scope: server.scope, enabled: server.enabled, trust: server.trust })

  /** Run one call, then re-read both scopes — or say what the code it refused with means. */
  const run = async (call: () => Promise<unknown>) => {
    try {
      await call()
      onChanged()
    } catch (err) {
      onFailed(`${server.id}: ${actionErrorMessage(err)}`)
    }
  }

  const onToggle = (next: boolean) => {
    void run(() => setEnabled.mutateAsync({ scope: server.scope, rootPath, serverId: server.id, enabled: next }))
  }

  /**
   * Flag this server's tools as running without asking, or take the flag back.
   *
   * One field, one call, one refresh — the same shape as the switch above it. What it does *not* do is
   * start anything: the flag says how a call would be treated, not that there is anything to call.
   *
   * For a project server the answer comes back with the grant no longer matching, because the flag is
   * part of what trust covers, and the row says so and withholds Start until the user re-trusts. Nothing
   * here invents that: `startAllowed` reads the state main just reported.
   */
  const onToggleAutoApprove = (next: boolean) => {
    void run(() => setAutoApprove.mutateAsync({ scope: server.scope, rootPath, serverId: server.id, value: next }))
  }

  const onStart = () => run(() => start.mutateAsync({ scope: server.scope, rootPath, serverId: server.id }))

  const onStop = () => run(() => stop.mutateAsync({ serverId: server.id }))

  /**
   * Grant trust against the config as it stands, or take the grant back.
   *
   * Nothing but the id and the answer travels: main recomputes the hash from what is on disk, which is
   * the only way a grant can describe something the user has actually seen.
   */
  const onTrust = () =>
    run(() =>
      setTrust.mutateAsync({ rootPath: rootPath as string, serverId: server.id, trusted: server.trust !== 'matched' })
    )

  /**
   * Forget the server. A running one is stopped first.
   *
   * The stop is best-effort and its refusal is swallowed on purpose: a server that is not running is the
   * state a delete wants it in, so a refusal that says so means the work is already done. Not swallowing
   * it would leave a process behind that no file names any more and no row offers to stop.
   */
  const onConfirmDelete = async () => {
    if (isRunning) await stop.mutateAsync({ serverId: server.id }).catch(() => undefined)
    await run(() => remove.mutateAsync({ scope: server.scope, rootPath, serverId: server.id }))
    setConfirmingDelete(false)
  }

  return (
    <div
      data-slot="mcp-server-row"
      data-server-id={server.id}
      data-scope={server.scope}
      className="rounded-lg border border-border px-3.5 py-3"
    >
      {/* One line, and one that wraps. Everything with a width of its own — the id, both badges, the
          switch, every action glyph — is held at that width, and the two things that give are the command
          summary and then the running state beside it. When the fixed part is wider than the row, the
          action cluster takes a second line inside this card instead of leaving the border: an
          unshrinkable group on a non-wrapping line is a delete glyph drawn outside the row it belongs to. */}
      <div className="flex min-w-0 flex-wrap items-center gap-2.5">
        <span className="shrink-0 text-[13px] font-medium">{server.id}</span>
        <Badge variant="outline" className="shrink-0">
          {server.scope === 'user' ? 'User' : 'Project'}
        </Badge>
        {/* Beside the id rather than in the action cluster, and drawn while the flag is on: it is a fact
            about the server that stays true wherever else the user is looking on the row, and it is what
            a glance at this section — or a screenshot of it — says about whose tools run without asking. */}
        {server.autoApprove && (
          <Badge data-slot="mcp-auto-approve-badge" variant="secondary" className="shrink-0 gap-1">
            <Zap aria-hidden="true" className="size-3" />
            Auto-approve tools
          </Badge>
        )}
        {/* The middle, and the first thing to give: it grows into whatever the fixed elements leave and
            ellipsizes when that is less than the command needs. Without a flexible basis it is a
            content-sized item on an unshrinkable line, so a row whose fixed content is too wide loses the
            summary altogether rather than shortening it — which is what the badge above did to it. */}
        <code
          data-slot="mcp-command-summary"
          className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground"
          title={commandSummary(server)}
        >
          {commandSummary(server)}
        </code>

        {/* Second to give, after the summary and never before it. It sits on the line rather than inside
            the cluster below, because a group that cannot shrink cannot hold the second thing that shrinks. */}
        <span
          data-slot="mcp-running"
          data-state={isRunning ? 'running' : 'stopped'}
          className="min-w-0 truncate text-[12px] text-muted-foreground"
        >
          {isRunning ? `Running · ${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}` : 'Stopped'}
        </span>

        <div
          data-slot="mcp-row-actions"
          className="ml-auto flex max-w-full flex-none flex-wrap items-center justify-end gap-2"
        >
          <Switch
            data-slot="mcp-enabled"
            size="sm"
            aria-label={`Enable ${server.id}`}
            checked={server.enabled}
            disabled={setEnabled.isPending}
            onCheckedChange={onToggle}
          />

          {/* Its own control, not a second meaning for the switch beside it: one decides whether the
              server may run, the other whether its calls are put to the user, and a row that merged them
              would make flagging a server look like starting one. The tooltip says both things a user
              needs before pressing it — every conversation, and no, it does not start anything. */}
          <Button
            data-slot="mcp-auto-approve"
            size="icon-sm"
            variant={server.autoApprove ? 'secondary' : 'ghost'}
            aria-label={`Auto-approve tools for ${server.id}`}
            aria-pressed={server.autoApprove}
            title={
              server.autoApprove
                ? `Auto-approve is on for ${server.id}: its tools run without asking in every conversation. This does not start the server.`
                : `Let ${server.id}'s tools run without asking in every conversation. This does not start the server.`
            }
            disabled={setAutoApprove.isPending}
            onClick={() => void onToggleAutoApprove(!server.autoApprove)}
          >
            {setAutoApprove.isPending ? <Loader2 className="animate-spin" /> : <Zap />}
          </Button>

          <Button
            data-slot="mcp-start"
            size="icon-sm"
            variant="ghost"
            aria-label={`Start ${server.id}`}
            title={`Start ${server.id}`}
            disabled={!startAllowed || start.isPending}
            onClick={() => void onStart()}
          >
            {start.isPending ? <Loader2 className="animate-spin" /> : <Play />}
          </Button>
          <Button
            data-slot="mcp-stop"
            size="icon-sm"
            variant="ghost"
            aria-label={`Stop ${server.id}`}
            title={`Stop ${server.id}`}
            disabled={!isRunning || stop.isPending}
            onClick={() => void onStop()}
          >
            {stop.isPending ? <Loader2 className="animate-spin" /> : <Square />}
          </Button>

          <SecretsDialog server={server} rootPath={rootPath} onChanged={onChanged} onFailed={onFailed}>
            <Button data-slot="mcp-secrets" size="icon-sm" variant="ghost" aria-label={`Secrets ${server.id}`}>
              <KeyRound />
            </Button>
          </SecretsDialog>

          <LogsDialog server={server}>
            <Button data-slot="mcp-logs" size="icon-sm" variant="ghost" aria-label={`Logs ${server.id}`}>
              <ScrollText />
            </Button>
          </LogsDialog>

          <Button
            data-slot="mcp-delete"
            size="icon-sm"
            variant="ghost"
            aria-label={`Delete ${server.id}`}
            onClick={() => setConfirmingDelete(true)}
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      {/* Trust governs the project scope only, so the line is drawn only where it means something. */}
      {trust && (
        <div data-slot="mcp-trust" data-trust={server.trust ?? 'absent'} className="mt-2 flex items-center gap-2">
          {/* The one line that confirms what was granted, so it is the line that has to name the flag in
              words when it is on: a project server whose grant is current *and* whose tools run without
              asking is a stronger grant than either half alone, and the badge says the flag without
              saying that this folder has agreed to it. */}
          <span className="text-[12px] text-muted-foreground">
            {server.autoApprove ? `${trust.label} · its tools run without asking` : trust.label}
          </span>
          <Button
            data-slot="mcp-trust-action"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[12px]"
            disabled={setTrust.isPending || rootPath === null}
            onClick={() => void onTrust()}
          >
            {trust.actionLabel}
          </Button>
        </div>
      )}

      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {server.id}?</AlertDialogTitle>
            <AlertDialogDescription>
              {isRunning
                ? `${server.id} is running, so it is stopped first. Its configuration and its stored secrets are then removed from the ${server.scope} config file.`
                : `Its configuration and its stored secrets are removed from the ${server.scope} config file. To change a server, remove it and add it again.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              data-slot="mcp-delete-confirm"
              disabled={remove.isPending}
              onClick={() => void onConfirmDelete()}
            >
              Remove server
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** The command line as one line, for the summary a row shows without opening anything. */
function commandSummary(server: McpServerListing): string {
  return [server.command, ...server.args].join(' ')
}

/** One editable key-value row in the add dialog: a name and a value, both plain text. */
interface DraftRow {
  name: string
  value: string
}

/**
 * The form that describes a server before it exists.
 *
 * Saving does two things in one gesture, because a user who types a secret means it to be used: the
 * server joins its file, and then each secret row is stored against it through `mcp.setSecret` — the
 * call that encrypts. The order is the point: a secret can never name a server that is not there yet,
 * and nothing in the config payload is a secret, in plaintext or in ciphertext. The store's own words
 * for a refusal are derived from the code main rejects with, never from its message.
 *
 * The rules are applied here *and* again in main. Here so a refusal lands on the field it belongs to
 * rather than being discovered after a round trip; there because that is where the file is written and
 * where the list the id must be unique against actually lives.
 */
function AddServerDialog({
  rootPath,
  listing,
  onAdded,
}: {
  rootPath: string | null
  listing: { user: McpServerListing[]; project: McpServerListing[] } | null
  onAdded: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState<'user' | 'project'>('user')
  const [id, setId] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [cwd, setCwd] = useState('')
  const [envRows, setEnvRows] = useState<DraftRow[]>([])
  const [secretRows, setSecretRows] = useState<DraftRow[]>([])
  /**
   * Whether the server being added is flagged from the moment it exists, off in every new dialog.
   *
   * Reset on close like every other field: this one decides whether the server's calls will be put to
   * the user, so it is never carried over from a draft that was abandoned.
   */
  const [autoApprove, setAutoApprove] = useState(false)
  const [error, setError] = useState<{ field: 'id' | 'command' | 'secrets' | 'form'; message: string } | null>(null)

  const addServer = conveyor.mcp.addServer.useMutation()
  const setSecret = conveyor.mcp.setSecret.useMutation()

  const close = () => {
    setOpen(false)
    setId('')
    setCommand('')
    setArgs('')
    setCwd('')
    setEnvRows([])
    setSecretRows([])
    setError(null)
    setScope('user')
    setAutoApprove(false)
  }

  const onSave = async () => {
    const trimmedId = id.trim()
    const duplicate = (scope === 'user' ? listing?.user : listing?.project)?.some((server) => server.id === trimmedId)
    if (!isSafeMcpServerId(trimmedId)) {
      setError({
        field: 'id',
        message: 'Server ids are lower-case slugs — letters, digits, dots, dashes or underscores — and never a path.',
      })
      return
    }
    if (duplicate) {
      setError({ field: 'id', message: 'A server with this id already exists in this scope.' })
      return
    }
    if (command.trim() === '') {
      setError({ field: 'command', message: 'A command is required — this is what gets run.' })
      return
    }
    const secrets = secretRows.filter((row) => row.name.trim() !== '' || row.value !== '')
    const badSecret = secrets.find((row) => !isSafeMcpSecretKey(row.name.trim()))
    if (badSecret) {
      setError({
        field: 'secrets',
        message: `Secret names become environment variables: ${JSON.stringify(badSecret.name.trim())} is not one.`,
      })
      return
    }
    setError(null)

    const env = Object.fromEntries(
      envRows.filter((row) => row.name.trim() !== '').map((row) => [row.name.trim(), row.value])
    )

    try {
      await addServer.mutateAsync({
        scope,
        rootPath,
        server: {
          id: trimmedId,
          command: command.trim(),
          args: splitLines(args),
          cwd: cwd.trim() === '' ? null : cwd.trim(),
          env,
          enabled: false,
          // Sent only when it was ticked. An absent flag means off, so a server added here without it is
          // written exactly as one added before the flag existed — and nothing downstream has to tell
          // "the user turned it off" apart from "nobody has said".
          ...(autoApprove ? { autoApprove: true } : {}),
        },
      })
    } catch (err) {
      // The code, not the message: a duplicate discovered by main belongs on the id field, and every
      // other refusal is about the draft as a whole.
      if (err instanceof ConveyorError && err.code === 'MCP_SERVER_DUPLICATE') {
        setError({ field: 'id', message: 'A server with this id already exists in this scope.' })
      } else {
        setError({ field: 'form', message: `The server was not added. ${actionErrorMessage(err)}` })
      }
      return
    }

    for (const row of secrets) {
      try {
        await setSecret.mutateAsync({ scope, rootPath, serverId: trimmedId, name: row.name.trim(), value: row.value })
      } catch (err) {
        setError({
          field: 'secrets',
          message: `The server was added, but a secret was not stored. ${actionErrorMessage(err)}`,
        })
        onAdded(trimmedId)
        return
      }
    }

    close()
    onAdded(trimmedId)
  }

  return (
    <>
      <Button
        data-slot="mcp-add-open"
        size="sm"
        variant="outline"
        className="shrink-0"
        disabled={rootPath === null}
        title={rootPath === null ? 'Open a folder to add a project server' : undefined}
        onClick={() => setOpen(true)}
      >
        <Plus aria-hidden="true" />
        Add Server
      </Button>

      <AlertDialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <AlertDialogContent className="max-h-[85vh] overflow-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Add a server</AlertDialogTitle>
            <AlertDialogDescription>
              A program this app runs over stdio and asks for tools. Nothing runs until you switch the server on and —
              for a project server — trust the configuration as it stands.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="flex flex-col gap-3.5">
            <div className="flex flex-col gap-1.5">
              <Label>Scope</Label>
              {/* Two pressed buttons rather than a picker: the choice is one of two, it is stated in full
                  by both labels, and a select would hide one of the two behind a popup for no gain. */}
              <div className="flex items-center gap-2">
                {(['user', 'project'] as const).map((candidate) => (
                  <Button
                    key={candidate}
                    type="button"
                    size="sm"
                    variant={scope === candidate ? 'secondary' : 'ghost'}
                    aria-pressed={scope === candidate}
                    data-slot="mcp-add-scope"
                    onClick={() => setScope(candidate)}
                  >
                    {candidate === 'user' ? 'User' : 'Project'}
                  </Button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mcp-add-id">Server id</Label>
              <Input
                id="mcp-add-id"
                value={id}
                autoComplete="off"
                spellCheck={false}
                placeholder="filesystem"
                onChange={(event) => setId(event.target.value)}
                className="h-8 font-mono text-[12px]"
              />
              {error?.field === 'id' && (
                <p data-slot="mcp-add-id-error" role="alert" className="text-[12px] text-destructive">
                  {error.message}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mcp-add-command">Command</Label>
              <Input
                id="mcp-add-command"
                value={command}
                autoComplete="off"
                spellCheck={false}
                placeholder="npx"
                onChange={(event) => setCommand(event.target.value)}
                className="h-8 font-mono text-[12px]"
              />
              {error?.field === 'command' && (
                <p data-slot="mcp-add-command-error" role="alert" className="text-[12px] text-destructive">
                  {error.message}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mcp-add-args">Arguments</Label>
              <Textarea
                id="mcp-add-args"
                value={args}
                spellCheck={false}
                rows={3}
                placeholder={'One per line\n-y\n@modelcontextprotocol/server-filesystem'}
                onChange={(event) => setArgs(event.target.value)}
                className="font-mono text-[12px]"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mcp-add-cwd">Working directory</Label>
              <Input
                id="mcp-add-cwd"
                value={cwd}
                autoComplete="off"
                spellCheck={false}
                placeholder="Leave empty to run in the open folder"
                onChange={(event) => setCwd(event.target.value)}
                className="h-8 font-mono text-[12px]"
              />
            </div>

            {/* Off by default, and worded as what it does rather than what it is called: this is the
                one field in the dialog that decides whether the server's calls are put to the user, and a
                tick made by accident is the whole of a server running unattended. It does not start the
                server — nothing in this dialog does, and the row's Start is what does. */}
            <div className="flex items-start gap-2">
              <Checkbox
                id="mcp-add-auto-approve"
                data-slot="mcp-add-auto-approve"
                className="mt-0.5"
                checked={autoApprove}
                onCheckedChange={(value) => setAutoApprove(value === true)}
              />
              <Label htmlFor="mcp-add-auto-approve" className="text-[12.5px] font-normal">
                Auto-approve tools — its calls run without asking, in every conversation
              </Label>
            </div>

            <KeyValueRows
              legend="Environment"
              hint="Plain configuration. Visible here and stored in the config file."
              addLabel="Add environment variable"
              nameLabel="Environment"
              rows={envRows}
              onChange={setEnvRows}
            />

            <KeyValueRows
              legend="Secrets"
              hint="Encrypted with your operating system keychain. Typed once, never shown again."
              addLabel="Add secret"
              nameLabel="Secret"
              rows={secretRows}
              onChange={setSecretRows}
            />
            {error?.field === 'secrets' && (
              <p data-slot="mcp-add-secrets-error" role="alert" className="text-[12px] text-destructive">
                {error.message}
              </p>
            )}
            {error?.field === 'form' && (
              <p data-slot="mcp-add-form-error" role="alert" className="text-[12px] text-destructive">
                {error.message}
              </p>
            )}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel onClick={close}>Cancel</AlertDialogCancel>
            <Button size="sm" disabled={addServer.isPending || setSecret.isPending} onClick={() => void onSave()}>
              {(addServer.isPending || setSecret.isPending) && <Loader2 className="animate-spin" />}
              Save server
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/**
 * A block of key-value rows, used twice: once for the plaintext environment, once for secrets.
 *
 * One component rather than two blocks of markup, because the two differ in what happens to the values
 * afterwards and not in what a row *is*. The labels are numbered, which is what lets a reader — and a
 * suite — name the third row of either block.
 */
function KeyValueRows({
  legend,
  hint,
  addLabel,
  nameLabel,
  rows,
  onChange,
}: {
  legend: string
  hint: string
  addLabel: string
  nameLabel: string
  rows: DraftRow[]
  onChange: (rows: DraftRow[]) => void
}) {
  const replace = (index: number, patch: Partial<DraftRow>) =>
    onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)))

  return (
    <div className="flex flex-col gap-1.5">
      <Label>{legend}</Label>
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            aria-label={`${nameLabel} name ${index + 1}`}
            value={row.name}
            autoComplete="off"
            spellCheck={false}
            placeholder="NAME"
            onChange={(event) => replace(index, { name: event.target.value })}
            className="h-8 flex-1 font-mono text-[12px]"
          />
          <Input
            aria-label={`${nameLabel} value ${index + 1}`}
            value={row.value}
            autoComplete="off"
            spellCheck={false}
            placeholder="value"
            onChange={(event) => replace(index, { value: event.target.value })}
            className="h-8 flex-[2] font-mono text-[12px]"
          />
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove ${nameLabel.toLowerCase()} ${index + 1}`}
            onClick={() => onChange(rows.filter((_, at) => at !== index))}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <div>
        <Button type="button" size="sm" variant="ghost" onClick={() => onChange([...rows, { name: '', value: '' }])}>
          <Plus aria-hidden="true" />
          {addLabel}
        </Button>
      </div>
      <p className="text-[11.5px] text-muted-foreground">{hint}</p>
    </div>
  )
}

/** One argument per line, with blank lines dropped: the file holds a list, and a typist writes lines. */
function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * One server's secrets, as names with set markers.
 *
 * The value is the one thing this dialog never holds after it is submitted: a box is typed once, the
 * plaintext goes straight to the call that encrypts it, and what is left behind is the key and a
 * boolean. Nothing here can render a value, in either form, because nothing here is given one — the
 * listing main sends carries names and flags, and that is all.
 *
 * The markers come from main's answer rather than from local optimism: the row above refreshes after
 * each write, so the dialog re-renders with the flag the file now holds. Clearing is not a special
 * case of setting: `mcp.clearSecret` forgets the value, and the flag goes back to not set.
 */
function SecretsDialog({
  server,
  rootPath,
  onChanged,
  onFailed,
  children,
}: {
  server: McpServerListing
  rootPath: string | null
  onChanged: () => void
  onFailed: (notice: string) => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const setSecret = conveyor.mcp.setSecret.useMutation()
  const clearSecret = conveyor.mcp.clearSecret.useMutation()

  const close = () => {
    setOpen(false)
    // The drafts go with the dialog: a value typed into a box that was never submitted is not kept.
    setDrafts({})
  }

  const onSet = async (name: string) => {
    const value = drafts[name] ?? ''
    try {
      await setSecret.mutateAsync({ scope: server.scope, rootPath, serverId: server.id, name, value })
      // Dropped the moment main holds the ciphertext: the box was the only place the plaintext lived.
      setDrafts((current) => ({ ...current, [name]: '' }))
      onChanged()
    } catch (err) {
      onFailed(`${server.id}: ${actionErrorMessage(err)}`)
    }
  }

  const onClear = async (name: string) => {
    try {
      await clearSecret.mutateAsync({ scope: server.scope, rootPath, serverId: server.id, name })
      setDrafts((current) => ({ ...current, [name]: '' }))
      onChanged()
    } catch (err) {
      onFailed(`${server.id}: ${actionErrorMessage(err)}`)
    }
  }

  return (
    <>
      <span onClick={() => setOpen(true)}>{children}</span>

      <AlertDialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Secrets for {server.id}</AlertDialogTitle>
            <AlertDialogDescription>
              Values are encrypted with your operating system keychain and handed to the server as environment
              variables. They are typed once and never shown again — not here, and not in the config file.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {server.secrets.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">This server holds no secrets.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {server.secrets.map((secret) => (
                <div
                  key={secret.name}
                  data-slot="mcp-secret-row"
                  data-secret={secret.name}
                  className="flex flex-col gap-1.5"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12.5px]">{secret.name}</span>
                    <span
                      data-slot="mcp-secret-marker"
                      data-set={secret.set ? 'set' : 'unset'}
                      className="text-[11.5px] text-muted-foreground"
                    >
                      {secret.set ? 'Set' : 'Not set'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      aria-label={`New value for ${secret.name}`}
                      type="password"
                      value={drafts[secret.name] ?? ''}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={secret.set ? 'Replace the stored value' : 'Value'}
                      onChange={(event) => setDrafts((current) => ({ ...current, [secret.name]: event.target.value }))}
                      className="h-8 flex-1 font-mono text-[12px]"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Set ${secret.name}`}
                      disabled={setSecret.isPending}
                      onClick={() => void onSet(secret.name)}
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Clear ${secret.name}`}
                      disabled={!secret.set || clearSecret.isPending}
                      onClick={() => void onClear(secret.name)}
                    >
                      Clear
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel onClick={close}>Done</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/**
 * One server's stderr, as main last had it.
 *
 * Fetched when the dialog opens and when Refresh is pressed, and at no other moment: a viewer that read
 * on a timer would redraw itself while a person is reading it, and what it shows is a ring buffer of two
 * hundred lines rather than a stream. The lines are rendered in a monospaced block, one element each, so
 * a line is a line — a single `pre` holding all of them would be one text node, and nothing about it
 * could be pointed at.
 *
 * The buffer belongs to the process, so a server that is not running answers with nothing. That is said
 * plainly rather than presented as an empty log, because the two are different facts.
 */
function LogsDialog({ server, children }: { server: McpServerListing; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [lines, setLines] = useState<string[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    try {
      const answer = await conveyor.mcp.getServerLogs({ serverId: server.id })
      setLines(answer.lines)
      setFailure(null)
    } catch (err) {
      setFailure(actionErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [server.id])

  useEffect(() => {
    if (open) void fetchLogs()
  }, [open, fetchLogs])

  return (
    <>
      <span onClick={() => setOpen(true)}>{children}</span>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className="max-w-xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Logs for {server.id}</AlertDialogTitle>
            <AlertDialogDescription>
              The last lines this server wrote to standard error, oldest first. Anything that matched a stored secret is
              already replaced before it reaches this window.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {failure && (
            <p data-slot="mcp-logs-error" role="alert" className="text-[12.5px] text-destructive">
              {failure}
            </p>
          )}

          <pre
            data-slot="mcp-logs"
            data-state={lines === null ? 'loading' : lines.length === 0 ? 'empty' : 'lines'}
            className="max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap"
          >
            {lines === null
              ? 'Reading…'
              : lines.length === 0
                ? 'Nothing has been written yet.'
                : lines.map((line, index) => <div key={index}>{line}</div>)}
          </pre>

          <AlertDialogFooter>
            <Button
              data-slot="mcp-logs-refresh"
              size="sm"
              variant="outline"
              disabled={loading}
              onClick={() => void fetchLogs()}
            >
              {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Refresh logs
            </Button>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/**
 * What a failed action says, in this section's own words.
 *
 * Branched on the code and never on main's message: the code is the contract, and a message is written
 * for a log rather than for a person looking at a row. Every code here is one main already raises — no
 * new code was added for this screen — and the fallback exists because a section must say something even
 * about a failure it did not anticipate.
 */
function actionErrorMessage(error: unknown): string {
  if (error instanceof ConveyorError) {
    switch (error.code) {
      case 'MCP_SPAWN_FAILED':
        return 'The command could not be started on this machine.'
      case 'MCP_START_TIMEOUT':
        return 'The server did not answer in time.'
      case 'MCP_TRUST_MISMATCH':
        return 'This server is not trusted as it stands, so it was not started.'
      case 'MCP_CONFIG_INVALID':
        return 'This configuration is not one this app can run.'
      case 'MCP_SERVER_NOT_FOUND':
        return 'This server is no longer in its config file.'
      case 'MCP_SERVER_NOT_RUNNING':
        return 'That server is not running.'
      case 'MCP_PROTOCOL_ERROR':
        return 'The server started, but did not speak the protocol back.'
      case 'MCP_TOOL_ERROR':
        return 'The server refused a tool call.'
      case 'MCP_SERVER_DUPLICATE':
        return 'A server with this id already exists in this scope.'
      case 'MCP_SECRET_CRYPTO_FAILED':
        return 'The secret could not be encrypted on this machine.'
      default:
        return 'The action did not complete.'
    }
  }
  return 'The action did not complete.'
}

/** The same judgment for a failed read: a code means something, and it is said here rather than shown. */
function readErrorMessage(error: unknown): string {
  if (error instanceof ConveyorError && error.code === 'MCP_CONFIG_INVALID') {
    return 'This configuration could not be read, so the server lists may be incomplete.'
  }
  return 'The server lists could not be read. The last answer is still shown.'
}
