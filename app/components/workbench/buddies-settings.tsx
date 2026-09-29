/**
 * The Buddies section: the ways a conversation can be started, and the editor behind them.
 *
 * A Buddy is three things at once — a record the user can edit, a seed of session fields taken once at
 * creation, and a subset of MCP servers applied at every tool assembly — and this screen is where the
 * record is managed. It is the *advanced* surface by design: a conversation picks its Buddy from the
 * header's own Select, which is the quick path, and everything about a Buddy beyond picking one lives
 * here, one rail click away.
 *
 * Two kinds of row, and the difference is the whole shape of the screen. The three built-ins are the
 * app's own data: they are listed, they can be switched off, and there is nothing else to do to them —
 * no edit control and no delete control exists in the row at all. The user's own records carry a pencil,
 * a bin and a switch. The SamAi default is not listed, because it is the app's own behavior rather than
 * one Buddy among several.
 *
 * What a row's switch writes is an *id* in the store's disabled set, not a flag on a record, because a
 * built-in can be switched off and there is no record of one to carry a flag. The list is drawn by
 * `listBuddies`, so a row that is switched off stays on screen as an off switch — which is how it gets
 * switched back on — while a picker reading the same rows leaves it out.
 *
 * The editor writes through the store's own `addBuddy` and `updateBuddy`, and the draft is checked by
 * `checkBuddy` before either is called: a refusal is a *field*, said beside the control it belongs to and
 * in the rule's own words, rather than a failure to be interpreted. Nothing about a record is invented
 * here — the caps, the fields and the sentences are the protocol's.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  BookOpen,
  ChartColumn,
  FileText,
  GitBranch,
  KeyRound,
  Lock,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Table2,
  Trash2,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { conveyor } from '@/conveyor/client'
import { useConveyorStore } from 'electron-conveyor/react'
import {
  BUILTIN_BUDDIES,
  checkBuddy,
  isSafeBuddyId,
  listBuddies,
  MAX_BUDDY_DESCRIPTION_CHARS,
  MAX_BUDDY_ID_CHARS,
  MAX_BUDDY_NAME_CHARS,
  MAX_BUDDY_ROLE_PROMPT_CHARS,
  MAX_BUDDY_STARTER_CHARS,
  MAX_BUDDY_STARTERS,
  SAMAI_BUDDY_ID,
  type BuddyField,
  type BuddyListRow,
  type BuddyRecord,
} from '@/conveyor/protocol/buddies'
import { canStartServer } from '@/conveyor/protocol/mcp-settings'
import { buddiesStore } from '@/conveyor/stores/buddies'
import { useMcpServersStore } from '@/conveyor/stores/mcp-servers'
import { providerConfigStore } from '@/conveyor/stores/provider-config'
import { workspaceStore } from '@/conveyor/stores/workspace'
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
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Switch } from '../ui/switch'
import { Textarea } from '../ui/textarea'

/**
 * The marks a Buddy can be given, each one a lucide glyph this app already draws.
 *
 * A mark rather than an icon name, because the record's `glyph` is a character or two — that is what the
 * three built-ins carry, and a row draws the same badge for every kind of record — so what the picker
 * stores has to be the mark itself. The glyph is what the user is choosing; the icon beside it is how the
 * choice is offered, drawn from the set the app already imports rather than from a second icon library.
 */
const GLYPH_CHOICES: ReadonlyArray<{ icon: LucideIcon; mark: string }> = [
  { icon: AlertTriangle, mark: 'A' },
  { icon: BookOpen, mark: 'B' },
  { icon: ChartColumn, mark: 'C' },
  { icon: FileText, mark: 'F' },
  { icon: GitBranch, mark: 'G' },
  { icon: KeyRound, mark: 'K' },
  { icon: MessageSquare, mark: 'M' },
  { icon: Pencil, mark: 'P' },
  { icon: Search, mark: 'S' },
  { icon: Table2, mark: 'T' },
  { icon: Wrench, mark: 'W' },
  { icon: Zap, mark: 'Z' },
]

/** The value a `Select` needs for \"nothing chosen\": Radix refuses an empty string as an item's value. */
const NONE = 'none'

/** The id every new record's slug is checked against: the app's own ids, and the user's own. */
function takenIds(custom: readonly BuddyRecord[]): string[] {
  return [...BUILTIN_BUDDIES.map((buddy) => buddy.id), SAMAI_BUDDY_ID, ...custom.map((buddy) => buddy.id)]
}

/**
 * The id a new record is created under: a slug of its name, made unique.
 *
 * Derived rather than typed, because an id is a key — it is what a session record stores and what a
 * conversation is labelled by when the record is gone — and asking someone to invent a slug for their own
 * Buddy is asking them for an implementation detail. An empty name still yields a valid slug, so the first
 * refusal a user sees for a nameless draft is the *name* field rather than a complaint about an id they
 * never wrote.
 */
function newBuddyId(name: string, taken: readonly string[]): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, MAX_BUDDY_ID_CHARS)
    .replace(/[^a-z0-9]+$/, '')

  const base = isSafeBuddyId(slug) ? slug : 'buddy'
  let candidate = base
  let n = 1
  while (taken.includes(candidate)) {
    n += 1
    candidate = `${base}-${n}`
  }

  return candidate
}

/**
 * The section: the list, the switch each row carries, and the two dialogs behind it.
 *
 * The store is read through selectors rather than as a whole, so a row re-renders when a record or a switch
 * changes and not when anything else in the store does. Both writes the list owns — removing a record and
 * moving a switch — go straight to the store's own actions: main owns the state, and the row that changes
 * is the row main's answer changes.
 */
export function BuddiesSection() {
  const custom = useConveyorStore(buddiesStore, (s) => s.custom)
  const disabledIds = useConveyorStore(buddiesStore, (s) => s.disabledIds)
  const { removeBuddy, setBuddyEnabled } = useConveyorStore(buddiesStore)

  const rows = useMemo(() => listBuddies({ custom, disabledIds }), [custom, disabledIds])

  /** The record the editor is open on — `null` for a new one — or the closed state. */
  const [editing, setEditing] = useState<{ record: BuddyRecord | null } | null>(null)
  /** The id a delete is being asked about. The record is looked up rather than held, so it cannot be a stale copy. */
  const [confirming, setConfirming] = useState<string | null>(null)
  const confirmed = confirming === null ? null : (custom.find((buddy) => buddy.id === confirming) ?? null)

  return (
    <section data-slot="buddies" className="flex flex-col">
      <header className="mb-6 flex items-start justify-between gap-6">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Buddies</h1>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            A way of working a conversation can be started as: a role, the skills it begins with, and the MCP servers it
            may use — never more than you have already allowed. The app's own default, which is what a conversation that
            names nobody runs as, is not listed here.
          </p>
        </div>
        <Button data-slot="buddy-new" size="sm" variant="secondary" onClick={() => setEditing({ record: null })}>
          <Plus aria-hidden="true" />
          New Buddy
        </Button>
      </header>

      <div className="flex flex-col gap-2.5">
        {rows.map((row) => (
          <BuddyRow
            key={row.id}
            row={row}
            onEdit={() => setEditing({ record: custom.find((buddy) => buddy.id === row.id) ?? null })}
            onDelete={() => setConfirming(row.id)}
            onToggle={(enabled) => setBuddyEnabled({ id: row.id, enabled })}
          />
        ))}
      </div>

      <AlertDialog open={confirmed !== null} onOpenChange={(next) => (next ? undefined : setConfirming(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {confirmed?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The record goes, and with it the switch that named it. Conversations started as it keep the role they were
              seeded with and the server list they were given — a conversation is not changed by deleting the Buddy it
              was created as.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              data-slot="buddy-delete-confirm"
              onClick={() => {
                if (confirmed !== null) removeBuddy({ id: confirmed.id })
                setConfirming(null)
              }}
            >
              Delete Buddy
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {editing !== null && <BuddyEditor record={editing.record} onClose={() => setEditing(null)} />}
    </section>
  )
}

/**
 * One row.
 *
 * A built-in row and a custom row are one component with two controls missing, rather than two row types:
 * everything they share is drawn by the same lines, so a built-in cannot drift into looking like something
 * that can be edited. The locked badge stands where the two controls it cannot have would be — it says *why*
 * there is nothing there, which a row that simply lacked them would not.
 */
function BuddyRow({
  row,
  onEdit,
  onDelete,
  onToggle,
}: {
  row: BuddyListRow
  onEdit: () => void
  onDelete: () => void
  onToggle: (enabled: boolean) => void
}) {
  return (
    <div
      data-slot="buddy-row"
      data-buddy-id={row.id}
      data-buddy-kind={row.builtin ? 'builtin' : 'custom'}
      className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5"
    >
      <span
        data-slot="buddy-glyph"
        className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-[12px] font-medium"
      >
        {row.glyph}
      </span>

      <span data-slot="buddy-name" className="min-w-0 truncate text-[13px] font-medium">
        {row.name}
      </span>

      {row.builtin && (
        <span
          data-slot="buddy-locked"
          title="One of the app's own: it can be switched off, but not edited or deleted."
          className="flex flex-none items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
        >
          <Lock aria-hidden="true" className="size-3" />
          Locked
        </span>
      )}

      <div className="ml-auto flex flex-none items-center gap-1.5">
        {!row.builtin && (
          <>
            <Button
              data-slot="buddy-edit"
              size="icon-sm"
              variant="ghost"
              aria-label={`Edit ${row.name}`}
              title={`Edit ${row.name}`}
              onClick={onEdit}
            >
              <Pencil />
            </Button>
            <Button
              data-slot="buddy-delete"
              size="icon-sm"
              variant="ghost"
              aria-label={`Delete ${row.name}`}
              title={`Delete ${row.name}`}
              onClick={onDelete}
            >
              <Trash2 />
            </Button>
          </>
        )}

        {/* The one control every row has. Its label names the Buddy rather than the control, so a row is
            reachable by the thing it is about rather than by the position it happens to sit in. */}
        <Switch
          data-slot="buddy-enabled"
          size="sm"
          aria-label={`Enable ${row.name}`}
          checked={row.enabled}
          onCheckedChange={(value) => onToggle(value === true)}
        />
      </div>
    </div>
  )
}

/** The editor's own draft: what the boxes hold while the record they describe does not exist yet. */
interface BuddyDraft {
  name: string
  glyph: string
  description: string
  rolePrompt: string
  skillIds: string[]
  mcpIds: string[]
  providerId: string | null
  model: string | null
  autoApprove: boolean
  starters: string[]
}

/** A refusal as the screen holds it: the field the rule named, and the rule's own sentence. */
interface EditorError {
  field: BuddyField
  message: string
}

/**
 * The draft an editor opens on.
 *
 * A new record starts empty — with one blank starter row, because a list that begins with no box to type in
 * is a list nobody can add to — and an existing one starts as the record reads. The optional half is carried
 * as `null` rather than as absent sentinels, because both fields of the provider pair are chosen from a
 * `Select` that has to have *something* to show, and `null` is what "nothing chosen" means to Radix.
 */
function draftFor(record: BuddyRecord | null): BuddyDraft {
  return {
    name: record?.name ?? '',
    glyph: record?.glyph ?? GLYPH_CHOICES[0].mark,
    description: record?.description ?? '',
    rolePrompt: record?.rolePrompt ?? '',
    skillIds: [...(record?.skillIds ?? [])],
    mcpIds: [...(record?.mcpIds ?? [])],
    providerId: record?.providerId ?? null,
    model: record?.model ?? null,
    autoApprove: record?.autoApprove === true,
    starters: record === null ? [''] : [...record.starters],
  }
}

/**
 * The editor: one record, every field of it, and the rule that decides whether it may exist.
 *
 * Mounted only while it is open, so a draft cannot outlive the visit that made it — a closed editor is a
 * forgotten draft, which is what closing one means. Saving assembles the record the fields describe and puts
 * it through `checkBuddy`: a refusal is shown beside the control the rule named, in the rule's own words, and
 * nothing is written. Only a record the rule accepts reaches the store, which validates the same payload
 * again at the boundary — the field is what this screen branches on, and the store's schema is the backstop.
 *
 * The three lists it offers are read, never invented. Skills are the ones installed, as the Skills section
 * sees them; servers are the ones `canStartServer` permits, which is the same judgment that decides whether a
 * row in the MCP section may be started; and the models are the ones that provider's own catalogue last
 * answered. A Buddy narrows what the app was already allowed to do, and a list this screen made up for itself
 * would be a way to declare something that is not.
 */
function BuddyEditor({ record, onClose }: { record: BuddyRecord | null; onClose: () => void }) {
  const custom = useConveyorStore(buddiesStore, (s) => s.custom)
  const { addBuddy, updateBuddy } = useConveyorStore(buddiesStore)

  const [draft, setDraft] = useState<BuddyDraft>(() => draftFor(record))
  const [error, setError] = useState<EditorError | null>(null)

  /** Set one box, leaving the rest of the draft as it was. */
  const edit = (next: Partial<BuddyDraft>) => setDraft((current) => ({ ...current, ...next }))

  // The installed skills, flattened out of the tiers they are listed in: the editor's subject is the set of
  // ids a record may name, and which folder a skill was found in is the Skills section's question.
  const skills = conveyor.skills.listSkills.useQuery()
  const skillRows = useMemo(() => {
    const seen = new Set<string>()
    const rows: Array<{ id: string; title: string }> = []
    for (const tier of skills.data?.tiers ?? []) {
      for (const skill of tier.skills) {
        if (seen.has(skill.id)) continue
        seen.add(skill.id)
        rows.push({ id: skill.id, title: skill.title })
      }
    }
    return rows
  }, [skills.data])

  // The trusted and enabled servers, from the mirror the MCP section keeps. Refreshed on opening the
  // editor, because the mirror is only as fresh as its last read and this may be the first visit.
  const rootPath = useConveyorStore(workspaceStore, (s) => s.rootPath) ?? null
  const listing = useMcpServersStore((s) => s.listing)
  const refresh = useMcpServersStore((s) => s.refresh)
  useEffect(() => {
    void refresh(rootPath)
  }, [refresh, rootPath])

  const serverRows = useMemo(() => {
    const both = [...(listing?.user ?? []), ...(listing?.project ?? [])]
    const seen = new Set<string>()
    return both.filter((server) => {
      if (seen.has(server.id) || !canStartServer({ scope: server.scope, enabled: server.enabled, trust: server.trust }))
        return false
      seen.add(server.id)
      return true
    })
  }, [listing])

  // Both kinds of provider, because the id a record pins may be either: a model id belongs to the provider
  // that serves it, and which of the two lists that provider came from is not the record's business.
  const providers = conveyor.settings.listProviders.useQuery()
  const customProviders = useConveyorStore(providerConfigStore, (s) => s.customProviders)
  const configs = useConveyorStore(providerConfigStore, (s) => s.providers)
  const providerRows = useMemo(
    () => [
      ...(providers.data ?? []).map((provider) => ({ id: provider.id, name: provider.name })),
      ...customProviders.map((provider) => ({ id: provider.id, name: provider.name })),
    ],
    [providers.data, customProviders]
  )
  const modelRows = useMemo(
    () => (draft.providerId === null ? [] : (configs[draft.providerId]?.fetchedModels ?? [])),
    [configs, draft.providerId]
  )

  /**
   * Assemble the record the boxes describe, and hand it to the rule.
   *
   * The optional keys travel only when they were chosen, which is the record's own convention: a Buddy that
   * pins no provider must not carry a key saying it pins nothing, because each absent key already means the
   * window's own provider, no skills, no limit on servers. A model travels only beside its provider, since a
   * model id belongs to the provider that serves it and one without the other pins a pair that cannot run.
   */
  const onSave = () => {
    const starters = draft.starters.map((starter) => starter.trim()).filter((starter) => starter !== '')
    const described = {
      id: record?.id ?? newBuddyId(draft.name, takenIds(custom)),
      name: draft.name.trim(),
      glyph: draft.glyph,
      description: draft.description.trim(),
      rolePrompt: draft.rolePrompt.trim(),
      skillIds: draft.skillIds,
      mcpIds: draft.mcpIds,
      ...(draft.providerId !== null ? { providerId: draft.providerId } : {}),
      ...(draft.providerId !== null && draft.model !== null ? { model: draft.model } : {}),
      ...(draft.autoApprove ? { autoApprove: true } : {}),
      starters,
      builtin: false,
    }

    const checked = checkBuddy(described)
    if (!checked.ok) {
      setError({ field: checked.field, message: checked.message })
      return
    }

    setError(null)
    // `builtin: false` is restated rather than passed through: the rule reads a record's own flag, and the
    // store's schema refuses anything that is not literally a custom one.
    const payload = { ...checked.buddy, builtin: false as const }
    if (record === null) addBuddy(payload)
    else updateBuddy(payload)
    onClose()
  }

  return (
    <AlertDialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <AlertDialogContent className="max-h-[85vh] overflow-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>{record === null ? 'New Buddy' : `Edit ${record.name}`}</AlertDialogTitle>
          <AlertDialogDescription>
            What a conversation started as this Buddy runs as, what it begins with, and what it may use. Nothing here
            can widen what the app is already allowed to do: the servers below are the ones you have trusted and
            switched on.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* The three fields that are not boxes of their own: a payload the rule refused for a reason no control
            in this form is about. Shown first because there is no field to put them beside. */}
        <FieldError field="record" error={error} />
        <FieldError field="id" error={error} />
        <FieldError field="builtin" error={error} />

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="buddy-name">Name</Label>
            <Input
              id="buddy-name"
              data-slot="buddy-name-field"
              value={draft.name}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error?.field === 'name'}
              placeholder="Release Captain"
              onChange={(event) => edit({ name: event.target.value })}
            />
            <FieldHint>What it is called on a row. Up to {MAX_BUDDY_NAME_CHARS} characters.</FieldHint>
            <FieldError field="name" error={error} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Glyph</Label>
            <div data-slot="buddy-glyph-picker" className="flex flex-wrap gap-1.5">
              {GLYPH_CHOICES.map(({ icon: GlyphIcon, mark }) => (
                <Button
                  key={mark}
                  type="button"
                  size="icon-sm"
                  variant={draft.glyph === mark ? 'secondary' : 'ghost'}
                  aria-label={`Glyph ${mark}`}
                  title={`Glyph ${mark}`}
                  aria-pressed={draft.glyph === mark}
                  onClick={() => edit({ glyph: mark })}
                >
                  <GlyphIcon aria-hidden="true" />
                </Button>
              ))}
            </div>
            <FieldHint>The mark drawn beside the name, chosen from the glyphs this app already uses.</FieldHint>
            <FieldError field="glyph" error={error} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="buddy-description">Description</Label>
            <Input
              id="buddy-description"
              data-slot="buddy-description-field"
              value={draft.description}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error?.field === 'description'}
              placeholder="Drafts and edits prose, and says what it would cut and why."
              onChange={(event) => edit({ description: event.target.value })}
            />
            <FieldHint>One line: what this Buddy is for. Up to {MAX_BUDDY_DESCRIPTION_CHARS} characters.</FieldHint>
            <FieldError field="description" error={error} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="buddy-role-prompt">Role prompt</Label>
            <Textarea
              id="buddy-role-prompt"
              data-slot="buddy-role-prompt-field"
              className="min-h-24 text-[12.5px] leading-relaxed"
              value={draft.rolePrompt}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error?.field === 'rolePrompt'}
              placeholder="You are a careful writer and editor. Write prose that says what it means…"
              onChange={(event) => edit({ rolePrompt: event.target.value })}
            />
            <FieldHint>
              Sent ahead of every turn of a conversation started as this Buddy. Over {MAX_BUDDY_ROLE_PROMPT_CHARS}{' '}
              characters is refused rather than cut, and half a role reads as a whole one. {draft.rolePrompt.length} so
              far.
            </FieldHint>
            <FieldError field="rolePrompt" error={error} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Skills</Label>
            <div data-slot="buddy-skill-list" className="max-h-40 overflow-auto rounded-lg border border-border">
              {skillRows.length === 0 ? (
                <p className="px-2.5 py-2 text-[12px] text-muted-foreground">
                  No skills are installed. The Skills section is where they come from.
                </p>
              ) : (
                skillRows.map((skill) => (
                  <div key={skill.id} className="flex items-center gap-2 px-2.5 py-1.5">
                    <Checkbox
                      id={`buddy-skill-${skill.id}`}
                      checked={draft.skillIds.includes(skill.id)}
                      onCheckedChange={(value) =>
                        edit({
                          skillIds:
                            value === true
                              ? [...draft.skillIds, skill.id]
                              : draft.skillIds.filter((id) => id !== skill.id),
                        })
                      }
                    />
                    <Label htmlFor={`buddy-skill-${skill.id}`} className="text-[12.5px]">
                      {skill.title}
                    </Label>
                  </div>
                ))
              )}
            </div>
            <FieldHint>The skills a conversation started as this Buddy begins running.</FieldHint>
            <FieldError field="skillIds" error={error} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>MCP servers</Label>
            <div data-slot="buddy-mcp-list" className="max-h-40 overflow-auto rounded-lg border border-border">
              {serverRows.length === 0 ? (
                <p className="px-2.5 py-2 text-[12px] text-muted-foreground">
                  No trusted, enabled servers. A Buddy narrows what the app is already allowed to use, so a server it
                  has not been given cannot be named here.
                </p>
              ) : (
                serverRows.map((server) => (
                  <div key={server.id} className="flex items-center gap-2 px-2.5 py-1.5">
                    <Checkbox
                      id={`buddy-mcp-${server.id}`}
                      checked={draft.mcpIds.includes(server.id)}
                      onCheckedChange={(value) =>
                        edit({
                          mcpIds:
                            value === true
                              ? [...draft.mcpIds, server.id]
                              : draft.mcpIds.filter((id) => id !== server.id),
                        })
                      }
                    />
                    <Label htmlFor={`buddy-mcp-${server.id}`} className="text-[12.5px]">
                      {server.id}
                    </Label>
                  </div>
                ))
              )}
            </div>
            <FieldHint>
              Read as an intersection: a server named here is used only while it is trusted and switched on.
            </FieldHint>
            <FieldError field="mcpIds" error={error} />
          </div>

          {/* Provider and model are one choice made in two boxes: choosing a provider clears the model, because a
              model id belongs to the provider that serves it and a pin without one is a pair that cannot run. */}
          <div className="flex items-start gap-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="buddy-provider">Provider</Label>
              <Select
                value={draft.providerId ?? NONE}
                onValueChange={(next) => edit({ providerId: next === NONE ? null : next, model: null })}
              >
                <SelectTrigger
                  id="buddy-provider"
                  data-slot="buddy-provider"
                  aria-label="Provider"
                  className="h-8 w-full text-[12.5px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Whatever the window is set to</SelectItem>
                  {providerRows.map((provider) => (
                    <SelectItem key={provider.id} value={provider.id}>
                      {provider.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError field="providerId" error={error} />
            </div>

            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="buddy-model">Model</Label>
              <Select
                value={draft.model ?? NONE}
                disabled={draft.providerId === null || modelRows.length === 0}
                onValueChange={(next) => edit({ model: next === NONE ? null : next })}
              >
                <SelectTrigger
                  id="buddy-model"
                  data-slot="buddy-model"
                  aria-label="Model"
                  className="h-8 w-full text-[12.5px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>The provider&rsquo;s default</SelectItem>
                  {modelRows.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.name ?? model.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError field="model" error={error} />
            </div>
          </div>

          <div className="flex items-start gap-2">
            <Switch
              size="sm"
              className="mt-0.5"
              data-slot="buddy-auto-approve"
              aria-label="Auto-approve"
              checked={draft.autoApprove}
              onCheckedChange={(value) => edit({ autoApprove: value === true })}
            />
            <div className="flex flex-col gap-0.5">
              <span className="text-[13px] font-medium">Auto-approve</span>
              <FieldHint>
                Started conversations do not pause for approval while their own consent setting allows it. The setting
                stays the conversation&rsquo;s, so this only ever removes a pause it would otherwise have made.
              </FieldHint>
              <FieldError field="autoApprove" error={error} />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Starters</Label>
            <div className="flex flex-col gap-1.5">
              {draft.starters.map((starter, index) => (
                <div key={index} className="flex items-center gap-1.5">
                  <Input
                    data-slot="buddy-starter"
                    aria-label={`Starter ${index + 1}`}
                    value={starter}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Tighten this draft without losing anything it says"
                    onChange={(event) =>
                      edit({
                        starters: draft.starters.map((row, at) => (at === index ? event.target.value : row)),
                      })
                    }
                  />
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove starter ${index + 1}`}
                    title={`Remove starter ${index + 1}`}
                    onClick={() => edit({ starters: draft.starters.filter((_, at) => at !== index) })}
                  >
                    <X />
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={draft.starters.length >= MAX_BUDDY_STARTERS}
                onClick={() => edit({ starters: [...draft.starters, ''] })}
              >
                <Plus aria-hidden="true" />
                Add starter
              </Button>
              <FieldHint>
                What the composer offers at the start of the conversation. {MAX_BUDDY_STARTERS} fit a row, so{' '}
                {MAX_BUDDY_STARTERS} at most, each up to {MAX_BUDDY_STARTER_CHARS} characters.
              </FieldHint>
            </div>
            <FieldError field="starters" error={error} />
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>Cancel</AlertDialogCancel>
          {/* A plain button rather than the dialog's own action: a refusal has to leave the editor open, and a
              dialog that closed itself would take the sentence explaining the refusal away with it. */}
          <Button data-slot="buddy-save" size="sm" onClick={onSave}>
            Save Buddy
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * The rule's own sentence, beside the field it named.
 *
 * Rendered only for the field a refusal names, so at most one of these is on screen: a form that showed every
 * refusal at once would be telling the user about boxes they have not reached yet. The words are the rule's
 * rather than this screen's, because one sentence about a field is better than two that can disagree.
 */
function FieldError({ field, error }: { field: BuddyField; error: EditorError | null }) {
  if (error === null || error.field !== field) return null

  return (
    <p role="alert" data-slot={`buddy-error-${field}`} className="text-[11.5px] leading-relaxed text-destructive">
      {error.message}
    </p>
  )
}

/** The one line of explanation a field carries, muted because it is not a refusal. */
function FieldHint({ children }: { children: ReactNode }) {
  return <p className="text-[11.5px] leading-relaxed text-muted-foreground">{children}</p>
}
