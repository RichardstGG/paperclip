# Paperclip Adapters for Hermes Agent

A [Paperclip](https://paperclip.ing) adapter package that lets you run [Hermes Agent](https://github.com/NousResearch/hermes-agent) as a managed employee in a Paperclip company.

Hermes Agent is a full-featured AI agent by [Nous Research](https://nousresearch.com) with 30+ native tools, persistent memory, session persistence, 80+ skills, MCP support, and multi-provider model access.

This package owns both built-in Hermes adapter types:

- `hermes_local` runs the local Hermes CLI as a child process. The package root exports remain compatible with the original local adapter.
- `hermes_gateway` calls an already-running Hermes API server over HTTP/SSE. Gateway entrypoints live under the `./gateway` export namespace.

Choose `hermes_local` when Paperclip and Hermes run on the same trusted host
and Paperclip should start `hermes chat` for each heartbeat. Choose
`hermes_gateway` when Hermes is already running as an API server, often on
another host, in Docker, or behind a private-network/TLS endpoint. The adapter
type keys did not change during package consolidation.

## AetherDesk SSH bridge profile (fork extension)

The native local profile keeps its existing Hermes CLI, environment, session and
text-parser behavior. Remote execution requires an explicitly configured
`bridgeProfile`; a remote target without this profile is rejected. This profile
uses `ctx.executionTarget` through the shared execution-target process helper,
requires SSH with strict host checking, explicit private identity and pinned
`knownHosts`, and ignores legacy target configuration. It never falls back to a
local process or the native text parser.

Example adapter configuration (deployment-specific paths are illustrative):

```json
{
  "hermesCommand": "/opt/aetherdesk/bin/bridge",
  "timeoutSec": 300,
  "bridgeProfile": {
    "controlInstance": "unique-control-instance",
    "stateDirectory": "/var/lib/paperclip/bridge-control",
    "workspacePolicySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "executionSlot": "task-slot",
    "cleanupTimeoutSec": 10
  }
}
```

`stateDirectory` must already exist on the control host, be owned by the
Paperclip UID, have no group/other permissions, and contain no symlink in its
resolved path. Mount it as persistent control data, outside agent workspaces;
include it and the Paperclip run events in backups. Never delete it to retry a
run. A missing/unreadable/corrupt intent after known dispatch requires operator
reconciliation, not ledger recreation. `controlInstance` must identify one
Paperclip database and remain stable across restart/restore. The host must
supply a validated task in `ctx.runtime.taskKey`. There is no automatic session
resume or attempt creation in this profile. The remote working directory and
bridge executable must be protected management-UID assets.

The adapter exclusively creates and fsyncs an immutable per-attempt
`intent.json`, then fsyncs its directory before any SSH connection. It also
awaits the existing durable `onEvent` run-event seam (`bridge.dispatch_intent`)
when supplied. The control directory is the re-entry source because the current
adapter context cannot read prior run events. Intent presence consumes dispatch
permission, even after a crash before the first connection. Concurrent callers
cannot both dispatch. An incomplete intent is quarantined as unknown. Accepted
result revisions and stop request IDs are also exclusive, fsynced records.

The descriptor includes the canonical tuple, task/agent identity, protocol v1,
exact prompt SHA-256 and byte count, absolute deadline, policy digest, slot and
allowlisted non-secret parameters (`model`, `provider`, `toolsets`,
`maxTurnsPerRun`). `dispatch_sha256` hashes the canonical descriptor excluding
itself. Prompt bytes are staged through stdin as a file; neither the prompt nor
credentials occur in SSH argv. Only prompt and descriptor are transferred;
there is no workspace, home, instructions-file, skill or runtime-tool sync.
The default prompt uses task title/body/host-selected task markdown. A custom
`promptTemplate` can use `agent.{id,name,companyId}`, `run.id`, `taskId`,
`taskTitle`, `taskBody`, and `taskMarkdown`. Native Paperclip API instructions,
raw wake payloads and runtime tools are not interpolated. Known control/runtime
secrets and common credential patterns in the payload are rejected before SSH.
This check complements the host's responsibility to provide a non-secret brief.

The remote environment allowlist starts empty. `config.env`, inherited env,
Paperclip bearers and provider keys are never forwarded. Provider credentials
must be provisioned on the execution side for the task by the deployment. The
opt-in SSH isolation flag ignores ambient SSH config and disables agent
forwarding, multiplexing, default identity-agent access and forwarding rules.
Other adapters retain their existing defaults.

`timeoutSec` must be positive (default 300); the deadline starts at adapter entry
and covers readiness, staging, run and reporting. Re-entry retains the stored
deadline. The abort handler is installed before `onCancellationReady`; the
signal is checked again before transport. Cancellation/deadline/channel failure
uses a separate `stop` SSH invocation with its own signal and bounded cleanup
(default 10, maximum 60 seconds, plus at most one second of local SSH kill grace).
A readiness callback that stalls until the deadline returns unknown without
connecting. The adapter waits for validated stop evidence, never equating local SSH exit
with remote quiescence. Run stdin remains open until the channel closes.

Bridge CLI interoperability required by this profile:

- `run --descriptor <file>` uses the immutable descriptor and file prompt.
- `stop --attempt <key> --reason <reason> --request <id>` returns the one-line
  committed stop-evidence JSON from the execution contract, or the immutable
  result v1 if the descriptor is already known. A stop before descriptor
  delivery cannot know the dispatch hash; evidence-only replies are checked
  against the attempt/request/reason, scope/generation and quiescence proof.
  Such replies produce local cancellation/deadline metadata with
  `evidence_source="bridge.stop"`, never a fabricated result revision or usage.
  Channel-loss evidence alone still leaves the outcome unknown. A result already
  settled before the request may be returned unchanged. For never-started
  evidence, require `never_started=true`, `claim_consumed=false`, `tombstone=true`,
  null scope and confirmed empty scope.
- `inspect --attempt <key>` returns a JSON snapshot with `protocol`,
  `schema_version`, `attempt_key`, `dispatch_sha256`, `deadline`, and the highest
  positive `result_revision`. Missing results are unknown; inspect never starts.
- `report --attempt <key> --revision <n>` returns that immutable result v1 line.
  Re-entry uses inspect/report only; intermediate revisions are fetched and
  validated in order. Stop may fetch missing intermediate reports within the
  same cleanup budget. A maximum of 1000 missing revisions is accepted per call.

Result v1 follows `aetherdesk.execution`, schema 1: one UTF-8 JSON line plus LF,
at most 1 MiB, no duplicate keys, valid tuple/hash chain, required mapping,
completion, scope evidence and accounting fields. Unsupported/malformed/extra
stdout is unknown. Quiescence is required for settled outcomes; success also
requires matching root completion and a hashed artifact manifest. Manifest
`sha256` hashes the canonical `entries` array. Large manifests may instead
use `entries=null`, `locator`, `sha256` and positive `size_bytes`; their immutable
content must be verified by the artifact-transfer acceptance path. Each stop process entry uses
`pid` and `process_start_identity`; generations and scope must match mapping.
Known usage uses canonical request buckets, `lineage_coverage="complete"` and a
nonempty epoch. Cost provenance uses `kind="actual"|"estimated"|"unknown"` plus
currency/source/pricing_version. Partial/unknown accounting stays in
`resultJson.execution` and is omitted from top-level `usage`/`costUsd`.
Only known USD cost maps to `costUsd`. Terminal outcome/completion/stop facts
cannot change in later revisions. `resultJson.stop_confirmed` is derived from
validated evidence. No automatic recovery/retry hint is returned.

Shared helper changes are opt-in: `execution-target.ts` forwards `signal`,
`keepStdinOpen`, and `isolateSsh`; `server-utils.ts` checks cancellation before
and after async SSH preparation, terminates the SSH child on abort, and can hold
stdin open; `ssh.ts` implements isolated SSH argv. These are needed because the
previous helper ignores abort and closes/ignores stdin, which would falsely
signal channel loss to the bridge. Defaults for other callers are unchanged.

Offline verification, from the Paperclip repository with Node >=24.11:

```sh
pnpm --filter @paperclipai/hermes-paperclip-adapter test
pnpm --filter @paperclipai/hermes-paperclip-adapter typecheck
```

The new transport tests mock SSH; local process tests verify stdin and abort
with real shell subprocesses. Existing HTTP helper tests need permission to
listen on loopback. Real SSH, bridge/supervisor isolation and complete
Paperclip restart/UI/retry suppression remain M3 acceptance requirements; a
static environment check reports a warning until that acceptance is performed.

## Key Features

This adapter provides:

- **8 inference providers** — Anthropic, OpenRouter, OpenAI, Nous, OpenAI Codex, ZAI, Kimi Coding, MiniMax
- **Skills integration** — Scans both Paperclip-managed and Hermes-native skills (`~/.hermes/skills/`), with sync/list/resolve APIs
- **Structured transcript parsing** — Raw Hermes stdout is parsed into typed `TranscriptEntry` objects so Paperclip renders proper tool cards with status icons and expand/collapse
- **Rich post-processing** — Converts Hermes ASCII banners, setext headings, and `+--+` table borders into clean GFM markdown
- **Comment-driven wakes** — Agents wake to respond to issue comments, not just task assignments
- **Auto model detection** — Reads `~/.hermes/config.yaml` to pre-populate the UI with the user's configured model
- **Session codec** — Structured validation and migration of session state across heartbeats
- **Benign stderr reclassification** — MCP init messages and structured logs are reclassified so they don't appear as errors in the UI
- **Session source tagging** — Sessions are tagged as `tool` source so they don't clutter the user's interactive history
- **Filesystem checkpoints** — Optional `--checkpoints` for rollback safety
- **Thinking effort control** — Passes `--reasoning-effort` for thinking/reasoning models

### Hermes Agent Capabilities

| Feature | Claude Code | Codex | Hermes Agent |
|---------|------------|-------|-------------|
| Persistent memory | ❌ | ❌ | ✅ Remembers across sessions |
| Native tools | ~5 | ~5 | 30+ (terminal, file, web, browser, vision, git, etc.) |
| Skills system | ❌ | ❌ | ✅ 80+ loadable skills |
| Session search | ❌ | ❌ | ✅ FTS5 search over past conversations |
| Sub-agent delegation | ❌ | ❌ | ✅ Parallel sub-tasks |
| Context compression | ❌ | ❌ | ✅ Auto-compresses long conversations |
| MCP client | ❌ | ❌ | ✅ Connect to any MCP server |
| Multi-provider | Anthropic only | OpenAI only | ✅ 8 providers out of the box |

## Installation

This package ships with Paperclip core as the built-in `hermes_local` and
`hermes_gateway` adapters. No Adapter manager installation is required for
normal Paperclip use.

### Prerequisites

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) installed (`pip install hermes-agent`)
- Python 3.10+
- At least one LLM API key (Anthropic, OpenRouter, or OpenAI)

## Quick Start

### 1. Optional: override the built-in for adapter development

For local adapter development, install the package from a local path in Adapter
manager, or add an entry to `~/.paperclip/adapter-plugins.json` and restart
Paperclip. The external package can override either built-in Hermes adapter
while it is enabled:

```json
[
  {
    "packageName": "@paperclipai/hermes-paperclip-adapter",
    "localPath": "/absolute/path/to/paperclip/packages/adapters/hermes",
    "type": "hermes_local",
    "installedAt": "2026-06-23T00:00:00.000Z"
  }
]
```

Use `"type": "hermes_gateway"` with the same package when testing a gateway
override.

The package root exports `createServerAdapter()` for the local server adapter,
a declarative config schema for the generic agent form, and `./ui-parser` for
local run transcript parsing. Gateway entrypoints are exported from `./gateway`,
`./gateway/server`, `./gateway/ui`, `./gateway/cli`, and `./gateway/ui-parser`.
Paperclip core imports these same package entrypoints for built-in adapter
registration.

### 2. Create a local Hermes agent in Paperclip

In the Paperclip UI or via API, create an agent with adapter type `hermes_local`:

```json
{
  "name": "Hermes Engineer",
  "adapterType": "hermes_local",
  "adapterConfig": {
    "model": "anthropic/claude-sonnet-4",
    "maxIterations": 50,
    "timeoutSec": 300,
    "persistSession": true,
    "enabledToolsets": ["terminal", "file", "web"]
  }
}
```

This mode shells out to the local `hermes` CLI. Paperclip injects runtime
environment variables and captures stdout/stderr from the child process.

### 3. Create a Hermes gateway agent in Paperclip

Start Hermes with its API server enabled first:

```bash
API_SERVER_ENABLED=true \
API_SERVER_KEY=<generated-secret> \
hermes gateway run --replace --accept-hooks
```

Then create an agent with adapter type `hermes_gateway`:

```json
{
  "name": "Hermes Gateway Engineer",
  "adapterType": "hermes_gateway",
  "adapterConfig": {
    "apiBaseUrl": "http://127.0.0.1:8642",
    "apiKey": "<same-value-as-API_SERVER_KEY>",
    "paperclipApiUrl": "http://127.0.0.1:3100",
    "sessionKeyStrategy": "issue",
    "timeoutSec": 600
  }
}
```

If the URL you have is the default Hermes dashboard at
`http://127.0.0.1:9119` or the default chat URL at
`http://127.0.0.1:9119/chat`, Paperclip maps it to
`http://127.0.0.1:9119/api` before calling Hermes API routes. `/chat` and the
dashboard root are browser UI routes; Paperclip tests `/api/health` and starts
runs with `/api/v1/runs` after mapping them to the API base.

This mode does not start Hermes. It creates runs with `POST /v1/runs`, streams
Hermes events with SSE, polls run status as a fallback, and stops timed-out runs
with `POST /v1/runs/{run_id}/stop`.

### Compatibility with the old gateway package

`@paperclipai/adapter-hermes-gateway` remains as a deprecated compatibility shim
for one release. It re-exports the gateway entrypoints from
`@paperclipai/hermes-paperclip-adapter/gateway` and preserves the legacy exports
for existing plugin installs. New installs and built-in Paperclip registrations
should use `@paperclipai/hermes-paperclip-adapter`; the adapter type remains
`hermes_gateway`.

### Runtime API guidance

Hermes receives Paperclip runtime identity through environment variables:

- `PAPERCLIP_API_URL`
- `PAPERCLIP_API_KEY`
- `PAPERCLIP_RUN_ID`

Prompts should reference those variables directly. Command output may redact
secret values, so do not copy printed tokens into comments or config. Use
`Authorization: Bearer $PAPERCLIP_API_KEY` on Paperclip API requests and
`X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID` on mutating issue requests. For
multiline comments or status updates, preserve newlines with a heredoc plus
`jq --arg`.

### Hermes-originated Paperclip tasks

The package includes a Hermes skill/helper for the reverse direction: a user
starts in Hermes and asks Hermes to create or update Paperclip work. This is not
the same as Paperclip waking Hermes through `hermes_local` or `hermes_gateway`.

Configure Paperclip access in Hermes env/profile secrets, not prompt text:

```bash
PAPERCLIP_API_URL=http://127.0.0.1:3100/api
PAPERCLIP_BRIDGE_API_KEY=<task-bridge-scoped-agent-api-key>
```

Optional env values:

- `PAPERCLIP_COMPANY_ID`
- `PAPERCLIP_AGENT_ID`
- `PAPERCLIP_RUN_ID`

The bundled `paperclip-task-bridge` skill provides deterministic helper
commands:

```bash
node ./paperclip-task.mjs list-assigned
node ./paperclip-task.mjs create-task --parent-id "<approved-parent-issue-id>" --title "Investigate checkout failures" --description "Capture failing request and root cause."
node ./paperclip-task.mjs comment --issue PAP-123 --body "Found the failing request path."
node ./paperclip-task.mjs update-status --issue PAP-123 --status in_review --comment "Ready for review."
```

The helper reads credentials from environment variables and prints only JSON
summaries. It supports `create-task`, `comment`, `update-status`, and
`list-assigned`.

Create the bridge key with `scope.kind = "task_bridge"` plus a `parentIssueId`
or `projectId` boundary. Do not use a normal claimed agent API key for
internet-facing Hermes chat/webhook task-bridge operations.

### 4. Assign work

Create issues in Paperclip and assign them to your Hermes agent. On each heartbeat, Hermes will:

1. Receive the task instructions
2. Use its full tool suite to complete the work
3. Report results back to Paperclip
4. Persist session state for continuity

## Configuration Reference

### Core

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | string | `anthropic/claude-sonnet-4` | Model in `provider/model` format |
| `provider` | string | *(auto-detected)* | API provider: `auto`, `openrouter`, `nous`, `openai-codex`, `zai`, `kimi-coding`, `minimax`, `minimax-cn` |
| `timeoutSec` | number | `300` | Execution timeout in seconds |
| `graceSec` | number | `10` | Grace period before SIGKILL |

### Tools

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `toolsets` | string | *(all)* | Comma-separated toolsets to enable (e.g. `"terminal,file,web"`) |

Available toolsets: `terminal`, `file`, `web`, `browser`, `code_execution`, `vision`, `mcp`, `creative`, `productivity`

### Session & Workspace

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cwd` | string | *(assigned task workspace)* | Absolute working directory override. Without an override, use Paperclip's resolved task workspace. |
| `persistSession` | boolean | `true` | Resume sessions across heartbeats |
| `worktreeMode` | boolean | `false` | Git worktree isolation |
| `checkpoints` | boolean | `false` | Enable filesystem checkpoints for rollback |

### Advanced

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `hermesCommand` | string | `hermes` | Custom CLI binary path |
| `verbose` | boolean | `false` | Enable verbose output |
| `quiet` | boolean | `true` | Quiet mode (clean output, no banner/spinner) |
| `extraArgs` | string[] | `[]` | Additional CLI arguments |
| `env` | object | `{}` | Extra environment variables |
| `promptTemplate` | string | *(built-in)* | Custom prompt template |
| `paperclipApiUrl` | string | `http://127.0.0.1:3100/api` | Paperclip API base URL |

### Prompt Template Variables

Use `{{variable}}` syntax in `promptTemplate`:

| Variable | Description |
|----------|-------------|
| `{{agentId}}` | Paperclip agent ID |
| `{{agentName}}` | Agent display name |
| `{{companyId}}` | Company ID |
| `{{companyName}}` | Company name |
| `{{runId}}` | Current heartbeat run ID |
| `{{taskId}}` | Assigned task/issue ID |
| `{{taskTitle}}` | Task title |
| `{{taskBody}}` | Task instructions |
| `{{projectName}}` | Project name |
| `{{paperclipApiUrl}}` | Paperclip API base URL |
| `{{commentId}}` | Comment ID (when woken by a comment) |
| `{{wakeReason}}` | Reason this run was triggered |

Conditional sections:

- `{{#taskId}}...{{/taskId}}` — included only when a task is assigned
- `{{#noTask}}...{{/noTask}}` — included only when no task (heartbeat check)
- `{{#commentId}}...{{/commentId}}` — included only when woken by a comment

## Architecture

```
Paperclip                          Hermes Agent
┌──────────────────┐               ┌──────────────────┐
│  Heartbeat       │               │                  │
│  Scheduler       │───execute()──▶│  hermes chat -q  │
│                  │               │                  │
│  Issue System    │               │  30+ Tools       │
│  Comment Wakes   │◀──results─────│  Memory System   │
│                  │               │  Session DB      │
│  Cost Tracking   │               │  Skills          │
│                  │               │  MCP Client      │
│  Skill Sync      │◀──snapshot────│  ~/.hermes/skills│
│  Org Chart       │               │                  │
└──────────────────┘               └──────────────────┘
```

The adapter spawns Hermes Agent's CLI in single-query mode (`-q`). Hermes
processes the task using its full tool suite, then exits. The adapter:

1. **Captures** stdout/stderr and parses token usage, session IDs, and cost
2. **Parses** raw output into structured `TranscriptEntry` objects (tool cards with status icons)
3. **Post-processes** Hermes ASCII formatting (banners, setext headings, table borders) into clean GFM markdown
4. **Reclassifies** benign stderr (MCP init, structured logs) so they don't show as errors
5. **Tags** sessions as `tool` source to keep them separate from interactive usage
6. **Reports** results back to Paperclip with cost, usage, and session state

Session persistence works via Hermes's `--resume` flag — each run picks
up where the last one left off, maintaining conversation context,
memories, and tool state across heartbeats. The `sessionCodec` validates
and migrates session state between runs.

### Managed instructions and resumed turns

The local adapter reads `instructionsFilePath` on every run. It sends that
bundle, its relative-reference base directory, and the standard Paperclip API
guidance through Hermes's native `HERMES_EPHEMERAL_SYSTEM_PROMPT` overlay.
Hermes applies this overlay at each model request, including after context
compression. It does not append the overlay to saved user turns. This requires
a Hermes CLI that supports the [documented environment hook](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/environment-variables.md).

Fresh sessions, resumed sessions, and session resets all receive the current
bundle. Edits take effect on the next run; removing the bundle removes it from
the next overlay. The server's session compatibility and conversation generation
checks still control session reuse. A missing or failed resume remains a failed
run and requires an explicit session reset; it does not automatically restart
work. The next fresh run receives the complete current instruction overlay.

The `-q` user turn contains current runtime identity, task/wake context, handoff
content, and the rendered custom `promptTemplate`, if configured. Custom templates
run on every normal wake. `quiet` changes CLI display only. Disabling persistence
uses full fresh-session context even if old session parameters are supplied.

An explicit `HERMES_EPHEMERAL_SYSTEM_PROMPT` in `env` is preserved before the
Paperclip overlay. Hermes gives this environment hook precedence over its profile's
configured personality/system prompt. Put required additional profile guidance in
that explicit environment value or in the managed bundle. Paperclip does not write
Hermes profile files or modify the parent process environment. Existing copies in
old user turns remain in history until Hermes compresses them or the session resets.

Run the credential-free capture-process regression tests with:

```sh
pnpm --filter @paperclipai/hermes-paperclip-adapter test -- src/server/execute.instructions.test.ts
```

These tests verify actual child-process arguments and environment, not provider
billing, model behavior, or measured token savings.

### Skills Integration

The adapter scans two skill sources and merges them:

- **Paperclip-managed skills** — bundled with the adapter, togglable from the UI
- **Hermes-native skills** — from `~/.hermes/skills/`, read-only, always loaded

The `listSkills` / `syncSkills` APIs expose a unified snapshot so the
Paperclip UI can display both managed and native skills in one view.

## Development

```bash
git clone https://github.com/paperclipai/paperclip
cd paperclip/packages/adapters/hermes
pnpm install
pnpm build
```

## License

MIT — see [LICENSE](LICENSE)

## Links

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — The AI agent this adapter runs
- [Paperclip](https://github.com/paperclipai/paperclip) — The orchestration platform
- [Nous Research](https://nousresearch.com) — The team behind Hermes
- [Paperclip Docs](https://docs.paperclip.ing) — Paperclip documentation
