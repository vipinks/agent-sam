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

## 6. Verification Budget (standing rules)

### 6.1 Running gates

- Invoke suites only through their npm scripts (test:node, test:dom); never wrap a test binary in an external timeout command.
- Any command that may hang must run with output redirected to a file and be polled afterwards; never await a live pipe. A killed parent leaves orphaned workers holding stdout open, and the tool call then waits forever.
- Every gate must self-report its own wall-clock inside the command: a start timestamp before, an elapsed line after, both written into the redirected log. The gate's self-reported seconds are the only valid measure of its cost.
- The duration stamped on a tool-call row in the agent UI is the cumulative wall-clock of the current turn, not the execution time of that command. It is a display, not a measurement; never diagnose a command from it.

### 6.2 Budgeting gates

- While iterating, run only the narrowest test that exercises the change (one vitest file, one node suite, one bundled harness).
- Run the full gauntlet (test:node, test:dom, typecheck, repo-wide lint, prettier, build) exactly once per commit, at the end of the turn.
- Never rerun a gate whose result is already known this turn. Harness overhead is paid per invocation, so "once per commit" is a cost rule, not merely a discipline rule.

### 6.3 Diagnosing slowness and hangs

- Before calling a gate slow or hung, consult the facts in this order: (1) the gate's self-reported seconds in its redirected log; (2) whether the command has already exited — read its output file and exit status, and list matching processes; (3) a single measurement in a plain terminal outside the agent; (4) a live CPU/disk sample, where CPU under 30 percent and disk under 10 percent rules machine saturation out entirely.
- A long tool-call timer that outlives its command is stale display, not a hang. A timer is a display; an exit code is a fact.
- If a command's self-reported duration exceeds five minutes, stop it, report the hang itself as a defect, and proceed with the remaining fast gates; do not wait it out.
- Timebox test-harness defects to two hypotheses. If unresolved, defer with a TODO comment at the defect site and a known-issue line in the commit body; never loop on harness polish that does not gate product behavior.

### 6.4 Commit and approval discipline

- Never leave verified product work uncommitted while investigating harness or runner defects; commit the product work first with fast gates only, then investigate in a follow-up turn.
- When an approval is granted for a class of commands, restate the granted scope inside each command that needs it, to avoid reviewer retries.

### 6.5 Authoring files

- Author file content with the file tool, never via a shell heredoc: a truncated heredoc leaves cat waiting on stdin forever, and the turn cannot distinguish a hang from a write.
- Any command that feeds stdin must take its input from a real redirected file; never rely on the transport to deliver a terminator.
