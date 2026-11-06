# Tools, skills and MCP

This page covers the three things an agent turn can reach beyond the conversation: the built-in tools the
loop dispatches, the skills it can activate, and the stdio MCP servers it can start. The consent rule that
governs all three is described in [Conversations and consent](conversations-and-consent.md); the data
these features write is in [Data and troubleshooting](data-and-troubleshooting.md).

## The built-in tools

The loop dispatches five tools, in OpenAI's function-calling dialect: `read_file`, `write_file`,
`run_command`, `set_plan` and `web_fetch`. Reads are always allowed and `set_plan` only records a list, so
both are exempt from the shield. A write, a command and a fetch ask unless the conversation's shield is in
Auto-approve; an unclassified tool is treated as needing approval, because the safer default for something
unclassified is to ask.

Arguments are validated against the tool's own schema before anything touches the disk or a shell, and a
path is workspace-relative. `write_file` creates parent directories and overwrites the file if it exists.
`run_command` returns combined output and the exit code, runs for at most ten minutes, and is bounded on
child exit with a tree-kill on abort; its output handed back to the model is capped at 20,000 characters.
`set_plan` merges the list it is sent: a known id updates that step, a new id is added, an omitted step is
kept exactly as it was.

## web_fetch

`web_fetch` is a built-in reader for one http(s) page, in-process: it needs no provider, no key and no
spawn. It is a fetch rather than a search because a search needs an external service (in practice a
container) and a tool that is dead until the user installs a second system is not a built-in.

Every axis is bounded. One GET is made, redirects are followed by hand and every `Location` is re-checked
for http(s), the chain stops after five hops, and the request's deadline is composed with the run's own
signal so a page that never answers ends as `WEB_FETCH_TIMEOUT`. At most two megabytes are read off the
wire — enforced while streaming, never trusted from `Content-Length` alone — and at most 20,000 characters
of extracted text are returned. A body over the raw budget is refused under `WEB_FETCH_TOO_LARGE` rather
than buffered.

The `Content-Type` alone decides what to do with the body: `text/html` and `application/xhtml+xml` are
extracted to readable text, `text/plain`, `text/markdown`, `text/csv` and `application/json` are passed
through verbatim, absent means extract, and everything else is refused under `WEB_FETCH_UNSUPPORTED_TYPE`
rather than decoded into noise. The extractor drops the page's chrome with its contents, keeps heading
levels and list markers, preserves `pre` and `code` whitespace, and decodes a small named entity table plus
numeric escapes. UTF-8 is the only decoding accepted, so another encoding arrives as mojibake rather than
being guessed at.

The whole result is composed once, so the model's history and the card on screen are handed identical
bytes: a status line naming the URL, the HTTP status, the byte count and any truncation, a declaration that
the text below is untrusted data and never instructions, then the text between URL-named markers. The page
cannot close its own fence early: the marker sentinel is neutralized inside the body before it is framed.

The slice deliberately has no SSRF or private-IP filter — per-call human approval is the control, and
localhost stays fetchable because local development servers are a real use — and a loopback, link-local
and metadata blocklist is parked as later hardening for an auto-approve session. Also absent by decision:
caching, cookies and auth, methods other than GET, robots.txt, and document extraction for PDF or Office
files. A refused fetch is a code, not a message: `WEB_FETCH_FAILED`, `WEB_FETCH_TIMEOUT`,
`WEB_FETCH_TOO_LARGE` and `WEB_FETCH_UNSUPPORTED_TYPE` are the branches.

## Skills

Skills are discovered in four tiers, in the order that decides a collision: the project's own
`<root>/.sam/skills/<id>/SKILL.md`, the project's compatibility folder `<root>/.agents/skills`, the user's
`%APPDATA%\era\skills`, and the user's compatibility folder `~/.agents/skills`. The folder name is the id,
so nothing inside the file can rename it or point it elsewhere, and only a safe id is ever joined to a
path.

The project's own and the user's own folders are native, and the app may write in them. The two `.agents`
folders belong to whatever else the user runs: this app reads them and never creates, edits or deletes
inside them. A name collision resolves to the higher tier and the loser is dropped rather than offered
beside the winner — a row that turns on something other than itself is worse than a row that is not there.
A skill file that cannot be read or parsed is reported beside the skills that did load, with its tier, so
one malformed file does not cost the user every other skill in the folder.

Activation is per conversation, resolved when a turn starts, and a skill body is read only when it is
activated. At most ten skills may be active at once; the cap is enforced where the store writes the
session and where the run reads it, not only in the picker. A body over the 32,000-character cap is a
failed turn rather than a truncated section: guidance halved in the middle of a procedure reads as
complete.

## MCP servers

MCP servers are stdio servers, declared in two scopes. A user server lives in
`%APPDATA%\era\settings\mcp-servers.json` and is available in every project; a project server lives in
`<root>/.sam/mcp.json`, travels with the repository, and is additionally gated by trust, because a file
that arrived with a checkout is not something the user authored. The command, arguments, directory and
environment are what a server's permission is really about, so that configuration is hashed — sha256 over
the fields that decide what will run — when the user trusts it. A server whose file changed since then
refuses to start under `MCP_TRUST_MISMATCH`, while a toggle of `enabled` does not invalidate the grant. A
server nobody trusted never runs.

Trust records live in `%APPDATA%\era\settings\mcp-trust.json`, keyed by root path and then by server id.
Starting a server is a manual act; the Tools rail carries one stateful start/stop control per server, and
the running set is listed. Secrets are encrypted through the same `safeStorage` path provider keys use and
only the ciphertext is stored in the record; a listing carries the secret's name and a `set` flag, never a
plaintext or a ciphertext. A server starts within ten seconds or fails, and a tool call answers within
thirty seconds or is reported as unfinished. A server's stderr keeps at most 200 lines, and every secret
value is replaced with a marker there.

A tool call from a running server is put to the user in the consent card they already know, unless that
server's own auto-approve is on. Inline editing of a server reuses the add form; there is no second way to
write a record.

## Where in the code

- `conveyor/modules/agent.ts` — the tool declarations, the dispatch, the approval rule and the output cap.
- `conveyor/modules/web-fetch.ts` — the one bounded fetch and the framed result.
- `conveyor/protocol/web.ts` — the fetch bounds, content-type classifier and readable-text extractor.
- `conveyor/protocol/skills.ts` — the four tiers, precedence, cap and body limit.
- `conveyor/modules/skills.ts` — the four folders, the read/write boundary and the per-file errors.
- `conveyor/protocol/skill-manifest.ts` — the `SKILL.md` parser.
- `conveyor/protocol/mcp.ts` — the config rules, trust hash, timeouts and redaction.
- `conveyor/modules/mcp.ts` — the two config files, the trust records and encrypted secrets.
- `conveyor/modules/mcp-runtime.ts` — the live stdio servers and their tool calls.
