import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { appendFileSync, existsSync } from 'node:fs';

// Offline, deliberately authorized fixture provider. Never contacts a model
// or a running Chattering server; unexpected fetches are test failures.
export default function(pi: any) {
  const record = (value: any) => appendFileSync(process.env.WEB_POLICY_LOG!, JSON.stringify(value) + '\n');
  globalThis.fetch = async (input: any, options: any) => {
    const url = String(input);
    if (url === 'http://127.0.0.1:1/api/artifacts/declare') {
      record({ artifact: JSON.parse(options.body) });
      return new Response(JSON.stringify({ kind: 'web', path: 'widget.html', urls: ['fixture://widget'] }));
    }
    throw new Error('Unexpected network request: ' + url);
  };
  pi.registerProvider('web-policy-fixture', {
    api: 'web-policy-offline', apiKey: 'fixture-not-a-credential', baseUrl: 'fixture://offline',
    models: [{ id: 'offline', name: 'Offline', reasoning: true, input: ['text', 'image'],
      contextWindow: 200000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model: any, context: any) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const system = context.messages.filter((m: any) => m.role === 'system');
        record({ request: { systemPrompt: system.map((m: any) => [typeof m.content === 'string' ? m.content : JSON.stringify(m.content), ...Object.values(m.sections || {})].join('\n')).join('\n'), messages: context.messages.map((m: any) => ({ ...m,
          content: Array.isArray(m.content) ? m.content.map((b: any) => b.type === 'image' ? { type: 'image', bytes: b.data.length } : b) : m.content })),
          tools: system.flatMap((m: any) => (m.toolsAdded || []).map((t: any) => t.name)) } });
        const user = [...context.messages].reverse().find(m => m.role === 'user');
        const text = typeof user?.content === 'string' ? user.content : (user?.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
        if (text === 'fixture-hold') {
          record({ holding: true });
          for (let i = 0; i < 1000 && !existsSync(process.env.WEB_POLICY_RELEASE!); i++) await new Promise(r => setTimeout(r, 5));
        }
        const toolDone = context.messages.at(-1)?.role === 'toolResult';
        const content = text === 'fixture-artifacts' && !toolDone ? [
          { type: 'toolCall', id: 'show-fixture', name: 'show', arguments: { html: '<p>fixture</p>', title: 'Fixture' } },
          { type: 'toolCall', id: 'artifact-fixture', name: 'artifact', arguments: { path: 'widget.html', title: 'Fixture' } },
        ] : [{ type: 'text', text: 'offline fixture complete' }];
        const output: any = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          content, stopReason: toolDone || text !== 'fixture-artifacts' ? 'stop' : 'toolUse', timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'start', partial: output });
        stream.push({ type: 'done', reason: output.stopReason, message: output });
        stream.end();
      })().catch(error => { stream.end(); throw error; });
      return stream;
    },
  });
  pi.on('session_start', (_e: any, ctx: any) => record({ startup: { mode: ctx.mode, tools: pi.getAllTools().map((t: any) => t.name) } }));
  pi.on('session_shutdown', () => record({ shutdown: true }));
}
