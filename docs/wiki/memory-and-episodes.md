# Memory and episodes

Memory is the project's standing notes plus the record of completed turns: four canonical pages a project
maintains, a persisted search index over them, a pasted-handoff import, and one episode page per session
whose newest blocks ride the next turn's brief. It is the memory the app reads at the start of every turn,
not a transcript replayed into the prompt.

## The four pages

The canonical pages are **Handoff**, **Decisions**, **Parked** and **Quirks**. They live per project under
`userData/memory/<project-key>/`, where the key is a sha256 of the resolved workspace root rather than a
raw path segment, so no caller shapes a directory name. The files are `handoff.md`, `decisions.md`,
`parked.md`, `quirks.md`, beside `index.json`; episode pages live under `episodes/`.

The Memory resident in the right rail reads, edits, searches and imports these pages. Writing an existing
page supersedes it rather than overwriting it silently: the prior text is retained as that page's previous
revision, and **Restore** reverts to it, which is why Restore asks before it acts. A write is
temp-then-rename, like the transcript save, so a reader sees the old bytes or the new ones. A page over
the read cap is refused with `MEMORY_IO_ERROR` rather than truncated.

## Search and the index

Search is an inverted index built from the four pages: lowercase alphanumeric tokens, each mapped to the
pages and positions it occurs at. The index is persisted in `index.json` with the memory tree's mtime;
`ensureMemoryIndex` rebuilds it when the tree has moved and reads it off disk when it has not, so a launch
over an untouched tree does not re-tokenise every page. Every page write and every capture moves the tree,
so the next read rebuilds once and then settles.

A search needs at least two characters. A page matches when every word of the term occurs in it, so a
two-word query narrows rather than widens. Results carry a match count and up to three excerpts of about
120 characters each, centred on different matches, with an ellipsis where a side was cut.

## Import

**Import** takes a pasted handoff, not a chosen file. The sanitizer runs before the fan-out, so a secret
in the paste never reaches a page: API keys, Bearer and Basic credentials, credential assignments,
credential-shaped environment names, the hyphenated token prefixes issued today, URL userinfo, PEM private
keys and paths under the home directory are replaced with markers. The paste is cut to a byte cap before
any of that work, so the sanitizer is bounded too.

The document is split at its `#` headings. A heading that names one of the four pages, or its singular,
maps that block to that page; the preamble before any heading belongs to Handoff; a heading nothing
recognises is dropped rather than written somewhere. Blocks for the same page are joined with a blank
line. An import that would touch an existing page is refused under `MEMORY_CONFLICT` and writes nothing;
the dialog then offers **Supersede**, which writes the sections and keeps the prior revisions as the undo.
A paste with no recognisable section fails under `MEMORY_IMPORT_FAILED`.

## Episodes

Episodic capture records the shape of a completed turn, not its contents. With **Capture** on — the switch
in the Memory panel, on by default because capture is local, sanitized and bounded — every completed
assistant turn contributes one block to that session's own page under
`userData/memory/<project-key>/episodes/<uuid>.md`. A block carries a marker with the turn id and capture
time, the nearest preceding question (collapsed to one line and cut to 240 characters), the tools by name
and status (at most 12 named, the rest counted), how the turn ended, and the combo that served it when one
did. It never carries an output, an argument, a plan title, an error or an image.

A block is sanitized and cut to 1024 bytes as a whole. A page keeps at most 40 whole blocks, newest first,
and at most 128 KB; past the cap the oldest whole blocks are dropped rather than truncated. A re-save of
the same turn replaces its block in place rather than appending a second one. Writes to one page are
serialised through a promise chain, and the write itself is temp-then-rename.

Capture is fire-and-forget after the transcript's atomic write has landed. It is deliberately unable to
fail the save: consent off, a conversation with no project, no completed answer, or a genuine failure all
resolve quietly, with a failure logged as one bounded warning carrying its code. A turn whose call is
still running, awaiting or queued is not a completed turn and is not captured; an interrupted turn is,
because its calls are settled even though the turn was stopped.

The Memory panel draws the captured rows read-only, newest first by the brief's own ordering: capture time
descending, then session id, then the ordinal within that session. The rows preview what the next turn
would carry; an episode is an artifact of a turn, not a page a user edits.

## The turn-start brief

The brief is read fresh at the turn start and injected once. Its sections run in a fixed order — Handoff,
Pending vetoes, Recent decisions, Quirks — and an empty section is omitted rather than emitted as a bare
heading. Parked is deliberately not in the brief: it is what the project set aside, not what it is working
from.

Captured episodes are appended as the last section, up to the newest five, and only whole blocks: a block
that does not fit the episode sub-budget is skipped rather than cut, because half a block would say an
episode happened without saying which one. The whole brief is capped at 8192 bytes; when episodes exist
the canonical body is cut to the remainder first, so a project that wrote a novel into its handoff cannot
evict the newest captured work. A resumed conversation whose history already carries the exact brief is not
given it twice.

## Retention and the named residual

Deleting a conversation removes its episode pages across every project — a conversation moved between
folders keeps the page it captured under the folder it worked in — and a startup sweep removes episode
pages whose session metadata is gone, beside the transcript sweep. The from-here delete prunes the blocks
its range captured after the transcript write lands.

The residual: **episode ordinals skip after a from-here delete.** A block's heading keeps the ordinal it
was captured at, and pruning rewrites the page without renumbering survivors, so deleting a middle turn
leaves the blocks after it numbered `5`, `6` and so on rather than closing the gap. That is deliberate —
renumbering would make the page claim those turns happened where they never did — but it means the
ordinals are capture positions rather than a contiguous count.

## Where in the code

- `conveyor/protocol/memory.ts` — the pages, the index, search, sanitization, the import fan-out and the
  brief's ordering and budgets.
- `conveyor/protocol/episodes.ts` — extraction, rendering, parsing, ordering and the page caps.
- `conveyor/modules/memory.ts` — the filesystem, the index lifecycle, capture, pruning and retention.
- `conveyor/stores/memory.ts` — the page summaries, the episode rows and the capture switch.
- `app/components/workbench/memory-panel.tsx` — the four tabs, search, import, restore and the capture
  switch.
- `conveyor/modules/sessions.ts` — the save hook that captures and prunes episodes.
- `tests/memory/episodes-test.ts` — the pinned ordinal and prune behaviour.
