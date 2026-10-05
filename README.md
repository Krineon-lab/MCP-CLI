# Rob Desktop Commander

**Rob Desktop Commander** is a private, self-hosted Model Context Protocol (MCP) server for controlling a computer from an MCP-capable AI client.

It is designed for Rob's workstation and deliberately avoids Desktop Commander's hosted Remote MCP relay, account service, telemetry and monthly provider quota.

## Design goals

- No third-party relay quota.
- No account, Supabase or telemetry dependency.
- Current MCP SDK v2 over stdio.
- Efficient tool surface: batch reads and single-call command execution.
- Fair multi-project concurrency with separate process, search and filesystem-I/O pools.
- Automatic workspace detection from Git/project roots, with per-workspace resource limits.
- Long-running commands automatically become persistent sessions and keep their process slot until exit.
- Same-file writes/patches are serialized while unrelated files remain parallel.
- Optimistic concurrency for file writes/patches using SHA-256.
- Fast local search through ripgrep.
- Explicit safety scope and no inbound Internet listener.

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
        +-- filesystem
        +-- ripgrep search
        +-- PowerShell / shell
        +-- persistent processes
```

Rob Desktop Commander itself only speaks MCP over **stdio**. For ChatGPT, the recommended remote transport is OpenAI Secure MCP Tunnel, so the PC does not need an inbound public port.

## Tools

| Tool | Purpose |
| --- | --- |
| `rob_status` | Runtime/config/session diagnostics |
| `fs_read` | Read one text/binary file |
| `fs_read_many` | Batch-read up to 64 files in one MCP call |
| `fs_write` | Atomic create/overwrite/append with optional SHA guard |
| `fs_patch` | Exact multi-edit patch, validated then written once |
| `fs_list` | Bounded recursive directory listing |
| `fs_manage` | stat/mkdir/move/copy/delete |
| `search` | Fast filename/content search via ripgrep |
| `exec` | Run a command; return directly or auto-detach to a session |
| `process_start` | Explicit long-running/interactive process start |
| `process_read` | Incremental output read |
| `process_input` | Send stdin |
| `process_kill` | Kill process tree |
| `process_list` | List sessions |

### Why `exec` matters

A short command should require one MCP call, not a `start_process` + `read_process_output` pair.

`exec` waits for `ROB_DC_DETACH_AFTER_MS` (2.5 seconds by default):

- if the process exits, it returns stdout/stderr/exit code immediately;
- if it is still running, it returns a `sessionId` and the same process continues in the background.

## Multi-project concurrency

Rob Desktop Commander v0.2 automatically groups work by **workspace**. It first looks upward for a `.git` root; if there is no Git root it falls back to common project markers such as `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, Maven and Gradle files.

Work is then scheduled through independent fair pools:

- processes: **8 global / 3 per workspace**;
- ripgrep searches: **4 global / 2 per workspace**;
- filesystem I/O: **24 global / 8 per workspace**.

The queue is round-robin by workspace, not a single FIFO. A project that submits many operations therefore cannot place every later project behind its entire backlog.

Persistent or auto-detached processes continue to consume their process slot until they actually exit. This prevents a burst of calls from silently creating an unbounded number of background builds, test runners or servers.

Writes, patches, moves, copies and deletes also use keyed locks. Operations touching the same file/path are serialized; unrelated paths can proceed concurrently.

`rob_status` exposes live global/per-workspace active and queued counts, pool limits and timeout statistics.

## Requirements

- Node.js 20+
- npm
- Windows, macOS or Linux
- OpenAI `tunnel-client` only when connecting from ChatGPT through Secure MCP Tunnel

## Install

```powershell
git clone https://github.com/Krineon-lab/MCP-CLI.git
cd MCP-CLI
npm install
npm test
```

Run locally:

```powershell
.\scripts\start-local.ps1
```

The process waits on stdin for MCP JSON-RPC. Logging goes to stderr so stdout remains a clean MCP protocol channel.

## Configuration

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `ROB_DC_ALLOWED_DIRS` | user home | Allowed roots for filesystem tools. Use `*` for unrestricted file tools. Multiple roots use the OS PATH delimiter (`;` on Windows). |
| `ROB_DC_SHELL` | `powershell.exe` on Windows | Shell for command tools |
| `ROB_DC_TIMEOUT_MS` | `30000` | Default command lifetime |
| `ROB_DC_DETACH_AFTER_MS` | `2500` | Delay before `exec` turns into a persistent session |
| `ROB_DC_QUEUE_TIMEOUT_MS` | `15000` | Maximum wait for a saturated concurrency pool |
| `ROB_DC_MAX_PROCESSES` | `8` | Maximum simultaneously running child processes across all projects |
| `ROB_DC_MAX_PROCESSES_PER_WORKSPACE` | `3` | Maximum child processes for one project/workspace |
| `ROB_DC_MAX_SEARCHES` | `4` | Maximum simultaneous ripgrep searches globally |
| `ROB_DC_MAX_SEARCHES_PER_WORKSPACE` | `2` | Maximum simultaneous searches for one project |
| `ROB_DC_MAX_IO` | `24` | Maximum simultaneous filesystem-I/O jobs globally |
| `ROB_DC_MAX_IO_PER_WORKSPACE` | `8` | Maximum filesystem-I/O jobs for one project |
| `ROB_DC_MAX_OUTPUT_CHARS` | `1000000` | Per-stream output protection |
| `ROB_DC_MAX_READ_BYTES` | `2000000` | File read/patch safety limit |
| `ROB_DC_MAX_SEARCH_RESULTS` | `500` | Global search result cap |
| `ROB_DC_ALLOW_DANGEROUS` | unset | Set to `1` to disable the small dangerous-command guard |

For this workstation, the recommended default is:

```powershell
$env:ROB_DC_ALLOWED_DIRS = $env:USERPROFILE
```

## Connect to ChatGPT with OpenAI Secure MCP Tunnel

1. Create a Secure MCP Tunnel in OpenAI Platform and obtain its `tunnel_id`.
2. Install the current OpenAI `tunnel-client` and make it available on `PATH`.
3. Set the runtime credentials:

```powershell
$env:ROB_TUNNEL_ID = "tunnel_..."
$env:CONTROL_PLANE_API_KEY = "sk-..."
$env:ROB_DC_ALLOWED_DIRS = $env:USERPROFILE
```

4. Initialize and validate the local profile:

```powershell
.\scripts\init-openai-tunnel.ps1
```

5. Run it:

```powershell
tunnel-client run --profile rob-desktop
```

6. In ChatGPT, create a custom MCP server/plugin, choose **Tunnel**, select that tunnel and connect it.

The private MCP server remains on the PC; `tunnel-client` makes outbound HTTPS connections rather than exposing an inbound MCP port.

## Other MCP clients

Any client that can launch a stdio MCP server can use:

```json
{
  "mcpServers": {
    "rob-desktop-commander": {
      "command": "node",
      "args": [
        "C:\\path\\to\\MCP-CLI\\dist\\index.js"
      ],
      "env": {
        "ROB_DC_ALLOWED_DIRS": "C:\\Users\\your-user"
      }
    }
  }
}
```

## Security model

This server is intentionally powerful.

`ROB_DC_ALLOWED_DIRS` constrains the dedicated filesystem tools. It is **not an operating-system sandbox for arbitrary shell commands**. A command executed through `exec` or `process_start` has the permissions of the Windows account running the server.

For hard isolation, run Rob Desktop Commander under a dedicated OS account, VM or container with only the permissions it needs.

A lightweight command guard blocks a small set of obvious disk/boot/shutdown commands unless `ROB_DC_ALLOW_DANGEROUS=1`. This is a guardrail, not a security boundary.

Never expose the stdio server through an unauthenticated public proxy.

## Development

```powershell
npm run check
npm test
npm run inspector
```

The test suite includes security regressions, scheduler fairness/locking tests, a real concurrent MCP test across two workspaces, and the normal MCP smoke test. The launch scripts also default `UV_THREADPOOL_SIZE` to 8 to give concurrent filesystem work more headroom on Windows.

## License

MIT. See [LICENSE](LICENSE).

Desktop Commander is a separate MIT-licensed project; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
