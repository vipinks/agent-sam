# Sam AI

An Electron + React + TypeScript agentic workstation.

Sam AI is a local-first desktop coding assistant. You open a folder, and an agent works inside it —
reading files, writing files, running commands — while everything that changes something waits for
your answer. Conversations, settings, and credentials stay on your machine.

## Features

- **MCP server integration.** Stdio MCP servers declared in user and project configuration are
  listed, started, and trusted one at a time. A server's command, arguments, directory, and
  environment are what its permission is really about, so that configuration is hashed when you
  trust it: a server whose file has changed since then refuses to start, and a server nobody has
  trusted never runs. Every tool call a server offers passes through the same consent gate as the
  agent's own tools, and auto-approval is granted per server.
- **Skills discovery and activation.** Skills are found in four tiers — the project's own folder, the
  user's, and the two `.agents` compatibility folders this app reads but never writes. A name
  collision resolves to the higher tier, and the skill that lost is dropped rather than offered
  beside the winner. A file that cannot be read is reported next to the skills that did load, and at
  most ten skills may be active in a conversation at once.
- **Custom LLM providers.** Any server speaking the OpenAI `chat/completions` dialect can be added:
  a base URL, a name to show in Settings, an optional key, and the models it offers. The key is
  optional because the ordinary case is a server running on your own machine.
- **Git panel.** Repository status, current branch, recent log, and per-file diffs, with staging,
  unstaging, commit, discarding worktree changes, and branch checkout.
- **File explorer with a guarded editor.** A file tree over the open workspace and an editor that
  remembers the modification time it read. If something else writes the file before you save, the
  save is refused as a conflict instead of silently discarding a version, and overwriting takes a
  second, deliberate confirmation.
- **Terminal host.** A real shell in the workspace — PowerShell on Windows, bash elsewhere — rendered
  with xterm.js. The working directory is validated to stay inside the open workspace.
- **Five themes with brightness control.** Crimson, Ocean, Forest, Amber, and Violet, each a complete
  light and dark palette. A brightness control moves a theme's colours together without disturbing
  hue or saturation, and each theme's text is checked against its own surfaces so contrast holds at
  every step.
- **Bounded auto-continue.** A turn that ends with plan steps still unfinished is picked back up
  rather than left hanging, for a bounded number of segments; each seam is marked, so you can see
  that the machine kept going and why.
- **Consent gate with pending-decision serialization.** A turn's calls run in the order the model
  wrote them and the walk stops at the first call that needs a decision — calls behind an undecided
  one neither run nor record an outcome. Decisions are answered one at a time.

## Tech stack

- **Electron** — the desktop shell, and the main process that owns the file system, the shell, the
  network, and the model calls.
- **React + TypeScript** — the renderer, in `app/`.
- **Vite** via electron-vite — dev server with hot reload, and the production build.
- **Tailwind CSS + shadcn/ui primitives** — every component and every style. Colour lives in the
  theme token stylesheet rather than in per-component files, and no second CSS framework is present.
- **electron-conveyor** — typed IPC and cross-window state, in three layers:
  `conveyor/modules/` (main-process logic), `conveyor/protocol/` (pure rules both sides share), and
  `conveyor/stores/` (state main owns and every window mirrors live).

## Installation

```shell
git clone <repository-url> sam-ai
cd sam-ai
npm install
npm start
```

`npm start` runs the built app; `npm run dev` runs it with hot reload.

Application data lives under the platform's app-data directory — `%APPDATA%\era` on Windows, and the
equivalent on macOS and Linux. Settings, encrypted provider keys, conversation transcripts, and the
mirrored store files all resolve under that directory, and the directory name is a storage contract
rather than branding: moving it would orphan credentials that cannot be decrypted elsewhere.

## Usage

- **Left rail.** The resident views, in order: the conversation, the folder it is about, and the state
  of that folder — with Settings last, since it is a place you visit and leave. The rail also collapses
  the secondary panel.
- **Drawer.** The secondary panel for the active view: the conversation list (new, resume, rename,
  search, delete), or the file tree, or the git panel.
- **Center.** The conversation with the agent, with the composer beneath it and the code viewer beside
  it. Settings and the rendered preview take the whole main area rather than a column.
- **Right rail.** Docks one panel at a time beside the conversation: the file's source, the same file
  rendered, the terminal transcript, and the tools panel.
- **Composer.** Type an instruction, mention files with `@`, attach an image or spreadsheet, choose a
  model, pick the skills to activate for this conversation, and raise or lower the auto-approve shield.
  While a turn runs, the send button becomes a stop.
- **Settings.** Providers and their keys, custom providers, MCP servers and their trust state, skills,
  themes, and application preferences.

## Architecture

Three layers, and one boundary between them. `conveyor/modules/` holds the main-process logic — the
only place that touches the file system, spawns a process, calls a provider, or starts an MCP server.
`conveyor/protocol/` holds the rules as pure data-in, data-out functions, so the decisions that matter
(trust, consent, auto-continue, which write may proceed) are provable without a filesystem, an
Electron app, or a browser. `conveyor/stores/` holds the state the main process owns and every window
mirrors. `conveyor/router.ts` registers the whole IPC surface in one place, and the renderer imports
only `type AppRouter` from it plus the typed `conveyor` client. The law that keeps the boundary real:
nothing under `app/` may import `fs`, `path`, `child_process`, or `electron` — if the renderer needs
the disk, it is a query or command in a module, never a direct call.

## Development

| Script                   | What it runs                                        |
| ------------------------ | --------------------------------------------------- |
| `npm run test:node`      | The Node suites.                                    |
| `npm run test:dom`       | The DOM suites, under vitest and jsdom.             |
| `npm run typecheck`      | `tsc --noEmit` over both the node and web projects. |
| `npm run lint:check`     | ESLint over the whole repository.                   |
| `npm run format:check`   | Prettier over the whole repository.                 |
| `npm run vite:build:app` | The production build.                               |

Those six are the gauntlet: they are run together, on the final tree, once per commit, and a change
is not ready while any one of them fails. The formatter runs over every file a change touches before
it is committed, and a commit is only made when it is green on its own.

Operations that could destroy work — a force-push, a recursive delete, a publish — are gated by a
reviewer component: each such command is approved on its own before it runs, and a refusal is a hard
stop rather than an obstacle to route around. Sam AI's own consent gate is the same discipline applied
to the agent.

## License

MIT — see [LICENSE](LICENSE).
