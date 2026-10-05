# Security

Rob Desktop Commander runs commands and edits files with the permissions of the operating-system account that launches it.

## Trust boundary

- Filesystem tools enforce `ROB_DC_ALLOWED_DIRS`.
- Shell tools are not filesystem-sandboxed by `ROB_DC_ALLOWED_DIRS`.
- The dangerous-command matcher is only a guardrail.
- MCP stdio has no network listener by itself.
- For ChatGPT, prefer Secure MCP Tunnel rather than exposing a public inbound endpoint.
- Concurrency limits and path locks protect availability/consistency but are not an OS security boundary.

If stronger containment is required, run the server under a dedicated low-privilege account, VM or container.

## Debug logs

Detailed JSONL logging is disabled by default.

With `ROB_DC_LOG_ENABLED=1`, logs can contain:

- local paths;
- process names and command previews;
- timing/concurrency metadata;
- error messages.

`ROB_DC_LOG_INCLUDE_PAYLOADS=0` is the recommended setting. It logs payload sizes plus short redacted previews.

If `ROB_DC_LOG_INCLUDE_PAYLOADS=1` is enabled, file contents or command arguments may be written to disk. Use it only temporarily and treat the log directory as sensitive.

Obvious secret-like keys and common token formats are redacted, but redaction is not a guarantee that every possible secret format will be recognized.

## Secrets

Do not commit:

- `CONTROL_PLANE_API_KEY`
- OpenAI API keys
- tunnel runtime credentials
- local `.env` files
- `.rob-dc/` runtime data/logs

The repository ignores those local runtime artifacts.

## Reporting

For this personal project, report security issues privately to the repository owner rather than opening a public issue containing secrets or exploit details.
