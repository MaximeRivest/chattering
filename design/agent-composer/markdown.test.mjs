import test from 'node:test';
import assert from 'node:assert/strict';
import {renderMarkdown} from './markdown.mjs';
test('reports escape active HTML rather than executing it',()=>{const s=renderMarkdown('<script>alert(1)</script>\n\n`<img src=x onerror=run()>`');assert(!s.includes('<script>'));assert(!s.includes('<img'));assert(s.includes('&lt;script&gt;'));});
test('headings and code specimens remain readable',()=>{const s=renderMarkdown('# Title\n\n**Note**\n\n```text\n<a>\n```');assert.match(s,/<h2>Title<\/h2>/);assert.match(s,/<strong>Note<\/strong>/);assert.match(s,/<pre><code>&lt;a&gt;/);});
test('evidence tables have headers and their own scroll region',()=>{const s=renderMarkdown('| Agent | Status |\n|---|---|\n| Pi | SDK |');assert.match(s,/role="region"/);assert.match(s,/<th scope="col">Agent/);assert.match(s,/<td>Pi<\/td>/);});
