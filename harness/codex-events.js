'use strict';
// Codex app-server notifications (codex app-server, JSON-RPC over stdio),
// turned into the events a Pi run emits (design/87). Pure: feed JSON-RPC
// messages in order, get Pi-shaped events back. Recorded real traffic is in
// test/fixtures/harness/codex-appserver-*.jsonl.
//
// Codex thinks in items: an agent message, a reasoning summary, a command,
// a file change, an MCP or web tool call. Pi thinks in assistant messages
// holding text, thinking and tool calls, and tool runs. Mapping:
//   agentMessage / reasoning items   → one assistant message each (its text
//                                      or its thinking), streamed by delta
//   commandExecution, fileChange,
//   mcpToolCall, webSearch, …        → a tool run: start, output, end
//   turn/completed                   → agent_end (and the error, if any)
// Approval requests (server requests) become run-card dialogs through
// approvalDialog / toApprovalResult.

const PROVIDER = 'codex';

const TOOL_ITEMS = {
  commandExecution: item => ({ name: 'shell', args: { command: commandText(item) } }),
  fileChange: item => ({ name: 'apply_patch', args: { changes: (item.changes || []).map(c => ({ path: c.path, kind: c.kind && (c.kind.type || c.kind) })) } }),
  mcpToolCall: item => ({ name: [item.server, item.tool].filter(Boolean).join('.') || 'mcp', args: item.arguments || {} }),
  dynamicToolCall: item => ({ name: item.tool || item.name || 'tool', args: item.arguments || {} }),
  webSearch: item => ({ name: 'web_search', args: { query: item.query || '' } }),
  imageView: item => ({ name: 'view_image', args: { path: item.path || '' } }),
  collabAgentToolCall: item => ({ name: 'agent', args: { prompt: item.prompt || '' } }),
};

function commandText(item) {
  const acts = Array.isArray(item.commandActions) ? item.commandActions : [];
  if (acts.length === 1 && acts[0] && acts[0].command) return acts[0].command;
  return String(item.command || '');
}

function resultOf(item) {
  if (item.type === 'commandExecution') return String(item.aggregatedOutput || '');
  if (item.type === 'fileChange') return (item.changes || []).map(c => (c.diff ? c.diff : c.path)).join('\n');
  if (item.type === 'mcpToolCall') {
    const r = item.result;
    if (r && Array.isArray(r.content)) return r.content.map(c => (c && c.text) || '').join('\n');
    if (item.error) return String(item.error.message || item.error);
    return r ? JSON.stringify(r) : '';
  }
  return item.result ? (typeof item.result === 'string' ? item.result : JSON.stringify(item.result)) : '';
}

function failedItem(item) {
  if (item.status === 'failed' || item.status === 'declined') return true;
  if (item.type === 'commandExecution' && typeof item.exitCode === 'number') return item.exitCode !== 0;
  return !!item.error;
}

function createCodexTranslator({ now = () => Date.now(), model = null } = {}) {
  const info = { threadId: null, turnId: null, model, usage: null, limits: null };
  const messages = new Map(); // itemId → { kind: 'text'|'thinking', text }
  const toolOut = new Map();  // itemId → output so far
  let lastError = null;

  function startMessage(id, kind) {
    if (messages.has(id)) return [];
    messages.set(id, { kind, text: '' });
    return [{ type: 'message_start', message: { role: 'assistant', provider: PROVIDER, model: info.model, content: [], timestamp: now() } }];
  }
  function endMessage(id, finalText) {
    const m = messages.get(id);
    if (!m || m.ended) return [];
    m.ended = true;
    if (typeof finalText === 'string' && finalText) m.text = finalText;
    const content = m.kind === 'thinking' ? [{ type: 'thinking', thinking: m.text }] : [{ type: 'text', text: m.text }];
    return [
      { type: 'message_update', assistantMessageEvent: { type: m.kind === 'thinking' ? 'thinking_end' : 'text_end', contentIndex: 0, content: m.text } },
      { type: 'message_end', message: { role: 'assistant', provider: PROVIDER, model: info.model, content, stopReason: 'stop', timestamp: now() } },
    ];
  }
  function delta(id, kind, text) {
    const out = startMessage(id, kind);
    const m = messages.get(id);
    m.text += text || '';
    out.push({ type: 'message_update', assistantMessageEvent: { type: kind === 'thinking' ? 'thinking_delta' : 'text_delta', contentIndex: 0, delta: text || '' } });
    return out;
  }

  function push(rpc) {
    const out = [];
    if (!rpc || typeof rpc !== 'object' || !rpc.method) return out;
    const p = rpc.params || {};
    switch (rpc.method) {
      case 'thread/started':
        info.threadId = (p.thread && p.thread.id) || info.threadId;
        out.push({ type: 'harness_info', harness: PROVIDER, threadId: info.threadId, model: info.model });
        break;
      case 'turn/started':
        info.turnId = (p.turn && p.turn.id) || info.turnId;
        break;
      case 'model/rerouted':
        if (p.toModel || p.model) info.model = p.toModel || p.model;
        break;
      case 'item/agentMessage/delta':
        out.push(...delta(p.itemId, 'text', p.delta));
        break;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        out.push(...delta(p.itemId, 'thinking', p.delta));
        break;
      case 'item/reasoning/summaryPartAdded':
        if (messages.has(p.itemId)) out.push(...delta(p.itemId, 'thinking', '\n\n'));
        break;
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta': {
        const text = ((toolOut.get(p.itemId) || '') + (p.delta || '')).slice(-8000);
        toolOut.set(p.itemId, text);
        out.push({ type: 'tool_execution_update', toolCallId: p.itemId, partialResult: { content: [{ type: 'text', text }] } });
        break;
      }
      case 'item/started': {
        const item = p.item || {};
        const tool = TOOL_ITEMS[item.type];
        if (tool) {
          const t = tool(item);
          out.push({ type: 'tool_execution_start', toolCallId: item.id, toolName: t.name, args: t.args });
        } else if (item.type === 'userMessage') {
          out.push({ type: 'message_end', message: { role: 'user', content: (item.content || []).filter(c => c && c.type === 'text').map(c => ({ type: 'text', text: c.text })), timestamp: now() } });
        }
        break;
      }
      case 'item/completed': {
        const item = p.item || {};
        if (item.type === 'agentMessage') {
          out.push(...startMessage(item.id, 'text'), ...endMessage(item.id, item.text));
        } else if (item.type === 'reasoning') {
          const text = [...(item.summary || []), ...(item.content || [])].map(s => (typeof s === 'string' ? s : s && s.text) || '').filter(Boolean).join('\n\n');
          if (messages.has(item.id) || text) out.push(...startMessage(item.id, 'thinking'), ...endMessage(item.id, text));
        } else if (TOOL_ITEMS[item.type]) {
          const t = TOOL_ITEMS[item.type](item);
          out.push({ type: 'tool_execution_end', toolCallId: item.id, toolName: t.name,
            result: { content: [{ type: 'text', text: resultOf(item) || toolOut.get(item.id) || '' }] }, isError: failedItem(item) });
          toolOut.delete(item.id);
        }
        break;
      }
      case 'thread/tokenUsage/updated':
        info.usage = p.tokenUsage || p.usage || info.usage;
        break;
      case 'account/rateLimits/updated':
        info.limits = p.rateLimits || info.limits;
        out.push({ type: 'harness_limits', harness: PROVIDER, limits: info.limits });
        break;
      case 'error':
        lastError = String((p.error && (p.error.message || p.error)) || p.message || 'Codex reported an error');
        break;
      case 'turn/completed': {
        const turn = p.turn || {};
        for (const id of messages.keys()) out.push(...endMessage(id));
        const failed = turn.status === 'failed' || !!turn.error;
        const interrupted = turn.status === 'interrupted';
        if (failed || interrupted) {
          const errorMessage = interrupted ? 'aborted' : String((turn.error && (turn.error.message || turn.error)) || lastError || 'Codex stopped with an error');
          out.push({ type: 'message_end', message: { role: 'assistant', provider: PROVIDER, model: info.model, content: [], stopReason: interrupted ? 'aborted' : 'error', errorMessage, timestamp: now() } });
        }
        out.push({ type: 'agent_end', harness: PROVIDER, threadId: info.threadId, turnId: turn.id || info.turnId, failed, interrupted, usage: info.usage });
        break;
      }
      default:
        break;
    }
    return out;
  }

  return { push, info };
}

// Approval requests Codex sends to its client, as run-card dialogs.
const ALLOW = 'Allow', ALLOW_ALWAYS = 'Allow for this conversation', DENY = 'Refuse', STOP = 'Refuse and stop';
const APPROVAL_METHODS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'execCommandApproval', 'applyPatchApproval']);
function approvalDialog(rpc) {
  const p = rpc.params || {};
  const isCommand = /command|exec/i.test(rpc.method);
  const what = isCommand ? (Array.isArray(p.command) ? p.command.join(' ') : String(p.command || '')) : String(p.reason || p.grantRoot || 'file changes');
  return {
    type: 'extension_ui_request', id: 'codex:' + rpc.id, method: 'select',
    title: isCommand ? 'Codex wants to run a command' : 'Codex wants to change files',
    message: (what + (p.reason && isCommand ? '\n\n' + p.reason : '')).slice(0, 2000),
    options: [ALLOW, ALLOW_ALWAYS, DENY, STOP],
  };
}
function toApprovalResult(rpc, answer) {
  const choice = answer && !answer.cancelled ? answer.value : '';
  const decision = choice === ALLOW ? 'accept' : choice === ALLOW_ALWAYS ? 'acceptForSession' : choice === STOP ? 'cancel' : 'decline';
  // The v1 methods (execCommandApproval, applyPatchApproval) name the same
  // choices differently.
  const legacy = { accept: 'approved', acceptForSession: 'approved_for_session', decline: 'denied', cancel: 'abort' };
  const value = rpc.method === 'execCommandApproval' || rpc.method === 'applyPatchApproval' ? legacy[decision] : decision;
  return { jsonrpc: '2.0', id: rpc.id, result: { decision: value } };
}

module.exports = { createCodexTranslator, approvalDialog, toApprovalResult, APPROVAL_METHODS, PROVIDER, ALLOW, ALLOW_ALWAYS, DENY, STOP };
