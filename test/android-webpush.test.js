'use strict';
// The Android app opens what a computer sends it (WebPushCrypto.kt, design/100):
// the RFC 8291 example, a message from push.js to keys the app made, and the
// mailbox id the relay derives (anywhere/mailbox.js). Compiled on a desktop
// JVM; skipped where kotlinc is not on PATH (nix shell nixpkgs#kotlin nixpkgs#jdk17).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const push = require('../push.js');
const { idOf } = require('../anywhere/mailbox.js');

const has = cmd => spawnSync('sh', ['-c', 'command -v ' + cmd], { encoding: 'utf8' }).status === 0;
const SRC = path.join(__dirname, '../android/app/src/main/java/app/rockfrog/chattering/WebPushCrypto.kt');

test('the app decrypts what the computer encrypts, and finds the same mailbox', { skip: !(has('kotlinc') && has('java')) && 'kotlinc and java are not on PATH', timeout: 600000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpush-kt-'));
  fs.writeFileSync(path.join(dir, 'Main.kt'), `import app.rockfrog.chattering.WebPushCrypto
fun main(args: Array<String>) {
    when (args[0]) {
        "gen" -> { val g = WebPushCrypto.generate(); println(WebPushCrypto.b64u(g.publicRaw) + " " + WebPushCrypto.b64u(g.privateD) + " " + WebPushCrypto.b64u(g.auth)) }
        "dec" -> { val k = WebPushCrypto.Keys(WebPushCrypto.unb64u(args[1]), WebPushCrypto.unb64u(args[2]), WebPushCrypto.unb64u(args[3])); print(String(WebPushCrypto.decrypt(WebPushCrypto.unb64u(args[4]), k))) }
        "id" -> print(WebPushCrypto.mailboxId(args[1]))
    }
}
`);
  const jar = path.join(dir, 't.jar');
  execFileSync('kotlinc', [SRC, path.join(dir, 'Main.kt'), '-include-runtime', '-d', jar], { stdio: 'pipe' });
  const run = (...a) => execFileSync('java', ['-jar', jar, ...a], { encoding: 'utf8' });
  // RFC 8291, Section 5.
  assert.equal(run('dec', 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94', 'BTBZMqHH6r4Tts7J_aSIgg',
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'),
    'When I grow up, I want to be a watermelon');
  // Keys made by the app, a padded message from the computer.
  const [pub, d, auth] = run('gen').trim().split(' ');
  const msg = JSON.stringify({ v: 1, kind: 'reply', title: 'Plan ✓', body: 'ready' });
  const body = push.b64u(push.encryptPayload(msg, pub, auth, { padTo: 512 }));
  assert.equal(run('dec', pub, d, auth, body), msg);
  const secret = 'Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eA';
  assert.equal(run('id', secret), idOf(secret));
  fs.rmSync(dir, { recursive: true, force: true });
});
