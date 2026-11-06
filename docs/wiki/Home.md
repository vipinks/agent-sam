# Agent Sam wiki

Agent Sam is a local-first desktop agentic workstation for code — and for the rest of the work that
happens beside it. You open a folder and an agent works inside it: reading files, writing files, running
commands, fetching a page — while every call that changes something waits for your answer. Conversations,
settings, credentials and transcripts stay on your machine, and the models it talks to are OpenAI-dialect
providers: the ones it ships with, or any compatible endpoint you add.

## The map

- [Getting started](getting-started.md) — the shortest path from a clone to a working conversation, and
  the six gates this repository runs.
- [Conversations and consent](conversations-and-consent.md) — how a conversation is recorded, how the
  consent shield gates acting calls, how a turn ends and continues, and how messages branch or delete.
- [Workspace and panels](workspace-and-panels.md) — the open folder, the explorer and guarded editor,
  the viewers, git, the terminal, and the layout that remembers where you put things.
- [Memory and episodes](memory-and-episodes.md) — the project's four standing pages, the search and
  import around them, and the captured turns that ride the next turn's brief.
- [Models, providers and combos](models-providers-combos.md) — providers and keys, per-model
  declarations, the searchable picker, named priority lists with failover, and the command-line engines.
- [Tools, skills and MCP](tools-skills-mcp.md) — the built-in tools the agent calls, `web_fetch`, the
  four skill tiers, and the stdio MCP servers this app can trust and run.
- [Buddies and themes](buddies-and-themes.md) — persona bundles that shape a conversation, the five
  palettes and their contrast floor, appearance settings, and the motion rule.
- [Data and troubleshooting](data-and-troubleshooting.md) — where every file lives, what is encrypted,
  what is swept, and how to read a refusal by its code.
- [Releases and versioning](releases-and-versioning.md) — the artifact names, what a release must carry
  for the updater, the versioning rule, and the CI gates.

The repository's own [README](https://github.com/vipinks/agent-sam/blob/main/README.md) is the front
door, and [CHANGELOG.md](https://github.com/vipinks/agent-sam/blob/main/CHANGELOG.md) is the release
record. Every page in this wiki closes with a **Where in the code** list: the tree paths that are the
source of truth for what the page says.
