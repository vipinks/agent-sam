# Releases and versioning

This page is how a release is named, what it carries, how the updater consumes it, and the discipline the
repository applies to its own gates. It is the one page allowed to spell out the version convention; the
rest of the wiki deliberately names no release version.

## The version and the tag

A release is a semantic version and a matching git tag — `v<major>.<minor>.<patch>` — cut from `main`.
`package.json` carries the same version, and `CHANGELOG.md` gets one dated entry under a heading that
names the release and the work it covers. A release names the work since the last one, so the current
version is the record of the last phase rather than a count of features.

The release's exact names carry that version. The changelog and the latest release tag are the record of
what shipped; nothing in this wiki pins a current version, because the tag and the changelog are the
source of truth and a pinned copy would go stale between releases.

## The artifact names

For Windows, `npm run build:win` produces two artifacts:

    agent-sam-<version>-setup.exe
    Agent.Sam-<version>-win.zip

The first is an NSIS installer: per-user, with the installation directory offered rather than forced, and
a desktop shortcut. The second is the same app as a portable archive. Here `<version>` is the release
version, byte for byte what `package.json` and the tag carry. Both artifacts live on the Releases page.

macOS (`npm run build:mac`, a `.dmg`) and Linux (`npm run build:linux`, an AppImage) targets are configured
alongside the Windows pair; both are unverified by this project's own release process. The Windows build is
unsigned, so SmartScreen warns on the first run of the installer, and the update path treats an unsigned
build differently from a signed one.

## What the updater needs on a release

The updater is `electron-updater` over the GitHub publish configuration the packaging writes into the
packaged app as `app-update.yml`. A release it can use must carry `latest.yml` plus both blockmaps: the
`.blockmap` beside the installer, which is its differential baseline, and the `current.blockmap` the
completed download copies up into the updater's cache. The installer itself is the artifact those name.

The updater downloads into its own cache under `%LOCALAPPDATA%\agent-sam-updater\pending`, runs the
installer without a wizard, and comes back up. A packaged launch then sweeps the leftover setup exe, its
`.blockmap` baseline and `current.blockmap`, but only while the updater state is `idle` or `up-to-date` —
the states in which no download is being written. A file the OS still holds earns exactly one deferred
retry; nothing is created by the sweep.

A release that omits `latest.yml` or either blockmap is incomplete for this updater: the manifest is what
it reads, and the blockmaps are what its differential download and post-install sweep expect. That is a
publishing defect rather than an app defect, and it is named here because it is the failure a hand-built
release is most likely to hit.

## The gates

The local test surface is six npm scripts, run together on the final tree:

    npm run test:node
    npm run test:dom
    npm run typecheck
    npm run lint:check
    npm run format:check
    npm run vite:build:app

Their standing budgets are stated by the repository's verification policy, and every gate reports its own
wall-clock inside the command; the agent UI's tool-call timer is cumulative turn time and is not a
measurement. The full gauntlet runs once per commit, on the final tree, and no gate is rerun whose result
is already known.

CI runs the fast checks and the build in two stages. The **Verify** job runs `typecheck`, `lint:check` and
`format:check` on the Node version the workflow pins. The **Build** job, gated on Verify, runs
`vite:build:app` and `electron:build:dir` on Ubuntu, macOS and Windows, so a path-separator or
filename-case bug a single development machine would miss fails there.

## The versioning rule

The changelog is newest first, one dated heading per release, and its entries are the commits that made
the release. The earliest tags name the baseline and the rebrand; every later release names the work since
the previous one. Because a release is the record of a phase rather than a feature count, a build that
ships one large change and a build that ships twenty small ones are versioned the same way: by what
landed since the last tag.

## Where in the code

- `package.json` — the app version and the build, test and check scripts.
- `CHANGELOG.md` — the dated release record, newest first.
- `electron-builder.yml` — the artifact names, the NSIS options and the GitHub publish configuration.
- `.github/workflows/ci.yml` — the Node pin, the Verify job and the three-OS build matrix.
- `lib/main/update-cache.ts` — the updater cache layout and the startup sweep.
- `conveyor/modules/updates.ts` — the check, download and install paths.
- `conveyor/protocol/updates.ts` — the updater state vocabulary the sweep and the UI branch on.
