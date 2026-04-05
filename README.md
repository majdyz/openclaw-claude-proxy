# openclaw-claude-proxy

A tiny HTTP proxy that lets [OpenClaw](https://docs.openclaw.ai) (and any other
third-party agent framework) make Anthropic `/v1/messages` calls using your
**Claude Code OAuth session** — i.e. the credentials installed by `claude login`
— instead of hitting `api.anthropic.com` directly with a wrapped token and
getting the *"Third-party apps now draw from your extra usage, not your plan
limits"* rejection.

It's ~350 lines of Node (built-ins only, no SDK). It does not touch
`api.anthropic.com` itself: it shells out to the real `claude` CLI, which makes
the upstream call as the official Claude Code client, and then marshals the
response back into Anthropic-compatible SSE for the caller — including
**bridging tool calls** so the caller's tools (`exec`, web search, Discord
MCP, Linear, Sentry, memory, etc.) keep working.

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
   │  POST http://127.0.0.1:18790/v1/messages  (Anthropic API shape, tools + streaming)
   ▼
claude-proxy.js
   │  • flattens system prompt + tool specs + message history into one
   │    user-text prompt; prior tool_use / tool_result are rendered as
   │    descriptive prose (so claude has context but won't mimic format)
   │  • tells claude: "reply with either a final answer OR a <tool_call>
   │    block naming one of the available tools"
   │  • spawns `claude -p --output-format json --max-turns 1 --allowed-tools ""`
   │    (single-shot, claude's own tools disabled)
   │  • writes the prompt to claude's stdin, emits SSE keepalives while waiting
   ▼
claude CLI  (@anthropic-ai/claude-code — the real binary)
   │  • authenticates with ~/.claude/.credentials.json
   │  • sends the request with the CLI's own User-Agent + baked-in system prompt
   ▼
api.anthropic.com  ──> allowed as official Claude Code traffic
   │  returns the model's answer
   ▼
claude-proxy.js
   │  parses claude's text for <tool_call> blocks
   │    • found → emits Anthropic tool_use content blocks + stop_reason=tool_use
   │    • none  → emits text content block + stop_reason=end_turn
   ▼
your agent
   │  executes the tool (your code, not ours) and POSTs back with the
   │  tool_result in history — we replay, claude decides whether to call
   │  another tool or write the final answer
```

Each HTTP request is a single turn. The loop (model → tool_use → tool → tool_result → model) is driven by the caller, exactly like Anthropic's real API — which means openclaw keeps its own tool-execution loop, memory writes, streaming cadence, and Discord delivery logic.

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

- **Streaming is simulated.** We must buffer claude's full reply to parse
  `<tool_call>` blocks reliably, so SSE events are emitted in one burst
  after claude finishes. Keepalive pings (`: ping`) are sent every 5s
  during the wait so clients don't hit first-byte timeouts. For long-form
  prose responses this means Discord / the caller sees the whole message
  at once rather than token-by-token.
- **One tool call at a time, by instruction.** The output contract tells
  claude to emit at most one `<tool_call>` per turn. The parser supports
  multiple (Anthropic's parallel tool use), but we don't encourage it; the
  caller will loop anyway.
- **Tool result payloads are truncated to 8000 chars** when fed back to
  claude as context, to keep prompts in check. Adjust with the
  `MAX_TOOL_RESULT_CHARS` constant.
- **Images and documents in user messages are dropped** with a note that
  an attachment was present. The single-shot `claude -p` path does not
  accept image inputs in this mode.
- **Most model params are ignored** (`temperature`, `stop_sequences`,
  `top_p`, `tool_choice`, etc.) — the CLI does not expose them.
- **Every request spawns a fresh `claude` process** (~5-10s cold start).
  No session pool yet. On large conversations (hundreds of messages,
  ~600k prompt chars) a single turn takes 10-40s end to end.
- **SSE-only streaming.** The proxy returns an SSE stream when
  `stream: true`, or a single JSON body otherwise. No WebSocket / gRPC /
  `stream_options` support.
- **Robustness of structured output depends on claude following the
  contract.** The prompt is explicit, but malformed `<tool_call>` blocks
  fall through as text. If you see prose like
  `I'll call the tool: <tool_call>…` instead of an actual tool_use block,
  file an issue with the offending text and we'll tighten the parser or
  the prompt.

## Install

Prerequisites:

- Node 18+
- `@anthropic-ai/claude-code` (the `claude` CLI) installed globally, with
  `claude login` already completed as the user that will run the proxy.

### One-line setup (recommended)

```bash
git clone https://github.com/majdyz/openclaw-claude-proxy.git
cd openclaw-claude-proxy
sudo ./install.sh
```

`install.sh` will:

- verify `node`, `claude`, and a valid `claude login` session exist
- write `/etc/systemd/system/claude-proxy.service` wired to the right
  binaries and to the user that did `claude login`
- enable + start the service, then curl `/health` to confirm
- back up your existing `~/.openclaw/openclaw.json` and merge
  `models.providers.anthropic.baseUrl` into it
- restart the `openclaw` service so it picks up the new baseUrl

Options: `--port <n>` (default 18790), `--no-service` (skip systemd),
`--no-openclaw` (skip the config patch), `--openclaw-config <path>`,
`--service-user <user>` (defaults to the user invoking `sudo`).

### Manual install

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

- Process pool (warm `claude` subprocesses) to kill cold start latency
- True token-by-token streaming (requires a streaming tool_call parser)
- Images/documents passthrough via `claude --input-format stream-json`
- Disconnect-aware cleanup (kill child `claude` when the HTTP client gives up)
- Tighter `<tool_call>` parser that recovers from minor formatting drift
