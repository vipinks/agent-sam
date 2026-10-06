# The Codex `exec --json` capture, and what it is evidence for

The two files beside this note are the **verbatim stdout** of two runs of the Codex CLI installed on this
machine, copied byte for byte: `codex-exec-capture.jsonl` and `codex-exec-tool-capture.jsonl`. They were
produced during Turn 2 of Phase 70, before any product code for this engine was authored, and they are the
only claim this repo makes about the live CLI.

## The runs, disclosed

Binary — the one the Turn 1 probe found, read from `%LOCALAPPDATA%`:

```
C:\Users\vipin\AppData\Local\OpenAI\Codex\bin\12219cbfbcbddde7\codex.exe
codex-cli 0.154.0-alpha.6.2          (its own `--version`)
```

Run 1 — the trivial prompt:

```
codex exec --json -s read-only --skip-git-repo-check "Reply with the single word: pong"
```

cwd `%TEMP%\codex-capture`, stdin `/dev/null`, exit code `0`, 31 seconds wall clock. Five lines.

Run 2 — one shell command, run for the tool vocabulary the trivial prompt does not reach:

```
codex exec --json -s read-only --skip-git-repo-check "Run the shell command 'echo hello' and reply with only its output."
```

cwd `%TEMP%\codex-capture`, stdin `/dev/null`, exit code `0`, 37 seconds wall clock. Eight lines.

Both runs used a real account and a real model call; both are non-interactive. `--skip-git-repo-check` was
passed because the working directory is not a repository, which is the CLI's own requirement rather than a
choice about the engine.

## The vocabulary these two runs prove

Event lines, by their `type`:

| `type` | what it carries | what the mapper does with it |
| --- | --- | --- |
| `thread.started` | `thread_id` | files it as the session id; emits no update |
| `turn.started` | nothing | `other` |
| `item.started` | an `item` with `status: in_progress` | `tool_call` |
| `item.completed` | an `item`, settled | `message_chunk`, `tool_call_update`, `other`, or a usage-bearing `turn.completed` |
| `turn.completed` | `usage` counters | `usage` |

Item kinds seen: `error` (a non-fatal warning about the skills context budget — reported as `other`, never
drawn), `agent_message` (prose), `command_execution` (a shell command, with `command`, `aggregated_output`
and `exit_code`). A command appears **twice**, once as `item.started` with `exit_code: null` and once as
`item.completed` with the outcome, addressed by the same `item.id`.

The usage counters: `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`,
`reasoning_output_tokens`. The mapper reads the first two, the fourth and the second as the cached half;
`cache_write_input_tokens` had no counterpart in the app's own counters and is not carried.

## What is NOT in these runs — the mapper's lenient edge

These event types and item kinds are **documented by the CLI rather than captured here**, and the mapper
handles them by rule rather than by evidence:

- `turn.failed` — never seen. Mapped to a `turn_end` with the `stream_error` cause, on the reading that a
  turn the CLI itself declared failed is an ending this app words rather than a message it prints.
- `item.updated` — never seen. Treated as the same call as `item.started`, which is the shape a CLI that
  later starts streaming output into a card would use.
- `reasoning`, `todo_list`, `web_search`, `mcp_tool_call`, `file_change` item kinds — none seen. The mapper
  turns an item kind it cannot card into `other` and **drops nothing silently**: `other` is the dialect's own
  word for "the peer said something this build has no opinion about". `reasoning` and `todo_list` are
  therefore reported rather than drawn; the three that are arguably calls would need a captured example
  before they were carded, because what a card shows is decided by what the CLI actually sends.
- Per-call **approval events**: none. In `-s read-only` the CLI runs read-only commands without asking, and
  no approval request appeared on the stream in either run. This is the evidence behind the Phase 70 decision
  recorded in the launch config: the exec stream cannot pause for a per-call decision, so this engine runs
  under a named sandbox flag instead of on the shield, and never both.

A reader who wants to extend this fixture should run the CLI the same way, with stdin closed — with an
inherited terminal it waits for a `<stdin>` block and prints nothing.
