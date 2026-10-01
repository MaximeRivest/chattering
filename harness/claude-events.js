'use strict';
// Claude Code's stream-json output (claude -p --output-format stream-json
// --include-partial-messages), turned into the events a Pi run emits, so
// the live run view, approval cards, speed meter and quiet watch read a
// Claude Code run exactly as they read a Pi run (design/87).
//
// Pure: feed records in order, get Pi-shaped events back. The process,
// the stdin side of the control protocol and the approvals live in
// claude-code.js. Recorded real output is in
// test/fixtures/harness/claude-stream-*.jsonl.
//
// Mapping:
//   stream_event message_start            → message_start (assistant)
//   content_block_delta text/thinking      → message_update text_delta / thinking_delta
//   content_block_start tool_use           → message_update toolcall_start
//   content_block_delta input_json_delta   → message_update toolcall_delta
//   content_block_stop (tool_use)          → message_update toolcall_end, then
//                                            tool_execution_start: Claude Code
//                                            runs its own tools after the call
//   message_stop                           → message_end, with the whole message
//   user message tool_result               → tool_execution_end
//   result                                 → agent_end (and the error, if any)
// Records from a helper agent (parent_tool_use_id set) never open messages
// of their own: their text becomes progress on the parent's tool card.

const PROVIDER = 'claude-code';

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(b => (b && b.type === 'text' ? b.text : b && b.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
}

function createClaudeTranslator({ now = () => Date.now() } = {}) {
  let msg = null;            // the assistant message streaming now
  let model = null;
  const blocks = new Map();  // content index → { type, id, name, json, text }
  const openTools = new Map(); // tool_use_id → name
  const helperText = new Map(); // parent tool_use_id → a helper agent's words so far
  const info = { sessionId: null, model: null, tools: [], version: null, rateLimit: null, cost: null, usage: null };

  function contentOf() {
    return [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'thinking') return { type: 'thinking', thinking: b.text, ...(b.signature ? { thinkingSignature: b.signature } : {}) };
      if (b.type === 'tool_use') return { type: 'toolCall', id: b.id, name: b.name, arguments: b.args || {} };
      return null;
    }).filter(Boolean);
  }

  function push(record) {
    const out = [];
    if (!record || typeof record !== 'object') return out;
    const sub = record.parent_tool_use_id || null;

    if (record.type === 'system' && record.subtype === 'init') {
      info.sessionId = record.session_id || info.sessionId;
      info.model = record.model || info.model;
      info.tools = Array.isArray(record.tools) ? record.tools : info.tools;
      info.version = record.claude_code_version || info.version;
      out.push({ type: 'harness_info', harness: PROVIDER, ...info });
      return out;
    }
    if (record.type === 'rate_limit_event' && record.rate_limit_info) {
      info.rateLimit = record.rate_limit_info;
      out.push({ type: 'harness_limits', harness: PROVIDER, limits: record.rate_limit_info });
      return out;
    }

    if (record.type === 'stream_event' && record.event) {
      const e = record.event;
      if (sub) {
        // A helper agent's own stream: show its words on the parent tool.
        if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') {
          const text = ((helperText.get(sub) || '') + (e.delta.text || '')).slice(-4000);
          helperText.set(sub, text);
          out.push({ type: 'tool_execution_update', toolCallId: sub, partialResult: { content: [{ type: 'text', text }] } });
        }
        return out;
      }
      if (e.type === 'message_start') {
        model = (e.message && e.message.model) || model || info.model;
        blocks.clear();
        msg = { role: 'assistant', provider: PROVIDER, model, content: [], usage: { ...(e.message?.usage || {}) }, timestamp: now() };
        out.push({ type: 'message_start', message: { ...msg } });
      } else if (e.type === 'content_block_start' && e.content_block) {
        const cb = e.content_block;
        const b = { type: cb.type, id: cb.id || null, name: cb.name || null, json: '', text: cb.text || cb.thinking || '' };
        blocks.set(e.index, b);
        if (cb.type === 'tool_use') out.push({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: e.index } });
      } else if (e.type === 'content_block_delta' && e.delta) {
        const b = blocks.get(e.index) || (blocks.set(e.index, { type: '', json: '', text: '' }), blocks.get(e.index));
        const d = e.delta;
        if (d.type === 'text_delta') {
          b.type = b.type || 'text'; b.text += d.text || '';
          out.push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: e.index, delta: d.text || '' } });
        } else if (d.type === 'thinking_delta') {
          b.type = 'thinking'; b.text += d.thinking || '';
          out.push({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: e.index, delta: d.thinking || '' } });
        } else if (d.type === 'signature_delta') {
          b.signature = (b.signature || '') + (d.signature || '');
        } else if (d.type === 'input_json_delta') {
          b.json += d.partial_json || '';
          out.push({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: e.index, delta: d.partial_json || '' } });
        }
      } else if (e.type === 'content_block_stop') {
        const b = blocks.get(e.index);
        if (b && b.type === 'tool_use') {
          try { b.args = b.json ? JSON.parse(b.json) : {}; } catch { b.args = {}; }
          const toolCall = { type: 'toolCall', id: b.id, name: b.name, arguments: b.args };
          out.push({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: e.index, toolCall } });
        } else if (b && b.type === 'text') {
          out.push({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: e.index, content: b.text } });
        } else if (b && b.type === 'thinking') {
          out.push({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: e.index, content: b.text } });
        }
      } else if (e.type === 'message_delta') {
        if (msg && e.usage) msg.usage = { ...msg.usage, ...e.usage };
        if (msg && e.delta && e.delta.stop_reason) msg.stopReason = e.delta.stop_reason;
      } else if (e.type === 'message_stop' && msg) {
        const content = contentOf();
        const stop = msg.stopReason === 'tool_use' ? 'toolUse' : msg.stopReason === 'max_tokens' ? 'length' : 'stop';
        info.usage = msg.usage;
        out.push({ type: 'message_end', message: { ...msg, content, stopReason: stop, usage: usageOf(msg.usage) } });
        // Claude Code runs the tools it called now: their cards go live.
        for (const c of content) {
          if (c.type !== 'toolCall') continue;
          openTools.set(c.id, c.name);
          out.push({ type: 'tool_execution_start', toolCallId: c.id, toolName: c.name, args: c.arguments });
        }
        msg = null;
      }
      return out;
    }

    if (record.type === 'user' && record.message && Array.isArray(record.message.content) && !sub) {
      for (const b of record.message.content) {
        if (!b || b.type !== 'tool_result' || !b.tool_use_id) continue;
        const text = toolResultText(b.content);
        out.push({ type: 'tool_execution_end', toolCallId: b.tool_use_id, toolName: openTools.get(b.tool_use_id) || null,
          result: { content: [{ type: 'text', text }] }, isError: !!b.is_error });
        openTools.delete(b.tool_use_id);
        helperText.delete(b.tool_use_id);
      }
      return out;
    }

    if (record.type === 'result') {
      info.cost = typeof record.total_cost_usd === 'number' ? record.total_cost_usd : info.cost;
      const failed = record.is_error || (record.subtype && record.subtype !== 'success');
      if (failed) {
        const errorMessage = String(record.result || (Array.isArray(record.errors) && record.errors.join('; ')) || record.subtype || 'Claude Code stopped with an error');
        out.push({ type: 'message_end', message: { role: 'assistant', provider: PROVIDER, model, content: [], stopReason: 'error', errorMessage, timestamp: now() } });
      }
      out.push({ type: 'agent_end', harness: PROVIDER, sessionId: record.session_id || info.sessionId, cost: info.cost, durationMs: record.duration_ms || null, failed: !!failed });
      return out;
    }
    return out;
  }

  return { push, info };
}

// Anthropic usage (cache tokens outside input) into Pi's usage names.
function usageOf(u) {
  if (!u) return undefined;
  const input = u.input_tokens || 0, output = u.output_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0, cacheWrite = u.cache_creation_input_tokens || 0;
  return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite };
}

// A tool permission question from Claude Code, as the dialog a run card
// shows. The answer comes back through toPermissionResponse.
const ALLOW = 'Allow', ALLOW_ALWAYS = 'Allow for this conversation', DENY = 'Refuse';
function permissionDialog(request) {
  const r = request.request || {};
  const input = r.input || {};
  const what = input.command || input.file_path || input.path || input.url || input.pattern || r.description || '';
  // Native suggestions can change permission mode or persist rules outside
  // this session. Until the HTML card can describe each scope precisely,
  // offer one invocation only; never disguise those as "allow this again".
  const options = [ALLOW, DENY];
  return {
    type: 'extension_ui_request', id: request.request_id, method: 'select',
    title: `Claude Code wants to use ${r.display_name || r.tool_name || 'a tool'}`,
    message: String(what || JSON.stringify(input)).slice(0, 2000),
    options,
  };
}
function toPermissionResponse(request, answer) {
  const r = request.request || {};
  const choice = answer && !answer.cancelled ? (answer.value || (answer.confirmed ? ALLOW : '')) : '';
  let response;
  if (choice === ALLOW) {
    response = { behavior: 'allow', updatedInput: r.input || {} };
  } else {
    response = { behavior: 'deny', message: 'The person refused this in Chattering.' };
  }
  return { type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response } };
}

module.exports = { createClaudeTranslator, permissionDialog, toPermissionResponse, usageOf, PROVIDER, ALLOW, ALLOW_ALWAYS, DENY };
