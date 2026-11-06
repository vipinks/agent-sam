# Models, providers and combos

This page is how a turn gets a model: the provider rows and their encrypted keys, the per-model facts the
composer and the cost tiles read, the searchable picker, the named combo that routes a turn down a
priority list, and the command-line engines that can answer beside the app's own loop.

## Providers

Five providers ship as rows you bring a key to: DeepSeek, OpenRouter, OpenCode, OpenAI and Anthropic.
Any server speaking the OpenAI `chat/completions` dialect can be added as a custom provider with a base
URL, a display name, a key and its models. A provider's catalogue can be fetched, and only the models you
switch on are offered for a conversation.

Keys are encrypted with the operating system keychain through `safeStorage` and never leave the main
process. Only ciphertext is written, to `userData/settings/api-keys.json`; the renderer sees whether a key
is stored, never the key itself. A system with no usable keychain refuses the operation under
`ENCRYPTION_UNAVAILABLE` rather than storing a secret in the clear.

## Per-model declarations

Three facts are declared per model on the same provider row: whether it supports images (the switch that
decides whether the composer may attach a picture for it), pricing for input, cache hits and output, and a
context-window override. The composer's vision gate reads the image declaration and refuses an attachment
for a model that is not declared to read images, naming the model. The Overview's Cost tile prices at the
declared rates; a cache hit is priced at what a cache hit costs. A context-window override belongs to the
model, while the compact point is a preference in Context settings.

## The model picker

The chat header's model control is a grouped, filterable combobox. It draws one section per provider with
matches and a **Combos** section after them, with a filter box at the top, a bounded scrolling list, and
two different empty states: a term that matched nothing is a typo to fix, while a provider that lists
nothing is a catalogue that has not been fetched. The Combos settings row uses the same component in its
single-provider mode, where the field above the picker already names the provider. Both pickers name their
chosen value in the trigger's accessible label, so the visible choice and the announced one cannot
disagree.

## Combos

A combo is a named priority list of provider/model pairs. It holds at most eight members, and a member is
exactly two strings — a provider id and a model id. Nesting is unrepresentable rather than refused: a
member cannot hold another combo because there is nowhere to put one.

A combo's id is a slug derived once from its name; a rename leaves the id alone, so a saved session that
recorded the id keeps naming the same combo after a retitle. Creation collects the name and the first
member in one write, because a combo with no members is a shape no reader accepts. Members can be
reordered, and a member already present is idempotent; the last member cannot be removed — delete the
combo instead. A member is accepted only if the registry knows that provider and model, and members are
never pruned when a provider goes away: they stay and are reported ineligible at resolve time.

The file is `userData/conveyor-stores/combos.json`. Every mutation reads the file first, applies the rule
to what the file actually says, writes atomically, and only then dispatches the new list; commands are
serialised through one promise chain so two windows editing at once cannot lose each other's change. A
corrupt file leaves the store empty and the failure held, and the next read says so rather than claiming
there are no combos.

## Routing and failover

A send through a combo walks its members in priority order. Each member gets five eligibility filters,
asked in this order: the provider exists; the model is switched on; a built-in provider holds a key;
the request fits the model's window when that window is known; and the model can see the request's images.
An absent or empty enabled list means "nothing recorded yet" rather than "everything is off", and an
unknown window is not a zero.

A member refused before a request is **skipped** and the walk moves on. A member that a request reached
and that failed with a refusal, a rate limit, a network loss, a server error or a missing key is
**failed**, and the walk moves on to the next member. Everything else **surfaces**: a reply that stopped
arriving (the model already spoke, and advancing would splice two answers together), an unknown provider,
an unavailable keychain, an image or skill the turn cannot send, and a 4xx that is not a rate limit —
a malformed request or a content refusal, which is a fact about the prompt rather than about who was
asked. A code the build has not classified also surfaces; advancing is not assumed safe.

There is no chat-request timer, so a provider that hangs simply hangs; a timeout is deliberately absent
from the failover set and is a named parked gap rather than half-built. A walk that skipped or failed a
member records the attempt on the turn, and a walk that never got an answer from any member ends the turn
as `combo_failed` with the list of what it tried. An episode captured from a combo turn that skipped or
failed a member records the member that served and the ones the walk moved on from.

## Command-line engines

Three installed CLIs can answer as engines beside the app's own loop: **ChatGPT (Codex)**, whose
non-interactive surface is a JSONL stream, and **Kimi (Moonshot)** and **OpenCode**, whose installed CLIs
answer with an ACP server. Every engine is spawned by main through one law: the binary comes from an
allowlist or a settings override that still names an allowlisted binary, the arguments are an array the
caller wrote, `shell` is stated as `false`, and the version is probed before a turn. The engine picker
locks at session start, a consent bridge carries the prompt, and engine sessions are left unpriced in the
Cost tile.

## Where in the code

- `conveyor/modules/settings.ts` — the built-in provider rows and the encrypted key file.
- `conveyor/modules/provider.ts` — the request shapes and provider failures.
- `conveyor/stores/provider-config.ts` — enabled models, catalogues, image support and model windows.
- `conveyor/protocol/combos.ts` — the combo shape, slug rule, eligibility filters and failover disposition.
- `conveyor/modules/combos.ts` — the file, the serialised mutations and the registry snapshot.
- `conveyor/stores/combos.ts` — the renderer's mirror of the combo list.
- `app/components/workbench/combos-model-picker.tsx` — the grouped, filterable picker both surfaces use.
- `app/components/workbench/combos-settings.tsx` — the combo editor and its member list.
- `conveyor/protocol/engine.ts` — the engine allowlist, permission modes and the spawn law.
- `conveyor/modules/engine.ts` — the version probe and the main-only spawn.
