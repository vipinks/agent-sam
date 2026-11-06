# Buddies and themes

Buddies are persona bundles — a way of working, not a preset — and themes are the visual system the window
is drawn in. This page covers both, plus the appearance preferences and the motion rule every surface
follows.

## Buddies

A Buddy is a record: a name, a role section, the skills it turns on, the MCP servers it may use, its
starter prompts, its defaults, a description and a glyph. Three ship built in — **Writer / Editor**,
**Study Tutor** and **Analyst** — and they are pure data in the protocol, which is why no file can edit,
delete or corrupt one. The default identity is not a record at all: it is what every conversation that
named nobody runs as.

Settings has a **Buddies** section with the editor behind the records and a switch on every row. The
built-ins can be switched off but carry no pencil and no bin; the user's own records carry both, and a
draft is checked by the protocol's own rule before it is written, so a refusal is a sentence beside the
field rather than a failure to interpret. A switch writes an id in the store's disabled set, which is how
a built-in — having no record to carry a flag — is switched back on.

The header's Select carries the identity: the default first, then every Buddy that is switched on. The
choice is per conversation and locks at the first send, because before it a choice can still change and
after it a record cannot; the model and the consent shield beside it stay live. A conversation whose
Buddy was deleted since runs on under the role it was created with. When a command-line engine is selected,
the Buddy picker is disabled and shows the default identity, because a Buddy's role prompt, skills and MCP
ceiling are Sam-loop machinery an external engine never receives; switching back restores the prior Buddy.

A Buddy cannot grant itself anything. Its server list is read as an intersection with what the user has
trusted and left switched on — a ceiling, never a grant — and its role prompt is injected into its turn.
Home's starters swap with the choice.

Every Buddy draws its glyph wherever it appears: one shared registry resolves a glyph id to a lucide icon
at the settings plate, the chat header chip and the picker rows. The custom glyph picker spans 32 marks,
the three built-ins carry fitting marks, and the default identity wears the app's own logo. The growth of
the glyph set is additive, so every saved Buddy's stored glyph id keeps resolving.

## The theme registry

Five palettes ship in light and dark: **Crimson**, **Ocean**, **Forest**, **Amber** and **Violet**. A
theme is data rather than a stylesheet: the registry declares each complete palette, and the engine applies
the chosen theme by writing the document's custom properties. Every theme's text is checked against its
own surfaces for a WCAG contrast floor at every brightness step, and the accent inks are held to the same
floor at every brightness and contrast step across all five palettes and both modes.

A brightness control moves a theme's surfaces together without disturbing hue. Contrast joins brightness
as its twin: it multiplies each surface's distance from the page while the ink stays where the theme put
it, and it is applied as a multiplier on the custom properties rather than as a filter. Zero is the
identity, so a window that never touches the control renders exactly what it rendered before. The terminal
follows the same route.

## Appearance settings

Appearance holds the two preferences that are about a conversation as drawn: bubble alignment (split as it
has always been, or both sides on the same side) and the chat font preset (12.5, 13, 15 or 17 pixels, with
13 the default because that is the size a message body was already painted at). Step rows in the
transcript fold and unfold independently of the answer, and the answer itself is never folded.

## Motion

Every shipped exit shares one window with its arrival: 150 ms, ease-out. The exits mirror arrivals on
object removals — a collapsible section's fold, the composer's attachment, mention and skill chips, the
copy glyph, and a mention or command picker's dismissal. One hook keeps a closed surface mounted for its
closing window; another keeps a removed list item drawable for its exit and cancels the release if the item
comes back. Both short-circuit under reduced motion: closed is closed, nothing is left mounted for a
window, and no timer runs.

Every data-driven animation carries the reduced-motion guard its arrival has. The inventory sweep reads
every animated class string in `app/` and requires `motion-reduce:animate-none` on each, plus the stacked
variant for an animation gated on a data attribute, because a class-plus-attribute match wins on
specificity and would otherwise play the animation anyway. The working row's pulse and the select's motion
are guarded on the same terms.

## Where in the code

- `conveyor/protocol/buddies.ts` — the Buddy record, the built-ins and the draft rule.
- `conveyor/stores/buddies.ts` — the records, the disabled set and the picker source.
- `app/components/workbench/buddies-settings.tsx` — the editor and the per-row switches.
- `app/components/workbench/buddy-glyphs.ts` — the glyph registry every render site reads.
- `conveyor/protocol/appearance.ts` — bubble alignment and the chat font presets.
- `app/components/workbench/themes.ts` — the five palettes.
- `app/components/workbench/theme-engine.ts` — brightness and contrast as multipliers on custom properties.
- `app/components/workbench/motion.ts` — the 150 ms closing and leaving hooks.
- `testing/motion-inventory.test.ts` — the reduced-motion sweep over every animated class string.
