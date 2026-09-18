import { useMemo, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '../ui/input'
import { Switch } from '../ui/switch'

/** A model as a provider's catalogue describes it. */
export interface ModelEntry {
  id: string
  name?: string
}

/**
 * The fetched-model list for one provider: a filter box, then a row per model with a switch.
 *
 * Extracted from the provider card because it is the one part of Settings with real internal state
 * (the filter, and whether the list is expanded) — keeping it separate means that state is scoped
 * here rather than re-rendered with the card, and the list can be exercised on its own.
 *
 * There is no save button by design: flipping a switch calls `onToggle`, which writes straight to
 * the persisted store.
 */
export function ModelList({
  providerName,
  models,
  enabled,
  defaultOpen = false,
  onToggle,
}: {
  providerName: string
  models: ModelEntry[]
  enabled: string[]
  /** Opened automatically right after a fetch, so the thing you just asked for is visible. */
  defaultOpen?: boolean
  /** Called with the model id the user flipped. The parent owns which provider that belongs to. */
  onToggle: (modelId: string) => void
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const [filter, setFilter] = useState('')

  const enabledSet = useMemo(() => new Set(enabled), [enabled])

  /** Filter by id or label, case-insensitively — OpenRouter alone lists hundreds of entries. */
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return models
    return models.filter((m) => m.id.toLowerCase().includes(needle) || m.name?.toLowerCase().includes(needle))
  }, [models, filter])

  return (
    <div className="mt-2.5 border-t border-border pt-2.5">
      <button
        type="button"
        aria-expanded={isOpen}
        aria-label={`${isOpen ? 'Hide' : 'Show'} ${providerName} models`}
        onClick={() => setIsOpen((open) => !open)}
        className="flex w-full items-center gap-1.5 text-left text-[12px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronDown className={cn('size-3.5 transition-transform', isOpen && 'rotate-180')} />
        {models.length} models available
        <span className="ml-auto font-mono text-[10.5px]">{enabled.length} on</span>
      </button>

      {isOpen && (
        <>
          <div className="relative mt-2">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label={`Search ${providerName} models`}
              placeholder="Filter by model id…"
              spellCheck={false}
              className="h-8 pl-8 font-mono text-[12px]"
            />
          </div>

          {/* Capped height: the card must stay scannable when a provider lists hundreds. */}
          <ul
            aria-label={`${providerName} models`}
            className="mt-1.5 max-h-56 overflow-auto rounded-md border border-border"
          >
            {visible.length === 0 ? (
              <li className="px-2.5 py-2 text-[12px] text-muted-foreground">No model matches “{filter}”.</li>
            ) : (
              visible.map((model) => {
                const isOn = enabledSet.has(model.id)
                return (
                  <li
                    key={model.id}
                    className="flex items-center gap-2 border-b border-border px-2.5 py-1.5 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-[11.5px]" title={model.id}>
                        {model.id}
                      </p>
                      {model.name && model.name !== model.id && (
                        <p className="truncate text-[11px] text-muted-foreground">{model.name}</p>
                      )}
                    </div>
                    <Switch
                      size="sm"
                      checked={isOn}
                      aria-label={`${isOn ? 'Disable' : 'Enable'} ${model.id}`}
                      onCheckedChange={() => onToggle(model.id)}
                    />
                  </li>
                )
              })
            )}
          </ul>
        </>
      )}
    </div>
  )
}
