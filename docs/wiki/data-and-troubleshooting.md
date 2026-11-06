# Data and troubleshooting

This page is where the app keeps its data, what is encrypted, what gets swept away and when, how a refusal
is read without trusting a sentence, and what the updater expects from a published release.

## Where data lives

Application data lives under the platform's app-data directory — `%APPDATA%\era` on Windows — because
`lib/main/identity.ts` pins `userData` to `<appData>/era` before any store reads it. That directory name
is a storage contract, not branding: Chromium keeps the key that protects the keychain ciphertext in
`<userData>/Local State`, so moving the directory would orphan credentials that cannot be decrypted
anywhere else.

    %APPDATA%\era\
    ├── sessions\<uuid>.json          one transcript per conversation
    ├── attachments\<sessionId>\      images a conversation's turns reference
    ├── settings\api-keys.json        provider keys, ciphertext only
    ├── settings\mcp-servers.json     the user-scope MCP servers
    ├── settings\mcp-trust.json       project-server trust records
    ├── conveyor-stores\*.json        main-owned mirrors, incl. combos.json
    └── memory\<sha256>\              the project's memory subtree
        ├── handoff.md
        ├── decisions.md
        ├── parked.md
        ├── quirks.md
        ├── index.json                the persisted inverted index
        └── episodes\<uuid>.md        one episode page per session

The key under `memory/` is a sha256 of the resolved workspace root, never a raw path segment. A project's
own files live in `<root>/.sam/mcp.json` for its MCP servers and `<root>/.sam/skills` for its skills;
`<root>/.agents/skills` and `~/.agents/skills` are the compatibility folders this app reads and never
writes. The updater's downloaded installers live outside app data, in
`%LOCALAPPDATA%\agent-sam-updater\pending`.

## What is encrypted

Provider API keys and MCP server secrets are encrypted with the operating system keychain through
`safeStorage`; only ciphertext is written to disk, and no command returns a plaintext or a ciphertext. On a
system with no usable keychain, storing a key is refused under `ENCRYPTION_UNAVAILABLE` rather than
degrading to plaintext.

Everything else — transcripts, memory pages, settings, layout stores — is local plain text or JSON. The
app is local-first, not encrypted-at-rest for conversation content.

## Retention and sweeps

Deleting a conversation removes its transcript, the attachments its turns referenced, and its episode
pages across every project; the episode removal is best-effort after the transcript, because a delete that
failed halfway must not strand bytes nothing references again. A startup sweep removes transcript files
whose session metadata is gone, and the same sweep removes orphaned episode pages, each file independently
so one locked file cannot block the rest. A temp file from an interrupted atomic write is not treated as an
orphan.

The updater's cache is swept only in `idle` and `up-to-date` — the states in which no download is being
written — and a file the OS still holds (`EPERM` or `EBUSY`) earns exactly one deferred pass five seconds
later. Nothing is created by the sweep, so a machine whose updater has never run is left byte-for-byte as
it was.

## Reading a failure

The renderer branches on `ConveyorError` codes, never on message strings: main names the failure with a
code, and the sentence a person reads is the renderer's. A few of the codes a reader will meet:

- `WORKSPACE_MISSING` — the folder a recent root or a move names is no longer there.
- `PATH_GONE` — an explorer action named a row that is no longer on disk; the tree re-reads the folder.
- `ROOT_UNREMOVABLE` — the open folder itself cannot be deleted from the explorer.
- `SESSION_CORRUPT` — a transcript exists but will not parse; it is left untouched.
- `SESSION_WRITE_FAILED` — a save failed, including a from-here delete; the delete's turns are still on
  disk and come back when the conversation is reopened.
- `MEMORY_CONFLICT`, `MEMORY_NOT_FOUND`, `MEMORY_IMPORT_FAILED`, `MEMORY_IO_ERROR` — an import hit an
  existing page, a restore had no prior revision, a paste had no sections, or a page could not be read or
  written.
- `COMBO_NOT_FOUND`, `COMBO_MEMBER_UNKNOWN`, `COMBO_LIMIT`, `COMBO_IO_ERROR` — a combo was deleted under a
  send, a member is not in the registry, the member cap was reached, or the file could not be read.
- `MCP_TRUST_MISMATCH` — a project server's configuration changed since it was trusted.
- `SKILL_NOT_FOUND`, `SKILL_PARSE_INVALID`, `SKILL_TOO_LARGE`, `SKILL_LIMIT_EXCEEDED` — a skill could not
  be resolved, read as a manifest, sent within the body cap, or added past the active cap.
- `IMAGE_ATTACH_NOT_FOUND` — a referenced image's bytes are gone; the chip says so in place of a picture.
- `WEB_FETCH_FAILED`, `WEB_FETCH_TIMEOUT`, `WEB_FETCH_TOO_LARGE`, `WEB_FETCH_UNSUPPORTED_TYPE` — the page
  could not be reached, did not answer in time, was too big, or is not a text format this tool reads.

The same rule holds for the vocabulary of an ending: a turn-ending cause is a closed set, and the UI
words it; it is not a message parsed back out of a provider's error.

## Updates and the release assets

The app checks for updates with `electron-updater` over the GitHub publish configuration the packaging
already writes, on the non-prerelease channel and only in a packaged build. The first check is delayed past
launch rather than run during it, then repeats on a four-hour interval. A download runs in the background
when the persisted auto-download preference says so. An update that has arrived is installed on quit when
the build is signed; an unsigned build takes the explicit install path instead, because an unsigned
installer is what a machine's app-control policy blocks. Either install path runs the installer without a
wizard and comes back up.

A published release has to carry `latest.yml` plus both blockmaps: the blockmap beside the downloaded
installer (its differential baseline) and the cache's `current.blockmap` that the completed download copies
up. The startup sweep removes the setup exe, its `.blockmap` baseline and `current.blockmap` once the
install has landed. A release that omits `latest.yml` or either blockmap is incomplete for this updater:
the manifest is what it reads, and the blockmaps are what its differential download and the post-install
sweep expect.

Two recovery paths are worth knowing. A silent install the OS blocks leaves a pointer to the pending
installer so the user can run it by hand, and Smart App Control enforcement is warned about before the
silent install is attempted. The Windows build is unsigned, so SmartScreen will warn on the first run of
the installer.

## Where in the code

- `lib/main/identity.ts` — the `userData` pin and the storage contract.
- `lib/main/update-cache.ts` — the updater cache, the sweep and its one deferred pass.
- `conveyor/modules/sessions.ts` — transcript files, delete retention and the startup sweeps.
- `conveyor/modules/memory.ts` — the memory subtree, episode pages and their retention.
- `conveyor/modules/settings.ts` — the encrypted provider-key file.
- `conveyor/modules/image-attachments.ts` — the per-session attachment directory.
- `conveyor/modules/updates.ts` — the update checks, the install paths and the pending install.
- `conveyor/protocol/updates.ts` — the updater state vocabulary.
- `electron-builder.yml` — the publish configuration and the packaged `app-update.yml`.
