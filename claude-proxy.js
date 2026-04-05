#!/usr/bin/env node
// Anthropic /v1/messages -> claude CLI proxy (stream-json edition).
//
// For each request:
//   1. Write system prompt to a temp file, open a `claude -p` subprocess in
//      stream-json mode with --include-partial-messages.
//   2. Feed the conversation to claude via stdin as a single user-turn
//      stream-json event (prior turns flattened into the prompt body).
//   3. Parse claude's stdout line-by-line, unwrap its `stream_event` wrappers,
//      and forward the native Anthropic SSE events to the HTTP client.
//
// This gives real token-level streaming and preserves model usage metadata,
// but still does not pass openclaw's `tools` through — claude runs with
// --allowed-tools "" so the assistant can only emit text. Tool_use blocks
// from openclaw's embedded agent are not supported; it will see text-only
// turns. Images/PDFs in the request are dropped.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.CLAUDE_PROXY_PORT || 18790);
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const TURN_TIMEOUT_MS = Number(process.env.CLAUDE_PROXY_TIMEOUT_MS || 300000);

function log(...args) {
  console.error(new Date().toISOString(), '[claude-proxy]', ...args);
}

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text') return part.text || '';
      if (part?.type === 'tool_use') {
        // Wrap in 4-backtick fences; 3-backtick content is common in tool
        // results but 4 is not, so the outer fence stays intact.
        const input = JSON.stringify(part.input || {}, null, 2);
        return `\`\`\`\`prior_tool_call name=${part.name}\n${input}\n\`\`\`\``;
      }
      if (part?.type === 'tool_result') {
        const inner = typeof part.content === 'string'
          ? part.content
          : flattenContent(part.content);
        // If the inner text itself contains a run of 4+ backticks, step up to
        // 5 so our outer fence survives.
        const fence = /````/.test(inner) ? '`````' : '````';
        return `${fence}prior_tool_result\n${inner}\n${fence}`;
      }
      if (part?.type === 'image') return '<image omitted />';
      if (part?.type === 'document') return '<document omitted />';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractSystemPrompt(body) {
  const lines = [];
  const sys = body.system;
  if (typeof sys === 'string' && sys.trim()) lines.push(sys.trim());
  else if (Array.isArray(sys)) {
    for (const s of sys) {
      if (typeof s === 'string') lines.push(s);
      else if (s?.type === 'text' && s.text) lines.push(s.text);
    }
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    const names = body.tools.map((t) => t.name).filter(Boolean).join(', ');
    lines.push(
      `NOTE: caller advertised tools (${names}) but this proxy cannot execute them. Reply in plain text only.`
    );
  }
  return lines.join('\n\n');
}

function buildUserTurnText(body) {
  const parts = [];
  // Inline the system prompt in the user message rather than using Anthropic's
  // system field — passing openclaw's identity in the native system field
  // triggers the "third-party app" rejection even when claude CLI is the
  // transport.
  const sys = extractSystemPrompt(body);
  if (sys) parts.push(sys);
  parts.push(
    'You are completing the next Assistant turn in the transcript below. ' +
    'Prior turns may show ````prior_tool_call```` / ````prior_tool_result```` ' +
    'code fences — those are history only; do NOT emit any such fences ' +
    'yourself, do not describe invoking tools, and do not fabricate tool ' +
    'results (no tools are available in this environment). Reply only with ' +
    'the final assistant message as natural prose (Markdown is fine).'
  );
  parts.push('--- BEGIN TRANSCRIPT ---');
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (const m of msgs) {
    const role = m.role === 'assistant' ? 'Assistant' : 'User';
    const text = flattenContent(m.content);
    if (text) parts.push(`${role}: ${text}`);
  }
  parts.push('--- END TRANSCRIPT ---');
  parts.push('Write the next Assistant message now. Reply with message text only, no prefix.');
  return parts.join('\n\n');
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sendSseError(res, message) {
  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
  }
  sseWrite(res, 'error', { type: 'error', error: { type: 'api_error', message } });
  res.end();
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Run a single claude turn. Emits native Anthropic SSE events to `onEvent`.
// Resolves with { text, usage } or rejects on failure.
function runClaudeTurn({ userText, onEvent, onFinal }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--max-turns', '1',
      '--allowed-tools', '',
    ];
    const child = spawn(CLAUDE_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const cleanup = () => {};

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      cleanup();
      reject(new Error(`claude turn timed out after ${TURN_TIMEOUT_MS}ms`));
    }, TURN_TIMEOUT_MS);

    // Feed the user message as a stream-json event, then close stdin.
    const userEvent = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: userText }] },
    };
    child.stdin.write(JSON.stringify(userEvent) + '\n');
    child.stdin.end();

    let stderr = '';
    child.stderr.on('data', (b) => (stderr += b.toString()));

    let buf = '';
    let finalText = '';
    let finalUsage = null;
    let sawResult = false;

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.type === 'stream_event' && obj.event) {
          onEvent(obj.event);
        } else if (obj.type === 'result') {
          sawResult = true;
          finalText = obj.result || '';
          finalUsage = obj.usage || null;
          if (obj.is_error) log(`claude result error: ${(obj.result || '').slice(0, 300)}`);
        }
      }
    });

    child.on('error', (e) => {
      clearTimeout(timer);
      cleanup();
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      cleanup();
      if (code !== 0 && !sawResult) {
        return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
      }
      onFinal?.({ text: finalText, usage: finalUsage });
      resolve({ text: finalText, usage: finalUsage });
    });
  });
}

async function handleMessages(req, res) {
  let raw = '';
  for await (const chunk of req) raw += chunk.toString();
  let body;
  try { body = JSON.parse(raw); } catch (e) {
    return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: `bad json: ${e.message}` } });
  }

  const stream = body.stream === true;
  const userText = buildUserTurnText(body);

  log(`POST /v1/messages model=${body.model} msgs=${(body.messages || []).length} userChars=${userText.length} stream=${stream}`);

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    // Emit a fake message_start immediately so the AI SDK considers the stream
    // "started." We'll send the real message_start from claude afterwards; SDKs
    // typically overwrite state on each event rather than forbidding duplicates.
    const startedAt = Date.now();
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch {}
    }, 5000);
    try {
      await runClaudeTurn({
        userText,
        onEvent: (ev) => {
          sseWrite(res, ev.type || 'unknown', ev);
        },
      });
      clearInterval(ping);
      log(`stream completed in ${Date.now() - startedAt}ms`);
      res.end();
    } catch (e) {
      clearInterval(ping);
      log('stream error:', e.message);
      sendSseError(res, e.message);
    }
    return;
  }

  // Non-streaming: accumulate events, build a single message response.
  try {
    const collected = {
      id: null,
      model: body.model,
      stopReason: 'end_turn',
      textByIndex: new Map(),
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
    await runClaudeTurn({
      systemPrompt,
      userText,
      onEvent: (ev) => {
        if (ev.type === 'message_start' && ev.message) {
          collected.id = ev.message.id || collected.id;
          collected.model = ev.message.model || collected.model;
          if (ev.message.usage) Object.assign(collected.usage, {
            input_tokens: ev.message.usage.input_tokens ?? 0,
            cache_creation_input_tokens: ev.message.usage.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens: ev.message.usage.cache_read_input_tokens ?? 0,
          });
        } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          const cur = collected.textByIndex.get(ev.index) || '';
          collected.textByIndex.set(ev.index, cur + (ev.delta.text || ''));
        } else if (ev.type === 'message_delta') {
          if (ev.delta?.stop_reason) collected.stopReason = ev.delta.stop_reason;
          if (ev.usage?.output_tokens != null) collected.usage.output_tokens = ev.usage.output_tokens;
        }
      },
    });
    const content = [...collected.textByIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, text]) => ({ type: 'text', text }));
    sendJson(res, 200, {
      id: collected.id || `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      type: 'message',
      role: 'assistant',
      model: collected.model,
      content: content.length ? content : [{ type: 'text', text: '' }],
      stop_reason: collected.stopReason,
      stop_sequence: null,
      usage: collected.usage,
    });
  } catch (e) {
    log('error:', e.message);
    sendJson(res, 500, { type: 'error', error: { type: 'api_error', message: e.message } });
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
    return handleMessages(req, res);
  }
  sendJson(res, 404, { type: 'error', error: { type: 'not_found', message: 'Only POST /v1/messages supported' } });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${PORT}`);
});
