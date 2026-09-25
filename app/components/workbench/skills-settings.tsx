/**
 * Skills: the four folders a skill may come from, and what is in each.
 *
 * Read-only, entirely. Every card shows what main found and where it found it, and the only control on
 * it opens the body — there is no edit, no delete, no copy and no availability switch on this screen,
 * because none of those exist yet. A list that offered them and then failed would be worse than a list
 * that offers what it can do.
 *
 * The two tiers a skill may be in, per scope, are drawn as separate blocks with their own headings
 * rather than merged into one list per scope: the difference between the project's own folder and a
 * compatibility folder is the whole point of the tier, and a merged list would hide it. The
 * compatibility blocks are marked read-only, which is a *tier* property and not a per-skill flag — the
 * section reads it from the tier and never from the skill, so a file inside `.agents` cannot claim to be
 * editable by saying so in its frontmatter.
 *
 * Every rule the drawing depends on — which tier wins a collision, what the counts are, which tiers are
 * read-only — is decided in `protocol/skills`, and this file only says it. Load errors are drawn beside
 * the skills that did load, each with the code main named: a folder that could not be read is worth
 * knowing about and is not a reason to hide the rest of the list.
 *
 * Expansions are per card and lazy. The list itself stays metadata-only — one read returns every
 * skill's name, path and summary, and no bodies — so opening this screen over a library of a thousand
 * skills reads one file's worth of frontmatter per skill and nothing else, and a body is read only when
 * someone asks to see it.
 */
import { useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, TriangleAlert } from 'lucide-react'
import { conveyor } from '@/conveyor/client'
import {
  isReadOnlyTier,
  tierKindOf,
  type SkillListing,
  type SkillLoadError,
  type SkillScope,
  type SkillSummary,
  type SkillTierListing,
} from '@/conveyor/protocol/skills'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { MarkdownContent } from './markdown'

export function SkillsSection() {
  const listing = conveyor.skills.listSkills.useQuery()

  return (
    <>
      <header className="mb-6">
        <h1 className="text-lg font-semibold tracking-tight">Skills</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          Skills are instructions a conversation can be given. Sam reads them from this project and from your own skills
          folders. Nothing on this screen changes them — it shows what is there, and what each one says.
        </p>
      </header>

      {listing.isPending && <p className="text-[13px] text-muted-foreground">Reading the skill folders…</p>}

      {listing.isError && <p className="text-[13px] text-muted-foreground">The skill folders could not be read.</p>}

      {listing.data && <SkillsList listing={listing.data} />}
    </>
  )
}

/**
 * The counts, then the tiers.
 *
 * The counts come from the listing rather than from counting what is below, so the two cannot disagree:
 * main already merged the tiers and knows which skills won their collisions, and a screen that recounted
 * could only ever count something else.
 */
function SkillsList({ listing }: { listing: SkillListing }) {
  const { counts } = listing

  return (
    <>
      <div
        data-slot="skills-counts"
        className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border pb-2.5 text-[12.5px] text-muted-foreground"
      >
        <span className="font-medium text-foreground">
          {counts.total} {counts.total === 1 ? 'skill' : 'skills'}
        </span>
        <span>{counts.project} project</span>
        <span>{counts.user} user</span>
        {counts.errors > 0 && (
          <span data-slot="skills-error-count" className="text-destructive">
            {counts.errors} {counts.errors === 1 ? 'error' : 'errors'}
          </span>
        )}
      </div>

      {/* Errors first, above the tiers: a file that would not load is the thing a reader needs to act on,
          and it is not part of any tier's contents. */}
      {listing.errors.length > 0 && (
        <div className="mb-5 flex flex-col gap-1.5">
          {listing.errors.map((error) => (
            <SkillErrorRow key={`${error.tier}:${error.id}`} error={error} />
          ))}
        </div>
      )}

      <div className="flex flex-col gap-6">
        {listing.tiers.map((tier) => (
          <TierBlock key={tier.tier} tier={tier} />
        ))}
      </div>
    </>
  )
}

/**
 * One folder's worth of skills.
 *
 * A tier with nothing in it is drawn as an empty block rather than omitted: an absent section would read
 * as a folder that had been deleted, and "there is nothing in your user skills folder" is exactly the
 * thing a reader is here to find out.
 */
function TierBlock({ tier }: { tier: SkillTierListing }) {
  const readOnly = isReadOnlyTier(tier.tier)

  return (
    <section data-slot={`skills-tier-${tier.tier}`}>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-[13px] font-medium">
          {tier.scope === 'project' ? 'Project' : 'User'} · {tierKindOf(tier.tier)}
        </h2>
        {readOnly && (
          <Badge variant="outline" className="text-[10.5px] text-muted-foreground">
            read-only
          </Badge>
        )}
      </div>
      {/* The muted path is the tier's own folder, so a reader can see where this block came from without
          expanding anything. */}
      {tier.sourceDir && (
        <p className="mb-2 truncate text-[11px] text-muted-foreground" title={tier.sourceDir}>
          {tier.sourceDir}
        </p>
      )}

      {tier.skills.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">No skills in this folder.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {tier.skills.map((skill) => (
            <SkillCard key={skill.id} skill={skill} />
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * One skill, and the one thing it can do.
 *
 * The body is fetched when the card is opened and not before. `enabled` is what keeps that promise: the
 * query is declared on every card, as hooks must be, and only the expanded one is ever asked for.
 */
function SkillCard({ skill }: { skill: SkillSummary }) {
  const [expanded, setExpanded] = useState(false)
  const kind = tierKindOf(skill.tier)
  const body = conveyor.skills.getSkillBody.useQuery({
    input: { scope: skill.scope, tier: kind, skillId: skill.id },
    enabled: expanded,
    retry: false,
  })

  return (
    <div data-slot="skill-card" data-skill-id={skill.id} className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium">{skill.title}</p>
          <p className="truncate text-[11px] text-muted-foreground" title={skill.sourcePath}>
            {skill.sourcePath}
          </p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{skill.summary || skill.id}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge variant="secondary" className="text-[10.5px]">
            {skill.scope}
          </Badge>
          <Badge variant="outline" className="text-[10.5px]">
            {kind}
          </Badge>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-[11.5px]"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${skill.title}`}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            {expanded ? 'Collapse' : 'Expand'}
          </Button>
        </div>
      </div>

      {expanded && (
        <div data-slot="skill-body" className="mt-3 border-t border-border pt-3">
          {body.isPending && (
            <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Reading {skill.id}…
            </p>
          )}
          {body.isError && (
            <p className="text-[12px] text-muted-foreground">This skill&rsquo;s file could not be read.</p>
          )}
          {body.data && (
            /*
              The app's own renderer, the same one the transcript and the file preview use. A second
              markdown view here would be a second set of behaviours to keep in step with this one.
            */
            <div className="max-h-96 overflow-auto text-[12.5px]">
              <MarkdownContent content={body.data.body} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** A file that could not be read, in the module's own words, with the code it was named. */
function SkillErrorRow({ error }: { error: SkillLoadError }) {
  return (
    <div data-slot="skill-error" className="flex items-start gap-2 rounded-lg border border-destructive/35 px-3 py-2">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block text-[12.5px] text-foreground">{error.id}</span>
        <span className="block text-[11.5px] text-muted-foreground">
          {scopeLabel(error.scope)} · {error.tier} — {error.message} ({error.code})
        </span>
      </span>
    </div>
  )
}

/** How a scope reads in a sentence, said once so the error row and anything later agree. */
function scopeLabel(scope: SkillScope): string {
  return scope === 'project' ? 'this project' : 'your skills folder'
}
