import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import fs from 'node:fs';
import path from 'node:path';
// The system prompt a provider receives: before Pi 0.87 a context field;
// since, system messages in the transcript (content, then named sections).
function systemText(context: any): string {
  if (typeof context.systemPrompt === 'string') return context.systemPrompt;
  const text = (c: any) => typeof c === 'string' ? c : (c || []).map((b: any) => b?.text || '').join('');
  return (context.messages || []).filter((m: any) => m?.role === 'system')
    .map((m: any) => [text(m.content), ...Object.values(m.sections || {}).filter(Boolean)].join('\n')).join('\n');
}

export default function (pi: any) {
  let requests = 0;
  pi.registerProvider('fixture', {
    baseUrl: 'http://127.0.0.1:1/never-used', apiKey: 'fixture-only', api: 'openai-completions',
    models: [{ id: 'one', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 },
      { id: 'two', name: 'Fixture two', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1000 }],
    streamSimple(model: any, context: any, options: any) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        await options?.onPayload?.({ input: 'fixture' }, model);
        if (options?.signal?.aborted) {
          const error = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
            stopReason: 'aborted', errorMessage: 'Fixture request aborted before provider work.', timestamp: Date.now() };
          stream.push({ type: 'error', reason: 'aborted', error }); stream.end(); return;
        }
        if (process.env.FIXTURE_REQUEST_MARKER) fs.appendFileSync(process.env.FIXTURE_REQUEST_MARKER, 'request\n');
        if (process.env.FIXTURE_WIRE_LOG) fs.appendFileSync(process.env.FIXTURE_WIRE_LOG, JSON.stringify({ model: model.id, provider: model.provider, context, reasoning: options?.reasoning, sessionId: options?.sessionId }) + '\n');
        const last = context.messages.at(-1);
        const input = typeof last?.content === 'string' ? last.content : (last?.content || []).map((b: any) => b.text || '').join('');
        const rewrite = input.startsWith('Wait, I don’t get it. Re-explain your entire last answer simply');
        const call = last?.role === 'user' && input.includes('capture environment');
        const content = call ? [{ type: 'toolCall', id: 'env-probe', name: 'bash', arguments: {
          command: `node -e 'if(process.env.FIXTURE_CHECKPOINT_WRITE) require("fs").writeFileSync("probe.txt","checkpointed"); console.log(JSON.stringify({session:process.env.PI_SESSION_ID,fixture:process.env.FIXTURE_SESSION,mode:process.env.PI_EFFECTIVE_PROMPT_MODE}))'`,
        } }, ...(process.env.FIXTURE_CHECKPOINT_WRITE ? [{ type: 'toolCall', id: 'target-probe', name: 'write', arguments: { path: 'scratch/probe.txt', content: 'target checkpoint' } }] : [])] : [{ type: 'text', text: rewrite ? 'The full explanation in everyday words.' : 'Fixture reply.' }];
        const result = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: call ? 'toolUse' : 'stop', timestamp: Date.now() };
        requests++;
        if (process.env.FIXTURE_LIMIT_MODEL && model.id === process.env.FIXTURE_LIMIT_MODEL) {
          Object.assign(result, { content: [], stopReason: 'error', errorMessage: 'Fixture request failed (429): rate_limit_error' });
          stream.push({ type: 'error', reason: 'error', error: result }); stream.end(); return;
        }
        if (process.env.FIXTURE_ECHO_HISTORY && !call) {
          const seen = context.messages.filter((m: any) => m.role === 'user').length;
          result.content = [{ type: 'text', text: `Fixture reply after ${seen} user messages.` }];
        }
        if (process.env.FIXTURE_RETRY_ONCE && requests === 1) {
          Object.assign(result, { content: [], stopReason: 'error', errorMessage: 'terminated' });
          stream.push({ type: 'error', reason: 'error', error: result }); stream.end(); return;
        }
        if (process.env.FIXTURE_EXPECT_MODE && !systemText(context).includes('# Current prompt mode: ' + process.env.FIXTURE_EXPECT_MODE)) {
          Object.assign(result, { content: [], stopReason: 'error', errorMessage: 'Callback lost its prompt mode.' });
          stream.push({ type: 'error', reason: 'error', error: result }); stream.end(); return;
        }
        if (process.env.FIXTURE_SPEED_STREAM && !call) {
          const text = result.content[0].text;
          const partial = { ...result, content: [{ type: 'text', text: '' }] };
          stream.push({ type: 'start', partial });
          stream.push({ type: 'text_start', contentIndex: 0, partial });
          partial.content[0].text = text.slice(0, 4);
          stream.push({ type: 'text_delta', contentIndex: 0, delta: text.slice(0, 4), partial });
          await new Promise(resolve => setTimeout(resolve, 20));
          partial.content[0].text = text;
          stream.push({ type: 'text_delta', contentIndex: 0, delta: text.slice(4), partial });
          stream.push({ type: 'text_end', contentIndex: 0, content: text, partial });
        } else stream.push({ type: 'start', partial: result });
        stream.push({ type: 'done', reason: result.stopReason, message: result });
        stream.end();
      });
      return stream;
    },
  });
  pi.on('session_start', (_: any, ctx: any) => { process.env.FIXTURE_SESSION = ctx.sessionManager.getSessionId(); });
  pi.on('before_agent_start', () => {
    if (process.env.FIXTURE_MUTATE_MODE && process.env.PI_DELEGATION_ID) {
      const file = path.join(process.env.PI_DELEGATION_ROOT!, process.env.PI_DELEGATION_ID, 'mode.json');
      const mode = JSON.parse(fs.readFileSync(file, 'utf8')); mode.appendix = 'Changed fixture snapshot.';
      fs.writeFileSync(file, JSON.stringify(mode));
    }
  });
  pi.registerCommand('probe-dialog', { handler: async (_: any, ctx: any) => {
    const value = await ctx.ui.select('Probe choice', ['yes', 'no']);
    ctx.ui.notify('choice:' + value, 'info');
  } });
  pi.registerCommand('probe-later', { handler: async () => {
    setTimeout(() => pi.sendMessage({ customType: 'fixture-callback', content: 'A fixture completed.', display: true }, { triggerTurn: true, deliverAs: 'followUp' }), 100);
  } });
}
