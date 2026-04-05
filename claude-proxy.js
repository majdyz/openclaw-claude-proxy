#!/usr/bin/env node
// Anthropic /v1/messages -> claude CLI proxy with tool-use bridging.
//
// For each POST /v1/messages request we:
//   1. Flatten the caller's system + tools + message history into a single
//      text prompt that (a) tells claude exactly which tools are available
//      and (b) asks it to respond with either a <tool_call> block or final
//      prose text.
//   2. Invoke `claude -p --output-format json --max-turns 1 --allowed-tools ""`
//      (single-shot, no claude-side tools) via stdin.
//   3. Parse claude's reply. If it contains a <tool_call name="…">{…}</tool_call>
//      block, synthesize an Anthropic tool_use content block alongside any
//      preamble text. Otherwise emit the text as-is.
//   4. Return either SSE (stream:true) or a single JSON body. Streaming is
//      simulated — we send the real SSE event shape but in one burst after
//      claude finishes, because we must buffer to parse tool calls reliably.
//
// Openclaw then executes the tool itself and POSTs back to us with the
// tool_result included in history; we replay and let claude decide whether
// to call another tool or finish. This keeps each HTTP turn stateless, in
// line with how Anthropic's real /v1/messages API works.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.CLAUDE_PROXY_PORT || 18790);
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const TURN_TIMEOUT_MS = Number(process.env.CLAUDE_PROXY_TIMEOUT_MS || 300000);
const MAX_TOOL_RESULT_CHARS = 8000;

function log(...args) {
  console.error(new Date().toISOString(), '[claude-proxy]', ...args);
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversation flattening
// ─────────────────────────────────────────────────────────────────────────────

function flattenText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (p?.type === 'text' ? (p.text || '') : typeof p === 'string' ? p : ''))
    .filter(Boolean)
    .join('\n');
}

function renderMessage(m) {
  // Represent each message in the transcript as a labelled block. Prior
  // tool_use / tool_result content is rendered in descriptive prose — a
  // different format from the <tool_call> format we ask claude to emit — so
  // claude has the context but is not primed to mimic the output format.
  const roleLabel = m.role === 'assistant' ? 'ASSISTANT' : 'USER';
  if (typeof m.content === 'string') return `${roleLabel}: ${m.content}`;
  if (!Array.isArray(m.content)) return '';
  const lines = [];
  for (const part of m.content) {
    if (typeof part === 'string') {
      lines.push(part);
    } else if (part?.type === 'text' && part.text) {
      lines.push(part.text);
    } else if (part?.type === 'tool_use') {
      const args = JSON.stringify(part.input || {});
      lines.push(`(The assistant previously called the tool "${part.name}" with arguments: ${args})`);
    } else if (part?.type === 'tool_result') {
      const inner = typeof part.content === 'string'
        ? part.content
        : flattenContentAsText(part.content);
      const truncated = inner.length > MAX_TOOL_RESULT_CHARS
        ? inner.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…(truncated)'
        : inner;
      const status = part.is_error ? 'errored with' : 'returned';
      lines.push(`(That tool call ${status}:\n${truncated}\n)`);
    } else if (part?.type === 'image') {
      lines.push('(an image was attached; it is not visible to you in this turn)');
    } else if (part?.type === 'document') {
      lines.push('(a document was attached; it is not visible to you in this turn)');
    }
  }
  const body = lines.join('\n').trim();
  return body ? `${roleLabel}: ${body}` : '';
}

function flattenContentAsText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content
    .map((p) => {
      if (typeof p === 'string') return p;
      if (p?.type === 'text') return p.text || '';
      if (p?.type === 'image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractSystemPrompt(body) {
  const sys = body.system;
  if (typeof sys === 'string') return sys.trim();
  if (Array.isArray(sys)) {
    return sys
      .map((s) => {
        if (typeof s === 'string') return s;
        if (s?.type === 'text') return s.text || '';
        return '';
      })
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }
  return '';
}

function renderToolsSpec(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const lines = ['AVAILABLE TOOLS (you may call at most one per turn):'];
  for (const t of tools) {
    if (!t?.name) continue;
    lines.push(`- name: ${t.name}`);
    if (t.description) {
      const desc = String(t.description).replace(/\s+/g, ' ').trim();
      lines.push(`  description: ${desc}`);
    }
    if (t.input_schema) {
      lines.push(`  input_schema: ${JSON.stringify(t.input_schema)}`);
    }
  }
  return lines.join('\n');
}

const TOOL_CALL_INSTRUCTIONS = [
  'You MUST respond with EITHER:',
  '  (A) a final assistant message as prose (Markdown OK), OR',
  '  (B) exactly ONE tool call, formatted as:',
  '      <tool_call name="EXACT_TOOL_NAME">',
  '      {"arg1": "value1", "arg2": 42}',
  '      </tool_call>',
  '',
  'Rules for tool calls:',
  '  • The <tool_call> block must contain a single JSON object matching the tool\'s input_schema.',
  '  • You may include a brief one-sentence preamble BEFORE the <tool_call> block explaining what you are about to do. Do not include any text after the </tool_call> closing tag.',
  '  • Do not fabricate tool results. Do not narrate tool results. The host will execute the tool and give you the result on the next turn.',
  '  • Do not use any <tool_call> format other than the one above.',
  '  • Use a tool only when the user\'s request cannot be answered from the transcript.',
  '',
  'Rules for final answers (no tool call):',
  '  • Just write the assistant message. Do NOT include a <tool_call> block.',
  '  • Do not suggest restarting the session, opening a new thread, or asking the user to paste content for you — the user is not a collaborator who can act on your behalf.',
].join('\n');

function buildUserTurnText(body) {
  const parts = [];
  const sys = extractSystemPrompt(body);
  if (sys) parts.push(sys);
  const toolsSpec = renderToolsSpec(body.tools);
  if (toolsSpec) parts.push(toolsSpec);
  parts.push(TOOL_CALL_INSTRUCTIONS);
  parts.push('--- BEGIN TRANSCRIPT ---');
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (const m of msgs) {
    const rendered = renderMessage(m);
    if (rendered) parts.push(rendered);
  }
  parts.push('--- END TRANSCRIPT ---');
  if (toolsSpec) {
    parts.push('Now produce the next ASSISTANT turn: either a brief preamble + one <tool_call> block, or a final prose answer. No tool-call fences, no meta, no apologies about tooling.');
  } else {
    parts.push('Now produce the next ASSISTANT turn as prose. No tool-call fences, no meta.');
  }
  return parts.join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool-call parsing
// ─────────────────────────────────────────────────────────────────────────────

// Captures <tool_call name="…">{…}</tool_call> blocks plus any prose that
// appeared before the first one. Prose between/after tool_calls is dropped
// (Anthropic tool_use turns don't have interleaved text).
function parseToolCalls(text) {
  const re = /<tool_call\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/tool_call>/gi;
  const toolCalls = [];
  let firstIdx = -1;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (firstIdx < 0) firstIdx = m.index;
    const name = m[1].trim();
    const bodyText = m[2].trim();
    const jsonMatch = bodyText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) continue;
    try {
      const input = JSON.parse(jsonMatch[0]);
      toolCalls.push({ name, input });
    } catch {
      // Malformed JSON — skip this block; the overall turn will still return
      // any earlier valid calls plus preamble.
    }
  }
  if (toolCalls.length === 0) return { preamble: text.trim(), toolCalls: [] };
  const preamble = text.slice(0, firstIdx).trim();
  return { preamble, toolCalls };
}

// ─────────────────────────────────────────────────────────────────────────────
// claude CLI invocation
// ─────────────────────────────────────────────────────────────────────────────

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--max-turns', '1', '--allowed-tools', ''];
    const child = spawn(CLAUDE_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    child.stdin.write(prompt);
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude timed out after ${TURN_TIMEOUT_MS}ms`));
    }, TURN_TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
      try {
        const line = stdout.trim().split('\n').pop();
        const parsed = JSON.parse(line);
        if (parsed.is_error) return reject(new Error(`claude error: ${(parsed.result || '').slice(0, 300)}`));
        resolve({
          text: parsed.result || '',
          usage: parsed.usage || {},
        });
      } catch (e) {
        reject(new Error(`claude output parse failed: ${e.message}; raw=${stdout.slice(0, 300)}`));
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic response assembly
// ─────────────────────────────────────────────────────────────────────────────

function buildAnthropicContent(preamble, toolCalls) {
  const content = [];
  if (preamble) content.push({ type: 'text', text: preamble });
  for (const tc of toolCalls) {
    content.push({
      type: 'tool_use',
      id: `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      name: tc.name,
      input: tc.input,
    });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return content;
}

function buildAnthropicMessage({ model, content, stopReason, usage }) {
  return {
    id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    model: model || 'claude-opus-4-6',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
      cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE emission (Anthropic stream format)
// ─────────────────────────────────────────────────────────────────────────────

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

function emitAnthropicStream(res, msg) {
  // message_start (with empty content array and the message's metadata)
  sseWrite(res, 'message_start', {
    type: 'message_start',
    message: { ...msg, content: [], stop_reason: null, stop_sequence: null },
  });
  // For each content block, emit block_start -> delta(s) -> block_stop
  for (let i = 0; i < msg.content.length; i++) {
    const block = msg.content[i];
    if (block.type === 'text') {
      sseWrite(res, 'content_block_start', {
        type: 'content_block_start',
        index: i,
        content_block: { type: 'text', text: '' },
      });
      // Chunk the text so the SDK feels it streaming
      const text = block.text || '';
      const chunkSize = 512;
      for (let off = 0; off < text.length; off += chunkSize) {
        sseWrite(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: i,
          delta: { type: 'text_delta', text: text.slice(off, off + chunkSize) },
        });
      }
      if (text.length === 0) {
        sseWrite(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: i,
          delta: { type: 'text_delta', text: '' },
        });
      }
      sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: i });
    } else if (block.type === 'tool_use') {
      sseWrite(res, 'content_block_start', {
        type: 'content_block_start',
        index: i,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      const json = JSON.stringify(block.input || {});
      sseWrite(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: i,
        delta: { type: 'input_json_delta', partial_json: json },
      });
      sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: i });
    }
  }
  sseWrite(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: msg.stop_reason, stop_sequence: null },
    usage: { output_tokens: msg.usage.output_tokens },
  });
  sseWrite(res, 'message_stop', { type: 'message_stop' });
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP handling
// ─────────────────────────────────────────────────────────────────────────────

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function handleMessages(req, res) {
  let raw = '';
  for await (const chunk of req) raw += chunk.toString();
  let body;
  try { body = JSON.parse(raw); } catch (e) {
    return sendJson(res, 400, {
      type: 'error',
      error: { type: 'invalid_request_error', message: `bad json: ${e.message}` },
    });
  }

  const stream = body.stream === true;
  const prompt = buildUserTurnText(body);
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  log(`POST /v1/messages model=${body.model} msgs=${(body.messages || []).length} tools=${hasTools ? body.tools.length : 0} promptChars=${prompt.length} stream=${stream}`);

  // Open the SSE stream early with a keepalive so callers don't time out
  // while claude is starting up.
  let ping = null;
  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 5000);
  }

  let claudeResult;
  try {
    claudeResult = await runClaude(prompt);
  } catch (e) {
    log('claude invocation failed:', e.message);
    if (ping) clearInterval(ping);
    if (stream) return sendSseError(res, e.message);
    return sendJson(res, 500, { type: 'error', error: { type: 'api_error', message: e.message } });
  }
  if (ping) clearInterval(ping);

  const { preamble, toolCalls } = hasTools
    ? parseToolCalls(claudeResult.text)
    : { preamble: (claudeResult.text || '').trim(), toolCalls: [] };

  const content = buildAnthropicContent(preamble, toolCalls);
  const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';
  const msg = buildAnthropicMessage({
    model: body.model,
    content,
    stopReason,
    usage: claudeResult.usage,
  });

  log(`response stopReason=${stopReason} blocks=${content.length}${toolCalls.length ? ` tools=${toolCalls.map(t => t.name).join(',')}` : ''} textChars=${preamble.length}`);

  if (stream) {
    emitAnthropicStream(res, msg);
    res.end();
  } else {
    sendJson(res, 200, msg);
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
    return handleMessages(req, res);
  }
  sendJson(res, 404, {
    type: 'error',
    error: { type: 'not_found', message: 'Only POST /v1/messages supported' },
  });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${PORT}`);
});
