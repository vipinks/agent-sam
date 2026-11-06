# Getting started

This page is the shortest path from a clone to a working conversation, plus the six gates this
repository runs on its own work. It assumes a desktop machine with a folder you want an agent to work in;
nothing else is required beyond Node.js and npm.

## What you need

Node.js — the version CI pins in `.github/workflows/ci.yml` — and npm. The development workflow is
cross-platform; the Windows installer is the build this project verifies, and macOS and Linux targets are
configured but unverified.

Application data lives under the platform's app-data directory: `%APPDATA%\era` on Windows, and the
equivalent on macOS and Linux. The directory name is a storage contract rather than branding — moving it
would orphan credentials that cannot be decrypted anywhere else — so `lib/main/identity.ts` pins
`userData` to it before any store reads the disk.

## Run it from source

    git clone https://github.com/vipinks/agent-sam.git
    cd agent-sam
    npm install
    npm run dev

`npm run dev` opens the workstation with hot reload. `npm start` builds and launches the app as it will
ship (`electron-vite preview`). `npm run build:win` builds the renderer, main and preload bundles and
then packages them with electron-builder; the Windows output is the installer and the portable archive
described in [Releases and versioning](releases-and-versioning.md).

## Your first conversation

Home is the launch screen: recent projects, a folder picker and three starter prompts that swap with the
Buddy you pick. Choose a folder and the workbench opens on it — the conversation column, the drawer on the
left and the right rail. Type in the composer, or start from one of the prompts.

The first send creates the conversation and records the folder it was sent in. From then on the workspace
root follows the conversation: opening a saved conversation switches the open folder to the one it
remembers, and a switch is refused while a decision is pending rather than silently applied.

Writes and commands wait for your approval; reads are always allowed. The shield in the chat header has
two positions — **Manual** and **Auto-approve** — set per conversation. Its own wording names the
exception: MCP tools ask unless that server's own auto-approve is on. A turn's calls run in the order the
model wrote them, and the walk stops at the first call that needs a decision.

## The six gates

    npm run test:node
    npm run test:dom
    npm run typecheck
    npm run lint:check
    npm run format:check
    npm run vite:build:app

The test surface is those six scripts, run together on the final tree. `test:node` drives the protocol
and main-module suites — the agent loop, consent, plans, auto-continue, sessions, MCP, skills, providers,
pricing, memory and the terminal — with Electron stubbed so no suite touches real app data. `test:dom`
covers the wiring that only exists in a DOM: hooks and components, and whether the wiring calls the right
thing. `typecheck` runs `tsc --noEmit` over both the node and web projects, `lint:check` runs ESLint over
the repository, `format:check` runs Prettier, and `vite:build:app` proves the production build.

CI runs the three fast checks — `typecheck`, `lint:check`, `format:check` — on every push and pull request
to `main`, then builds the app on Ubuntu, macOS and Windows with `vite:build:app` followed by
`electron:build:dir`.

## Where in the code

- `package.json` — the scripts above, the app version and the repository identity.
- `.github/workflows/ci.yml` — the pinned Node version, the verify job and the three-OS build matrix.
- `lib/main/identity.ts` — the `userData` pin that keeps `%APPDATA%\era` the storage contract.
- `app/components/workbench/home-panel.tsx` — recent projects, the folder picker and the starter prompts.
- `app/components/workbench/chat-panel.tsx` — the composer, the consent shield and the first send.
- `tests/run-node-suites.mjs` — the node runner that bundles the protocol and main-module suites.
- `vitest.config.ts` — the DOM suite's runner configuration.
- `electron.vite.config.ts` — the renderer, main and preload build inputs.
