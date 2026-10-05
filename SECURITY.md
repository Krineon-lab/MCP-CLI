# Security

Rob Desktop Commander runs commands and edits files with the permissions of the operating-system account that launches it.

## Trust boundary

- Filesystem tools enforce `ROB_DC_ALLOWED_DIRS`.
- Shell tools are not filesystem-sandboxed by `ROB_DC_ALLOWED_DIRS`.
- The dangerous-command matcher is only a guardrail.
- MCP stdio has no network listener by itself.
- For ChatGPT, prefer Secure MCP Tunnel rather than exposing a public inbound endpoint.

If stronger containment is required, run the server under a dedicated low-privilege account, VM or container.

## Secrets

Do not commit:

- `CONTROL_PLANE_API_KEY`
- OpenAI API keys
- tunnel runtime credentials
- local `.env` files

The repository ignores `.env` by default.

## Reporting

For this personal project, report security issues privately to the repository owner rather than opening a public issue containing secrets or exploit details.
