# AI Architectural Laws for Electron Coding Assistant

## 0. Boilerplate Context & Documentation

- Before writing any code, you MUST read the `CLAUDE.md` file in the root directory to understand the official architecture and API of the `guasam/electron-react-app` boilerplate.
- Treat `CLAUDE.md` as the technical reference manual for `electron-conveyor` and the project structure.
- Treat `AGENTS.md` as the product and architectural rules for our specific application.

## 1. Core Stack & Project Structure

- We are using the guasam/electron-react-app boilerplate.
- UI (Renderer): React 19, TypeScript, Tailwind CSS, shadcn/ui. Located in `app/`.
- Backend (Main): Node.js, Electron APIs. Located in `lib/main/`.
- IPC Bridge: electron-conveyor. Located in `conveyor/`.
- Preload: Located in `lib/preload/`. DO NOT modify the preload script; it is already perfectly configured for conveyor.

## 2. Strict IPC Boundary Enforcement

- NEVER import 'electron', 'fs', 'path', or 'child_process' in the `app/` directory.
- NEVER use raw ipcMain, ipcRenderer, or string-based channel names.
- All Node.js operations, file system access, and terminal executions MUST be defined as modules in `conveyor/modules/` and consumed via the inferred `conveyor` client in the UI.
- If you need to access the file system from React, create a `query` or `command` in a conveyor module, register it in `conveyor/router.ts`, and use the generated hook in React.

## 3. State Management

- Use electron-conveyor's `defineStore` for global, cross-window state.
- State sources of truth belong in the Main process. The renderer consumes this state via `useConveyorStore`.
- For strictly UI-only ephemeral state (like a dropdown being open), use standard React `useState`.

## 4. UI, Styling & Performance

- We are using Tailwind CSS and shadcn/ui. Do not introduce DaisyUI or other conflicting CSS frameworks.
- Never write inline CSS or separate `.css` files. All styling must be done via Tailwind utility classes.
- When building the Chat Interface, use streaming text components via conveyor's `stream()` primitive.
- CRITICAL: Ensure the DOM does not re-render the entire chat history on every new token. Use virtualization (like `react-window` or `@tanstack/react-virtual`) for the chat history list to maintain 60fps performance during long LLM streams.

## 5. Local File Access & Security

- Never hardcode file paths.
- Always use Electron's `app.getPath('userData')` for app data, or prompt the user via `dialog.showOpenDialog()` to select a workspace.
- Validate all inputs crossing the IPC boundary using `zod` schemas within your conveyor commands/queries.

## 6. Verification Budget (standing rule)

- While iterating, run only the narrowest test that exercises the change (one vitest file, one node suite, one bundled harness).
- Run the full gauntlet (test:node, test:dom, typecheck, repo-wide lint, prettier, build) exactly once per commit, at the end of the turn.
- Timebox test-harness defects to two hypotheses. If unresolved, defer with a TODO comment at the defect site and a known-issue line in the commit body; never loop on harness polish that does not gate product behavior.
- Never leave verified product work uncommitted while investigating harness or runner defects; commit the product work first with fast gates only, then investigate in a follow-up turn.
- When an approval is granted for a class of commands, restate the granted scope inside each command that needs it, to avoid reviewer retries.

## 7. Verification Budget — addendum (runner safety)

- Never wrap test binaries in an external timeout command; always invoke suites through their npm scripts (test:node, test:dom).
- Any command that may hang must run with output redirected to a file and be polled afterwards, never awaited on a live pipe: a killed parent leaves orphaned workers holding stdout open, and the tool call then waits forever.
- If a single verification command exceeds five minutes, stop it, report the hang itself as a defect, and proceed with the remaining fast gates; do not wait it out.

## 8. Verification Budget — correction (harness overhead)

- A long "Ran command" timer is often the agent's own turn overhead (reasoning passes, approval-reviewer model calls, sibling-process contention), not the command's real duration. Before diagnosing a gate as slow, measure it once in a plain terminal; if it is fast there, the gate is fine and the cost is harness overhead.
- Harness overhead is paid per gate invocation, so the budget rule "each gate at most once per commit" is a cost rule, not just a discipline rule. Never rerun a gate whose result is already known this turn.
- Machine saturation is real but distinct: confirm it with a live CPU/disk sample before acting on it. An idle sample (CPU under 30 percent, disk under 10 percent) rules saturation out entirely.
