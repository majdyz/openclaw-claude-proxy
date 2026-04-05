# openclaw-claude-proxy

A tiny HTTP proxy that lets [OpenClaw](https://docs.openclaw.ai) (and any other
third-party agent framework) make Anthropic `/v1/messages` calls using your
**Claude Code OAuth session** — i.e. the credentials installed by `claude login`
— instead of hitting `api.anthropic.com` directly with a wrapped token and
getting the *"Third-party apps now draw from your extra usage, not your plan
limits"* rejection.

It's ~250 lines of Node (built-ins only, no SDK). It does not touch
`api.anthropic.com` itself: it shells out to the real `claude` CLI, which makes
the upstream call as the official Claude Code client, and then marshals the
response back into Anthropic-compatible SSE for the caller.

## Why this exists

When a third-party app sends requests to `api.anthropic.com/v1/messages` using
a Claude Code OAuth token, Anthropic fingerprints the request (User-Agent,
request shape, custom `system` field content) and — if it looks like a
non-official client wrapping a Claude Code session — rejects with:

```
400 invalid_request_error
Third-party apps now draw from your extra usage, not your plan limits.
We've added a $200 credit to get you started.
```

If you have a Claude subscription and want a bot (OpenClaw, a Discord/Slack
agent, etc.) to spend your plan limits rather than separate metered usage, you
can route its LLM calls through the real `claude` binary. That binary is the
official Claude Code client, so its requests are accepted as plan-limit
traffic. This proxy does exactly that bridging.

**This is a workaround, not an endorsement.** It depends on Anthropic not
tightening their detection further. Use at your own risk, read your plan's
terms of service, and don't automate at scale.

## How it works

```
your agent (OpenClaw, etc.)
   │  POST http://127.0.0.1:18790/v1/messages   (Anthropic API shape, streaming)
   ▼
claude-proxy.js
   │  flattens `system` + `messages` + `tools` description into one user-text
   │  block, wraps prior tool_use / tool_result in 4-backtick code fences
   │  spawns `claude -p --input-format stream-json --output-format stream-json
   │    --include-partial-messages --allowed-tools "" --max-turns 1`
   │  writes the flattened prompt to claude's stdin as one user stream-json event
   │  emits SSE keepalive pings while claude starts up (~5-30s on big prompts)
   ▼
claude CLI  (@anthropic-ai/claude-code — the real binary)
   │  authenticates with ~/.claude/.credentials.json (your `claude login` session)
   │  sends the request with the CLI's own User-Agent + baked-in system prompt
   ▼
api.anthropic.com  ──> allowed as official Claude Code traffic
   │  streams stream_event JSONL back through the CLI
   ▼
claude-proxy.js  (unwraps stream_event → Anthropic SSE → caller)
```

### Why the `system` prompt is inlined into the user message

The caller's system prompt identifies it ("You are OpenClaw assistant…"),
and Anthropic's fingerprint check reads the `system` field content. Passing
that identity in the real `system` field — even via the CLI — re-triggers the
third-party block. Inlining it as part of the user turn sidesteps that: the
CLI's own Claude Code system prompt stays in the `system` field, and your
agent's instructions live inside the user-message body.

### Why prior tool_use / tool_result turns are rendered as 4-backtick fences

The caller's conversation history often contains `tool_use` and `tool_result`
content blocks. They need to be represented as plain text for the CLI.
4-backtick fences keep the boundaries robust even when tool results contain
their own 3-backtick code blocks. The CLI is also explicitly instructed **not**
to emit any such fences itself, to prevent it from imitating the pattern.

## Limitations

- **No tool passthrough.** The proxy disables tools in the CLI
  (`--allowed-tools ""`). The caller's `tools` list is advertised only as a
  hint in the prompt; the model cannot emit real `tool_use` blocks. If your
  agent relies on tool-call turns (memory lookup, web search, file I/O), they
  won't happen — the model will just produce text. Bridging the caller's
  tools into MCP tools exposed to the CLI is possible but not implemented
  here.
- **No real token-by-token streaming of text deltas.** Claude's
  `--include-partial-messages` emits deltas, but for short responses it
  collapses to one delta. Streaming keepalive and per-delta forwarding both
  work; it's just less chunked than a raw API stream.
- **Images and documents are dropped** from the user message content with
  `<image omitted />` placeholders.
- **Most model params are ignored** (`temperature`, `stop_sequences`,
  `top_p`, etc.) — the CLI does not expose them.
- **Every request spawns a fresh `claude` process** (~5-8s cold start). No
  session pool yet.
- **SSE-only streaming.** The proxy returns an SSE stream when
  `stream: true`, or a single JSON body otherwise. No WebSocket / gRPC /
  `stream_options` support.

## Install

Prerequisites:

- Node 18+
- `@anthropic-ai/claude-code` (the `claude` CLI) installed globally, with
  `claude login` already completed as the user that will run the proxy.

```bash
git clone https://github.com/majdyz/openclaw-claude-proxy.git
cd openclaw-claude-proxy

# Run in the foreground to test:
node claude-proxy.js
# → listening on http://127.0.0.1:18790

# Or install as a systemd service:
sudo cp claude-proxy.service /etc/systemd/system/
# edit User=, WorkingDirectory=, ExecStart= paths for your system
sudo systemctl daemon-reload
sudo systemctl enable --now claude-proxy
```

## Wire it into OpenClaw

Add this to `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "providers": {
      "anthropic": {
        "baseUrl": "http://127.0.0.1:18790",
        "models": []
      }
    }
  }
}
```

Then restart openclaw: `systemctl restart openclaw`.

OpenClaw's embedded agent will now POST `/v1/messages` requests to the proxy
instead of `api.anthropic.com`, and the proxy will fulfill them via the
local `claude` CLI. Existing auth profiles (`anthropic:manual` or
`anthropic:claude-code`) stay in place — their token values are sent as
request headers but ignored by the proxy, so you can leave whatever is
already there.

A working example snippet is in `examples/openclaw-config-snippet.json`.

## Wire it into anything else

The proxy implements the Anthropic Messages API surface on
`POST /v1/messages`. Any client that lets you override `base_url` /
`ANTHROPIC_BASE_URL` should work:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:18790
# now anthropic SDK calls get fulfilled by your `claude login` session
```

## Configuration

Environment variables:

| Var | Default | Purpose |
| --- | --- | --- |
| `CLAUDE_PROXY_PORT` | `18790` | HTTP port to bind on `127.0.0.1` |
| `CLAUDE_BIN` | `claude` | path / name of the claude CLI binary |
| `CLAUDE_PROXY_TIMEOUT_MS` | `300000` | max time to wait for a single turn |

## Health check

```bash
curl http://127.0.0.1:18790/health
# {"ok": true}
```

## License

MIT. See [`LICENSE`](./LICENSE).

## Contributing

Issues and PRs welcome. Most obvious next steps:

- MCP-based tool bridging so the caller's tools actually execute
- Process pool (warm `claude` subprocesses) to kill cold start
- Images/documents passthrough via temp files
- Disconnect-aware cleanup (kill child `claude` when the HTTP client gives up)
