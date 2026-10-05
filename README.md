# Rob Desktop Commander

**Rob Desktop Commander** is a private, self-hosted Model Context Protocol (MCP) server for controlling a workstation from an MCP-capable AI client.

It is designed to replace the hosted Remote Desktop Commander relay for Rob's workflows: no provider account dependency, no telemetry service, no third-party relay quota, and a tool surface optimized for repeated software-project work.

## Current version

**v0.3.0**

Core goals:

- efficient single-call operations instead of unnecessary MCP round-trips;
- fair multi-project concurrency;
- bounded queues and output buffers;
- safe concurrent file editing;
- efficient streaming search;
- detailed optional JSONL diagnostics;
- no inbound public MCP listener;
- Windows-first behavior while remaining cross-platform.

## Architecture

```text
ChatGPT / MCP client
        |
        | MCP
        v
OpenAI Secure MCP Tunnel (optional for ChatGPT)
        |
        | outbound HTTPS from the PC
        v
tunnel-client
        |
        | stdio
        v
Rob Desktop Commander
        |
        +-- workspace-aware scheduler
        +-- filesystem
        +-- streaming ripgrep
        +-- PowerShell / shell processes
        +-- persistent process sessions
        +-- metrics + optional debug JSONL logs
```

Rob Desktop Commander itself speaks MCP over **stdio**. It does not open an inbound network port.

## Tool surface

The v0.3 surface deliberately stays compact even after adding batch operations.

| Tool | Purpose |
| --- | --- |
| `rob_status` | Runtime, concurrency, logging and optional performance/session diagnostics |
| `rob_logging` | Runtime logging status / enable / disable / flush / log-level control |
| `fs_read` | Efficient text range, tail, or base64-prefix read; hashing opt-in |
| `fs_read_many` | Batch-read multiple UTF-8 file prefixes |
| `fs_write` | Atomic write/append with optional SHA-256 precondition |
| `fs_write_many` | Concurrent multi-file creation/update in one MCP call |
| `fs_patch` | Exact validated patch of one file **or multiple files in parallel** |
| `fs_list` | Bounded tree listing with common generated directories excluded by default |
| `fs_manage` | stat/mkdir/move/copy/delete |
| `search` | Streaming ripgrep content, filename, or files-with-matches search |
| `workspace_inspect` | One-call project root + Git status + manifests + compact top-level inspection |
| `exec` | One shell command; direct result or automatic persistent-session detach |
| `exec_batch` | Multiple commands in parallel or sequentially in one MCP call |
| `process` | Persistent process start/read/input/kill/list via a single action-based tool |

The older five-tool process surface was intentionally collapsed into `process` so the model has fewer tools to choose between.

## Efficiency changes in v0.3

### Fewer MCP round-trips

`exec` still returns short-command output in the same MCP call. Longer commands auto-detach.

New high-value batch operations reduce repeated calls further:

- `exec_batch`: up to 12 independent commands;
- `fs_write_many`: up to 32 independent files;
- `fs_patch`: up to 32 independent files when using `files[]`;
- `workspace_inspect`: replaces several common tree / Git / manifest inspection calls.

### File hashing is now opt-in

Earlier versions calculated SHA-256 around writes even when the caller did not need it.

v0.3 only performs a full existing-file hash when:

- `expectedSha256` is supplied, or
- the caller explicitly asks for a returned hash.

For a normal overwrite, the after-hash can be computed directly from the content already in memory instead of rereading the file.

### Streaming search

`search` no longer needs to buffer an entire repository result set before returning the first N results.

It streams ripgrep output and terminates collection after either:

- `maxResults` is reached, or
- the configured output-character budget is reached.

Modes:

- `content`: matching lines;
- `name`: matching paths;
- `files`: files containing matching content.

### Efficient text reads

`fs_read` supports:

- normal line-range streaming;
- efficient tail reads that start near the end of the file;
- binary/base64 prefixes;
- optional SHA-256.

This is particularly useful for large debug logs.

### Efficient process output

Persistent process reads are event-driven.

A `process { action: "read", waitMs: ... }` call wakes as soon as:

- new stdout/stderr arrives, or
- the process exits,

instead of blindly sleeping for the whole wait interval.

The process output buffer is bounded. If an extremely noisy process exceeds the retained output budget, old events are dropped in batches and the response reports `droppedBeforeSeq`.

## Multi-project concurrency

Workspace detection first searches upward for a Git root. If none exists it falls back to common project markers, including:

- `package.json`
- `pyproject.toml`
- `Cargo.toml`
- `go.mod`
- Maven / Gradle
- Composer
- Ruby
- Elixir
- Deno

The workspace resolver uses a bounded TTL/LRU-like cache.

Default scheduler limits:

- child processes: **8 global / 3 per workspace**;
- ripgrep searches: **4 global / 2 per workspace**;
- filesystem I/O: **24 global / 8 per workspace**.

The queue is fair round-robin by workspace, not a single FIFO. A project with a large backlog therefore cannot put every later project behind all of its queued work.

Auto-detached processes keep their process slot until they actually exit.

Writes/patches touching the same path are serialized; unrelated paths can run concurrently.

Queues are also bounded by default:

- **1000 queued operations globally**
- **100 queued operations per workspace**

This prevents an accidental burst from consuming unbounded memory.

## In-memory metrics

`rob_status` reports per-tool metrics such as:

- call count;
- errors;
- average / maximum / last duration;
- average / maximum queue wait.

It also reports pool utilization and rejection/timeout counters.

By default `rob_status` does **not** include the full session list to keep its response compact. Use `includeSessions: true` when needed.

## Detailed debug logging

File logging is **disabled by default**.

Enable it for the first days of testing with:

```powershell
$env:ROB_DC_LOG_ENABLED = "1"
$env:ROB_DC_LOG_LEVEL = "debug"
```

or use the convenience launchers:

```powershell
.\scripts\start-debug.ps1
```

For the ChatGPT tunnel runtime:

```powershell
.\scripts\run-openai-tunnel-debug.ps1
```

Default log directory:

```text
<repository>\.rob-dc\logs
```

Logs are JSON Lines (`.jsonl`) and include events such as:

- server startup;
- tool start/end/error and duration;
- queue wait;
- process start/close/error/timeout/kill;
- process exit code and duration.

Payload contents are **not fully logged by default**. Strings are represented by size plus a short redacted preview. Obvious API-token patterns and secret-like keys are redacted.

To include fuller payloads while debugging:

```powershell
$env:ROB_DC_LOG_INCLUDE_PAYLOADS = "1"
```

Use this only when necessary because file contents, commands or other sensitive data may then be present in the logs.

Logging can also be changed without restarting through `rob_logging`:

```text
action=status
action=enable
action=disable
action=flush
action=set_level   level=debug|info|warn|error
```

Log rotation defaults to 25 MB per file and 7 files.

## Configuration

| Variable | Default | Meaning |
| --- | ---: | --- |
| `ROB_DC_ALLOWED_DIRS` | user home | Filesystem-tool roots; `*` means unrestricted |
| `ROB_DC_SHELL` | PowerShell on Windows | Shell used for shell commands |
| `ROB_DC_TIMEOUT_MS` | 30000 | Default `exec` process lifetime |
| `ROB_DC_DETACH_AFTER_MS` | 2500 | Time before `exec` becomes a persistent session |
| `ROB_DC_QUEUE_TIMEOUT_MS` | 15000 | Maximum wait for a saturated pool |
| `ROB_DC_MAX_QUEUE_GLOBAL` | 1000 | Maximum queued jobs per pool globally |
| `ROB_DC_MAX_QUEUE_PER_WORKSPACE` | 100 | Maximum queued jobs per project in a pool |
| `ROB_DC_SESSION_RETENTION_MS` | 600000 | Completed persistent-session retention |
| `ROB_DC_MAX_PROCESSES` | 8 | Running child processes globally |
| `ROB_DC_MAX_PROCESSES_PER_WORKSPACE` | 3 | Running child processes per project |
| `ROB_DC_MAX_SEARCHES` | 4 | Concurrent searches globally |
| `ROB_DC_MAX_SEARCHES_PER_WORKSPACE` | 2 | Concurrent searches per project |
| `ROB_DC_MAX_IO` | 24 | Concurrent filesystem jobs globally |
| `ROB_DC_MAX_IO_PER_WORKSPACE` | 8 | Concurrent filesystem jobs per project |
| `ROB_DC_MAX_OUTPUT_CHARS` | 1000000 | Per-stream retained/output budget |
| `ROB_DC_MAX_READ_BYTES` | 2000000 | Default binary/tail/patch size budget |
| `ROB_DC_MAX_SEARCH_RESULTS` | 500 | Global search-result ceiling |
| `ROB_DC_WORKSPACE_CACHE_TTL_MS` | 300000 | Workspace cache TTL |
| `ROB_DC_WORKSPACE_CACHE_MAX` | 10000 | Workspace cache entry ceiling |
| `ROB_DC_LOG_ENABLED` | 0 | Enable JSONL file logging |
| `ROB_DC_LOG_LEVEL` | debug | Minimum file-log level |
| `ROB_DC_LOG_DIR` | `.rob-dc\logs` | Log directory |
| `ROB_DC_LOG_INCLUDE_PAYLOADS` | 0 | Include expanded payload data |
| `ROB_DC_LOG_MAX_MB` | 25 | Maximum size per log file |
| `ROB_DC_LOG_MAX_FILES` | 7 | Rotated files retained |
| `ROB_DC_LOG_FLUSH_MS` | 250 | Buffered log flush interval |
| `ROB_DC_LOG_BUFFER_EVENTS` | 5000 | Maximum in-memory log event queue |
| `ROB_DC_ALLOW_DANGEROUS` | 0 | Disable the lightweight dangerous-command guard |

The launch scripts default `UV_THREADPOOL_SIZE` to 8 to give concurrent filesystem operations more room on Windows.

## Install

```powershell
git clone https://github.com/Krineon-lab/MCP-CLI.git
cd MCP-CLI
npm install
npm test
```

Normal local run:

```powershell
.\scripts\start-local.ps1
```

Debug local run:

```powershell
.\scripts\start-debug.ps1
```

## Connect to ChatGPT with Secure MCP Tunnel

1. Create a Secure MCP Tunnel and obtain its tunnel ID.
2. Install/configure the OpenAI tunnel client using the project scripts.
3. Set the required tunnel credentials.
4. Initialize:

```powershell
.\scripts\init-openai-tunnel.ps1
```

5. Run normally:

```powershell
.\scripts\run-openai-tunnel.ps1
```

or with detailed Rob Desktop Commander logging:

```powershell
.\scripts\run-openai-tunnel-debug.ps1
```

## Security model

This server is intentionally powerful.

`ROB_DC_ALLOWED_DIRS` restricts the dedicated filesystem tools. It is **not an operating-system sandbox for arbitrary shell commands**.

Commands launched through `exec`, `exec_batch` or `process` run with the permissions of the account that started the server.

For hard isolation, run Rob Desktop Commander under a dedicated low-privilege account, VM or container.

The dangerous-command matcher is a guardrail, not a security boundary.

Never expose the stdio server through an unauthenticated public proxy.

## Testing

```powershell
npm run check
npm test
npm run bench
```

The automated suite covers:

- dangerous-command regressions;
- fair concurrency;
- same-path locking;
- bounded queue rejection;
- workspace detection/cache isolation;
- streaming search limits;
- efficient tail/range reads;
- real concurrent MCP calls across two projects;
- JSONL logging enable/flush/disable;
- batch file patch/write;
- batch command execution;
- event-driven persistent-process reads;
- normal MCP handshake/tool enumeration.

## Local benchmark

On the development PC during the v0.3 second optimization pass:

| Benchmark | Result |
| --- | ---: |
| workspace resolver, cold + 999 warm calls | ~7.7 ms |
| tail read ×100 | ~99 ms |
| line 40000 range read ×20 | ~262 ms |
| fair scheduler, 2000 jobs | ~9.9 ms |

The workspace benchmark was ~61.5 ms before the second-pass exact-path cache, so that repeated-project lookup improved by roughly 8× on that run.

These are local microbenchmarks, not universal performance guarantees.

## License

MIT. See [LICENSE](LICENSE).

Desktop Commander is a separate MIT-licensed project; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
