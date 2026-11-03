import { useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { conveyor } from '@/conveyor/client'
import { ConveyorError, useConveyorStore } from 'electron-conveyor/react'
import { combosStore } from '@/conveyor/stores/combos'
import { MAX_COMBO_MEMBERS, type Combo, type ComboMember } from '@/conveyor/protocol/combos'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Badge } from '../ui/badge'
import { Switch } from '../ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../ui/alert-dialog'

/**
 * The Combos section: the list the chat picker offers, and everything about one.
 *
 * Built only from the primitives the rest of Settings uses — there is no combos-specific CSS and no
 * second way to draw a list, a field or a confirmation. The rules live in `protocol/combos` and the
 * file in `modules/combos`; this is the surface that names them, and every refusal is worded from the
 * `COMBO_*` code rather than from the sentence main wrote.
 *
 * A combo is a priority list: the first member a request can use answers it, and a member the current
 * request cannot use is skipped with a code. That is why the member rows carry up/down controls and
 * why adding is two selects (provider, then that provider's models) rather than a free-text field —
 * the registry is the authority on what a combo may name, and a typed id would be a second one.
 */

/** What each `COMBO_*` refusal means to a person, branched on the code. */
const COMBO_REFUSAL_WORDING: Record<string, string> = {
  COMBO_NOT_FOUND: 'That combo is no longer there. Its last saved state is shown instead.',
  COMBO_ID_TAKEN: 'That name collides with another combo. Try a different one.',
  COMBO_EMPTY: 'A combo needs a name and at least one member.',
  COMBO_MEMBER_UNKNOWN: 'That provider or model is not known here.',
  COMBO_LIMIT: `A combo can hold at most ${MAX_COMBO_MEMBERS} members.`,
  COMBO_IO_ERROR: 'The combos file could not be read or written, so nothing was changed.',
}

/** One refusal, in the user's terms. An unrecognised code still says the change did not land. */
export function comboRefusalWord(code: string): string {
  return COMBO_REFUSAL_WORDING[code] ?? 'That change was not saved.'
}

/** A provider and the models a combo may name for it, as the registry reports them. */
interface ComboTarget {
  providerId: string
  providerName: string
  models: string[]
}

export function CombosSection() {
  const combos = useConveyorStore(combosStore, (s) => s.combos) ?? []
  const targets = conveyor.combos.knownTargets.useQuery()
  const rows = targets.data ?? []

  return (
    <>
      <header className="mb-6">
        <h1 className="text-lg font-semibold tracking-tight">Combos</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          A combo is an ordered list of provider and model pairs. A turn walks it from the top: the first member this
          request can use answers it, and a member it cannot use is skipped with a reason. Offered after the plain
          models in the chat picker.
        </p>
      </header>

      <NewCombo targets={rows} />

      <div data-slot="combo-list" className="mt-4 flex flex-col gap-2.5">
        {combos.length === 0 ? (
          <p data-slot="combo-empty" className="text-[12.5px] text-muted-foreground">
            No combos yet. Name one above and give it its first provider and model.
          </p>
        ) : (
          combos.map((combo) => <ComboCard key={combo.id} combo={combo} targets={rows} />)
        )}
      </div>
    </>
  )
}

/** Create a combo and its first member in one step: a combo cannot exist with none. */
function NewCombo({ targets }: { targets: ComboTarget[] }) {
  const create = conveyor.combos.create.useMutation()
  const [name, setName] = useState('')
  const [providerId, setProviderId] = useState('')
  const [modelId, setModelId] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)

  const ready = name.trim() !== '' && providerId !== '' && modelId !== ''
  const submit = async () => {
    if (!ready) return
    try {
      await create.mutateAsync({ name: name.trim(), providerId, modelId })
      setName('')
      setProviderId('')
      setModelId('')
      setRefusal(null)
    } catch (error: unknown) {
      setRefusal(error instanceof ConveyorError ? comboRefusalWord(error.code) : 'That combo was not created.')
    }
  }

  return (
    <section data-slot="combo-create" className="rounded-lg border border-border bg-card/40 px-3.5 py-3">
      <h2 className="text-[13px] font-medium">New combo</h2>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div className="flex min-w-44 flex-1 flex-col gap-1.5">
          <Label htmlFor="combo-new-name">Name</Label>
          <Input
            id="combo-new-name"
            value={name}
            placeholder="Fast answers"
            className="text-[12.5px]"
            onChange={(event) => {
              setName(event.target.value)
              setRefusal(null)
            }}
          />
        </div>
        <TargetSelects
          targets={targets}
          providerId={providerId}
          modelId={modelId}
          idPrefix="combo-new"
          onProvider={(next) => {
            setProviderId(next)
            setModelId('')
            setRefusal(null)
          }}
          onModel={(next) => {
            setModelId(next)
            setRefusal(null)
          }}
        />
        <Button size="sm" variant="outline" disabled={!ready || create.isPending} onClick={() => void submit()}>
          <Plus aria-hidden className="size-3.5" />
          Add combo
        </Button>
      </div>
      {refusal !== null && (
        <p data-slot="combo-create-refusal" role="alert" className="mt-2 text-[12.5px] text-destructive">
          {refusal}
        </p>
      )}
    </section>
  )
}

/** One combo: its name, its switch, its members in priority order, and the ways to change them. */
function ComboCard({ combo, targets }: { combo: Combo; targets: ComboTarget[] }) {
  const rename = conveyor.combos.rename.useMutation()
  const setEnabled = conveyor.combos.setEnabled.useMutation()
  const reorder = conveyor.combos.reorder.useMutation()
  const addMember = conveyor.combos.addMember.useMutation()
  const removeMember = conveyor.combos.removeMember.useMutation()
  const remove = conveyor.combos.delete.useMutation()

  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState(combo.name)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [providerId, setProviderId] = useState('')
  const [modelId, setModelId] = useState('')

  const atLimit = combo.members.length >= MAX_COMBO_MEMBERS

  const run = async (task: () => Promise<unknown>, fallback: string) => {
    try {
      await task()
      setRefusal(null)
    } catch (error: unknown) {
      setRefusal(error instanceof ConveyorError ? comboRefusalWord(error.code) : fallback)
    }
  }

  const saveName = () =>
    void run(async () => {
      await rename.mutateAsync({ id: combo.id, name: draftName })
      setEditing(false)
    }, 'That name was not saved.')

  const providerName = (id: string) => targets.find((target) => target.providerId === id)?.providerName ?? id

  return (
    <section
      data-slot="combo-row"
      data-combo-id={combo.id}
      className="rounded-lg border border-border bg-card/40 px-3.5 py-3"
    >
      <div className="flex items-baseline justify-between gap-3">
        {editing ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Input
              aria-label={`Rename ${combo.name}`}
              value={draftName}
              className="text-[12.5px]"
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') saveName()
                if (event.key === 'Escape') setEditing(false)
              }}
            />
            <Button size="sm" variant="outline" disabled={rename.isPending} onClick={saveName}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <h2 data-slot="combo-name" className="truncate text-[13px] font-medium">
              {combo.name}
            </h2>
            <Badge variant="secondary" className="shrink-0">
              {combo.members.length} of {MAX_COMBO_MEMBERS}
            </Badge>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Rename ${combo.name}`}
              onClick={() => {
                setDraftName(combo.name)
                setEditing(true)
              }}
            >
              Rename
            </Button>
          </div>
        )}

        <div className="flex shrink-0 items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted-foreground">
            <Switch
              size="sm"
              checked={combo.enabled}
              aria-label={`Offer ${combo.name} in the picker`}
              onCheckedChange={(enabled) =>
                void run(() => setEnabled.mutateAsync({ id: combo.id, enabled }), 'That switch was not saved.')
              }
            />
            Offered
          </label>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="icon-xs" variant="ghost" aria-label={`Delete ${combo.name}`}>
                <Trash2 />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {combo.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  The combo is removed. A conversation that used it keeps its transcript; the next request walks
                  whatever the header names instead.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => void run(() => remove.mutateAsync({ id: combo.id }), 'That combo was not deleted.')}
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <ol data-slot="combo-members" className="mt-2 flex flex-col gap-1">
        {combo.members.map((member, index) => (
          <li
            key={`${member.providerId}::${member.modelId}`}
            data-slot="combo-member"
            className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
              {providerName(member.providerId)} · {member.modelId}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Move ${member.modelId} up`}
              disabled={index === 0 || reorder.isPending}
              onClick={() =>
                void run(
                  () => reorder.mutateAsync({ id: combo.id, from: index, to: index - 1 }),
                  'That order was not saved.'
                )
              }
            >
              <ArrowUp />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Move ${member.modelId} down`}
              disabled={index === combo.members.length - 1 || reorder.isPending}
              onClick={() =>
                void run(
                  () => reorder.mutateAsync({ id: combo.id, from: index, to: index + 1 }),
                  'That order was not saved.'
                )
              }
            >
              <ArrowDown />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Remove ${member.modelId}`}
              disabled={combo.members.length <= 1 || removeMember.isPending}
              onClick={() =>
                void run(() => removeMember.mutateAsync({ id: combo.id, ...member }), 'That member was not removed.')
              }
            >
              <Trash2 />
            </Button>
          </li>
        ))}
      </ol>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <TargetSelects
          targets={targets}
          providerId={providerId}
          modelId={modelId}
          idPrefix={`combo-add-${combo.id}`}
          onProvider={(next) => {
            setProviderId(next)
            setModelId('')
            setRefusal(null)
          }}
          onModel={setModelId}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={atLimit || providerId === '' || modelId === '' || addMember.isPending}
          aria-label={`Add member to ${combo.name}`}
          onClick={() =>
            void run(async () => {
              await addMember.mutateAsync({ id: combo.id, providerId, modelId })
              setModelId('')
            }, 'That member was not added.')
          }
        >
          <Plus aria-hidden className="size-3.5" />
          Add member
        </Button>
        {atLimit && <span className="text-[12px] text-muted-foreground">This combo is full.</span>}
      </div>

      {refusal !== null && (
        <p data-slot="combo-refusal" role="alert" className="mt-2 text-[12.5px] text-destructive">
          {refusal}
        </p>
      )}
    </section>
  )
}

/**
 * The two selects that name a member: first the provider, then that provider's models.
 *
 * One component for the create form and the add-member row because the rule is one rule: a model list
 * belongs to the provider above it, and changing the provider clears a model that belonged to the old
 * one. A free-text field would let a combo name something the registry has never heard of, and the
 * member guard would refuse it only after the round trip.
 */
function TargetSelects({
  targets,
  providerId,
  modelId,
  idPrefix,
  onProvider,
  onModel,
}: {
  targets: ComboTarget[]
  providerId: string
  modelId: string
  idPrefix: string
  onProvider: (providerId: string) => void
  onModel: (modelId: string) => void
}) {
  const models = targets.find((target) => target.providerId === providerId)?.models ?? []

  return (
    <>
      <div className="flex min-w-36 flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-provider`}>Provider</Label>
        <Select value={providerId} onValueChange={onProvider}>
          <SelectTrigger id={`${idPrefix}-provider`} aria-label="Provider">
            <SelectValue placeholder="Choose a provider" />
          </SelectTrigger>
          <SelectContent>
            {targets.map((target) => (
              <SelectItem key={target.providerId} value={target.providerId}>
                {target.providerName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex min-w-44 flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-model`}>Model</Label>
        <Select value={modelId} onValueChange={onModel} disabled={providerId === ''}>
          <SelectTrigger id={`${idPrefix}-model`} aria-label="Model">
            <SelectValue placeholder={providerId === '' ? 'Choose a provider first' : 'Choose a model'} />
          </SelectTrigger>
          <SelectContent>
            {models.map((model) => (
              <SelectItem key={model} value={model}>
                <span className="font-mono">{model}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
  )
}

/** The member list of one combo, exported for the pure row rules a suite may want to pin. */
export function comboMemberLabel(member: ComboMember, targets: ComboTarget[]): string {
  const name = targets.find((target) => target.providerId === member.providerId)?.providerName ?? member.providerId
  return `${name} · ${member.modelId}`
}
