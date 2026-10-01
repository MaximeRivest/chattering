'use strict';

const os = require('os');
const { PROMPT: DEFAULT_SIMPLIFY_PROMPT } = require('./pisdk-rewrite');

const DEFAULT_CONTEXT_TOKENS = 272000;

// Sent as the user turn when an interrupted conversation is resumed, by the
// Resume button or by automatic connection recovery. Editable in Settings.
const DEFAULT_RESUME_PROMPT = 'Sorry, you were interrupted, continue';

// One semantic namespace per user: the GPU index never mixes two installs.
function defaultSemanticNs() {
  try { return String(os.userInfo().username || '').trim() || 'default'; }
  catch { return 'default'; }
}
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// What the speakers do when a web run finishes with a reply. One ordered
// ladder, quietest first:
//   off     — nothing
//   chime   — one short sound, no speech, no network
//   title   — one spoken line naming the conversation that returned
//   summary — that line plus a short spoken digest of the reply
//   voice   — the digest, then the microphone opens for a reply or command
const DONE_SOUND_MODES = ['off', 'chime', 'title', 'summary', 'voice'];

// Version 2 (2026-09-23, TODO item 2 "safe for strangers"): a new install
// starts neutral. No personal server addresses, no fixed model, no speech
// that needs a server, and no model call it was not asked for
// (backgroundAi). An install that predates version 2 is migrated with the
// values it was already using (LEGACY_DEFAULTS), so nothing changes for it.
//
// Version 3 (2026-09-27, design/75): the welcome is shown once per install,
// on its first open, whether or not conversations already exist; `welcome`
// remembers it was done. An install that ran before this version has had
// its first open, so it is migrated as done and nothing appears on update.
const SETTINGS_VERSION = 3;
const WELCOME_UNDONE = { doneAt: null };

// Background AI work: model calls Chattering makes without being asked in
// that moment. Nothing runs until the owner has decided (decidedAt).
//   names  — short titles for conversations, projects and document commits
//   memory — re-reading changed conversations into project memory
const BACKGROUND_AI_KINDS = ['names', 'memory'];
const BACKGROUND_AI_UNDECIDED = { decidedAt: null, names: false, memory: false };

const DEFAULT_SETTINGS = {
  settingsVersion: SETTINGS_VERSION,
  // The model for notes, titles and memory: Pi's own default until the
  // person picks one.
  usePiDefault: true,
  provider: '',
  model: '',
  thinking: 'off',
  contextTokens: DEFAULT_CONTEXT_TOKENS,
  // Optional GPU-server late-interaction search stage (off by default).
  semanticSearch: false,
  semanticUrl: '',
  semanticNs: defaultSemanticNs(),
  // Optional voice services, all set up in settings → sound. Empty: not
  // set up, and the controls that need them say so instead of failing.
  //   speechUrl     — speech-to-text (dictation, the voice reply loop)
  //   ttsUrl        — text-to-speech (read aloud, spoken announcements)
  //   ttsVoice      — the voice name the TTS server knows; empty: its default
  //   voiceModelUrl — an OpenAI-compatible chat endpoint for spoken digests
  //   voiceModel    — the model name at that endpoint
  speechUrl: '',
  ttsUrl: '',
  ttsVoice: '',
  voiceModelUrl: '',
  voiceModel: '',
  backgroundAi: { ...BACKGROUND_AI_UNDECIDED },
  welcome: { ...WELCOME_UNDONE },
  // Engine for web sends: 'sdk' embeds pi in-process (fast forks, full
  // extension UI); 'rpc' spawns pi child processes (isolation fallback).
  piEngine: 'sdk',
  // Artifacts (design/67). artifactNetwork: 'open' lets artifact pages load
  // and call anything (trust is the default); 'libraries' limits scripts,
  // styles, fonts and network calls to the public library sites.
  // previewBase: a public preview address with {id} for each artifact's own
  // site (https://{id}.preview.example.com); empty: this machine's ports.
  artifactNetwork: 'open',
  previewBase: '',
  // AI programs (design/74): agents' processes log their FunctAI calls to
  // the call log Chattering reads. Off: FunctAI's own rule (logging only
  // where someone turned it on).
  programsRecordAgents: false,
  // One same-model editing pass after a human-facing SDK reply.
  simplifyAnswers: true,
  simplifyPrompt: DEFAULT_SIMPLIFY_PROMPT,
  // Work steps in plain words (plain-steps.js), for readers who do not
  // program. Off until the owner turns it on: each group of steps someone
  // looks at is one call. provider/model: the model that writes them, best a
  // small fast one; empty: the model above (notes and titles).
  plainSteps: { on: false, provider: '', model: '' },
  autoResumeNetwork: false,
  resumePrompt: DEFAULT_RESUME_PROMPT,
  // Running work whose output has not moved for this many minutes is
  // reported (design/29): to the agent that started it, else to the person.
  // Never stopped. 0 turns the watch off.
  quietMinutes: 20,
  // pi theme for hosted extension views (custom TUI components rendered
  // in the browser). 'light' matches Chattering's paper look.
  piTheme: 'light',
  // Typed in the composer, this opens the snippet picker inline. Two
  // semicolons: almost never in prose or code, and one key on most layouts.
  snippetTrigger: ';;',
  // Three short notes: no speech, no network. Speech modes need ttsUrl.
  doneSound: 'chime',
  // Cost analytics keeps billing classification separate from Pi's retail
  // cost estimate. Rules are provider-scoped and never contain credentials.
  usageBilling: { providerModes: {}, monthlyFees: {} },
  // Team settings (design/72). Spending limits per person per calendar
  // month, in the dashboard's estimated dollars; null means none.
  budgets: { monthlyPerPerson: null, people: {} },
  // household: people share the account's powers (polite walls, design/46).
  // per-person: every non-administrator is walled like a guest: their own
  // agent folder, only the projects shared with them, nothing else.
  isolation: 'household',
  // Company sign-in through OpenID Connect; off while issuer is empty.
  sso: { issuer: '', clientId: '', clientSecret: '', name: '', allowedDomains: [], autoProvision: false, groupsClaim: 'groups', adminGroups: [], sessionHours: 12 },
  // Other Chattering installs reachable from the header machine switcher.
  // Each entry: { name, url, token, publicKey? }. The token is that
  // machine's LAN token; publicKey its handoff signing key, when known.
  machines: [],
  // Reachable from other devices on the network. null: never chosen in the
  // app, so the service environment (CHATTERING_LAN=1) decides. Once someone
  // flips the switch in settings → machines, that choice wins and persists.
  lan: null,
  // What one guest may use of this machine, all their processes together
  // (design/55). Empty strings and 0 mean "derive from the machine": a
  // quarter of the memory, half the cores, 512 tasks. memory: a systemd
  // size (8G, 512M); cpu: a percentage of one core (200% = two cores).
  guestLimits: { memory: '', cpu: '', tasks: 0 },
  // The doors through Tailscale (design/56). publicDoor: the Funnel switch
  // as the owner last set it (the live state is asked of tailscale each
  // time). tailscaleApiKey: an API access token, only to mint device
  // invites for the tailnet door; never leaves the settings of the owner.
  publicDoor: false,
  tailscaleApiKey: '',
  // Chattering Anywhere (design/85): phones reach this computer through a
  // relay. relay: its address, '' for Rockfrog's; off: the owner's switch.
  anywhere: { relay: '', off: false },
  // Agents continued in their own interactive program (design/91), per
  // agent: 'off' (never), 'choose' (Chattering's box, the program a click
  // away), 'always' (the program). Claude Code has no box of Chattering's
  // own, so for it 'choose' is 'always'. idleMinutes: a program with nothing
  // to do is ended after this long (the next message starts it again).
  // record: each session's terminal and devices are kept, gzip, private.
  // args: options each program is started with, as words (for this run
  // only: e.g. Claude Code's --permission-mode, Codex's -c key=value).
  liveTerminal: { agents: { claude: 'always', pi: 'choose', codex: 'choose' }, idleMinutes: 30, record: true, args: { claude: [], pi: [], codex: [] } },
};

// What an install from before version 2 ran on without having saved it:
// the old code defaults (the family GPU server on the tailnet, Maxime's
// model, spoken summaries). Only the migration uses these.
const LEGACY_DEFAULTS = {
  provider: 'openai-codex',
  model: 'gpt-5.6-sol',
  semanticUrl: 'http://100.86.49.54:8090',
  doneSound: 'voice',
  speechUrl: 'http://100.86.49.54:8078',
  ttsUrl: 'http://100.86.49.54:8880',
  ttsVoice: 'bm_george',
  voiceModelUrl: 'http://100.86.49.54:8000/v1/chat/completions',
  voiceModel: 'qwen/qwen3.8-27b',
};

// Bring a settings file up to the current version. `raw` is the file as
// read (null when there is none); `priorInstall` says whether this machine
// ran Chattering before (the caller looks for its data). A prior install
// keeps exactly the behaviour it had: every value the old code filled in
// silently is written down, and background AI stays on as it was. A new
// install gets the neutral defaults and is asked. Pure: the caller writes.
function migrateSettings(raw, { priorInstall = false } = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  const version = Number(src.settingsVersion) || 0;
  if (version >= SETTINGS_VERSION) return { settings: src, migrated: false };
  // Version 3: a file at version 2 was written by a run of Chattering, and
  // an older one counts when the machine ran before. Either had its first open.
  if (version === 2 || priorInstall) src.welcome = { doneAt: 'before-welcome' };
  if (version < 2 && priorInstall) {
    // Mirror the old normalizer exactly: only `usePiDefault === true` meant
    // Pi's default, and an empty provider, model or URL meant the default.
    if (src.usePiDefault !== true) {
      src.usePiDefault = false;
      if (!String(src.provider || '').trim()) src.provider = LEGACY_DEFAULTS.provider;
      if (!String(src.model || '').trim()) src.model = LEGACY_DEFAULTS.model;
    }
    if (!String(src.semanticUrl || '').trim()) src.semanticUrl = LEGACY_DEFAULTS.semanticUrl;
    if (!DONE_SOUND_MODES.includes(src.doneSound)) src.doneSound = LEGACY_DEFAULTS.doneSound;
    // The voice endpoints were constants in server.js; environment
    // variables still override them at run time, as before.
    for (const k of ['speechUrl', 'ttsUrl', 'ttsVoice', 'voiceModelUrl', 'voiceModel']) {
      if (typeof src[k] !== 'string') src[k] = LEGACY_DEFAULTS[k];
    }
    if (!src.backgroundAi || typeof src.backgroundAi !== 'object') {
      src.backgroundAi = { decidedAt: 'before-consent', names: true, memory: true };
    }
  }
  src.settingsVersion = SETTINGS_VERSION;
  return { settings: src, migrated: true };
}

function normalizeWelcome(raw) {
  const doneAt = raw && typeof raw.doneAt === 'string' && raw.doneAt.trim() ? raw.doneAt.trim().slice(0, 40) : null;
  return { doneAt };
}

function normalizeBackgroundAi(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const decidedAt = typeof src.decidedAt === 'string' && src.decidedAt.trim() ? src.decidedAt.trim().slice(0, 40) : null;
  // Nothing is on before a decision, whatever the file says.
  if (!decidedAt) return { ...BACKGROUND_AI_UNDECIDED };
  return { decidedAt, names: src.names === true, memory: src.memory === true };
}

// Service URLs: http(s) only, no whitespace. Anything else is not a URL a
// person meant; the caller reports it (settingsInputError) instead of
// saving it silently wrong.
const SERVICE_URL = /^https?:\/\/[^\s/]+(?:\/\S*)?$/i;
function normalizeServiceUrl(raw, { keepPath = true } = {}) {
  const s = String(raw || '').trim();
  if (!s || !SERVICE_URL.test(s)) return '';
  return keepPath ? s : s.replace(/\/+$/, '');
}
const VOICE_NAME = /^[\w.:-]{1,64}$/;
const MODEL_NAME = /^[\w./:@-]{1,200}$/;

// A reason to refuse a settings change, or null. Only the fields a person
// types by hand are checked; everything else is normalized as before.
function settingsInputError(src) {
  if (!src || typeof src !== 'object') return 'settings must be an object';
  const urls = { semanticUrl: 'the search server', speechUrl: 'the speech-to-text server', ttsUrl: 'the read-aloud server', voiceModelUrl: 'the spoken-digest model endpoint' };
  for (const [k, what] of Object.entries(urls)) {
    const v = String(src[k] || '').trim();
    if (v && !SERVICE_URL.test(v)) return `${what} needs a full address starting with http:// or https://`;
  }
  if (String(src.ttsVoice || '').trim() && !VOICE_NAME.test(String(src.ttsVoice).trim())) return 'the voice name may only hold letters, digits, dots, dashes and underscores';
  if (String(src.voiceModel || '').trim() && !MODEL_NAME.test(String(src.voiceModel).trim())) return 'the spoken-digest model name has characters a model name does not use';
  if (src.quietMinutes !== undefined && src.quietMinutes !== null && String(src.quietMinutes).trim() !== '') {
    const n = Number(src.quietMinutes);
    if (!Number.isInteger(n) || (n !== 0 && (n < 5 || n > 1440))) return 'the quiet-work time is whole minutes from 5 to 1440, or 0 to turn it off';
  }
  return null;
}

function normalizeGuestLimits(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const memory = /^\d+(?:\.\d+)?[KMGT]?$/i.test(String(src.memory || '').trim()) ? String(src.memory).trim().toUpperCase() : '';
  const cpuN = parseInt(String(src.cpu || '').replace('%', ''), 10);
  const cpu = cpuN > 0 && cpuN <= 100000 ? cpuN + '%' : '';
  const tasksN = parseInt(src.tasks, 10);
  const tasks = tasksN >= 16 && tasksN <= 32768 ? tasksN : 0;
  return { memory, cpu, tasks };
}

// Keep only well-formed machine entries: a name, an http(s) URL without a
// trailing slash, and a token string (may be empty for a local-only URL).
function normalizeMachines(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const url = String(m.url || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/i.test(url)) continue;
    const name = String(m.name || '').trim().slice(0, 40) || url.replace(/^https?:\/\//i, '');
    const token = String(m.token || '').trim();
    const id = url.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    // The other install's signing key, exchanged at pairing: with it, the
    // switcher hands a signed-in person over as themselves (users.js).
    const publicKey = /^[A-Za-z0-9+/=]{20,200}$/.test(String(m.publicKey || '')) ? String(m.publicKey) : '';
    out.push(publicKey ? { name, url, token, publicKey } : { name, url, token });
  }
  return out;
}

function parseTokenCount(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return 0;
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  if (s.endsWith('M')) return Math.round(n * 1_000_000);
  if (s.endsWith('K')) return Math.round(n * 1_000);
  return Math.round(n);
}

function formatTokenCount(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000 && v % 1_000_000 === 0) return (v / 1_000_000) + 'M';
  if (v >= 1_000 && v % 1_000 === 0) return (v / 1_000) + 'K';
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(v);
}

// The context footprint a reply leaves behind: the tokens the NEXT turn
// carries. This is the provider's own counter, not a text estimate.
// pi normalizes usage as { input, output, cacheRead, cacheWrite, ... };
// claude transcripts use { input_tokens, output_tokens,
// cache_read_input_tokens, cache_creation_input_tokens }. In both formats
// the cache fields are NOT included in the plain input field, so a meter
// that ignores them reads far too low.
function usageContextTokens(usage, kind) {
  const u = usage || {};
  if (kind === 'claude') {
    return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0)
      + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
  }
  return (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) + (u.output || 0);
}

function parseListModels(text) {
  const lines = String(text || '').split(/\r?\n/);
  if (!lines.length) return [];
  const header = lines[0];
  const names = ['provider', 'model', 'context', 'max-out', 'thinking', 'images'];
  const starts = names.map(name => header.indexOf(name));
  const useCols = starts.every((v, i) => v >= 0 && (i === 0 || v > starts[i - 1]));
  const out = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    let provider, model, contextLabel, maxOutLabel, thinking, images;
    if (useCols) {
      const slice = (a, b) => line.slice(a, b).trim();
      provider = slice(starts[0], starts[1]);
      model = slice(starts[1], starts[2]);
      contextLabel = slice(starts[2], starts[3]);
      maxOutLabel = slice(starts[3], starts[4]);
      thinking = slice(starts[4], starts[5]);
      images = line.slice(starts[5]).trim();
    } else {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      [provider, model, contextLabel, maxOutLabel, thinking, images] = parts;
    }
    if (!provider || !model || provider === 'provider') continue;
    out.push({
      provider,
      model,
      id: provider + '/' + model,
      context: parseTokenCount(contextLabel),
      contextLabel,
      maxOut: parseTokenCount(maxOutLabel),
      thinking: thinking === 'yes',
      images: images === 'yes',
    });
  }
  return out;
}

function findModel(models, provider, model) {
  const list = Array.isArray(models) ? models : [];
  const p = String(provider || '');
  const m = String(model || '');
  if (!m) return null;
  return list.find(item => item.provider === p && item.model === m)
    || list.find(item => item.id === m || item.model === m)
    || null;
}

function normalizeBudgets(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const amount = v => { const n = Number(v); return v !== null && v !== '' && v !== undefined && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null; };
  const people = {};
  for (const [id, v] of Object.entries(src.people && typeof src.people === 'object' ? src.people : {})) {
    const a = amount(v);
    if (/^u_[A-Za-z0-9_-]+$/.test(id) && a != null) people[id] = a;
  }
  return { monthlyPerPerson: amount(src.monthlyPerPerson), people };
}
function normalizeSso(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const str = (v, max = 500) => String(v == null ? '' : v).trim().slice(0, max);
  const list = v => (Array.isArray(v) ? v : String(v || '').split(/[\s,]+/)).map(x => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 50);
  let issuer = str(src.issuer);
  if (issuer && !/^https:\/\/[^\s]+$/i.test(issuer) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(issuer)) issuer = '';
  const hours = Number(src.sessionHours);
  return { issuer: issuer.replace(/\/+$/, ''), clientId: str(src.clientId), clientSecret: str(src.clientSecret, 2000), name: str(src.name, 60),
    allowedDomains: list(src.allowedDomains), autoProvision: src.autoProvision === true, groupsClaim: str(src.groupsClaim, 60) || 'groups',
    adminGroups: list(src.adminGroups), sessionHours: Number.isFinite(hours) && hours >= 1 && hours <= 24 * 30 ? Math.round(hours) : 12 };
}
function normalizeUsageBilling(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const allowed = new Set(['api', 'subscription', 'free', 'local', 'unknown']);
  const providerModes = {};
  for (const [provider, mode] of Object.entries(src.providerModes || {})) {
    const key = String(provider).trim();
    if (key && allowed.has(mode)) providerModes[key] = mode;
  }
  const monthlyFees = {};
  for (const [provider, value] of Object.entries(src.monthlyFees || {})) {
    const key = String(provider).trim();
    const fee = Number(value);
    if (key && Number.isFinite(fee) && fee > 0) monthlyFees[key] = Math.round(fee * 100) / 100;
  }
  return { providerModes, monthlyFees };
}

// A model of its own needs both halves; half a choice is the settings model.
function normalizePlainSteps(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const provider = String(src.provider || '').trim(), model = String(src.model || '').trim();
  const own = MODEL_NAME.test(provider) && MODEL_NAME.test(model);
  return { on: src.on === true, provider: own ? provider : '', model: own ? model : '' };
}

function normalizeSettings(input) {
  const src = input && typeof input === 'object' ? input : {};
  const thinking = THINKING_LEVELS.includes(src.thinking) ? src.thinking : DEFAULT_SETTINGS.thinking;
  const provider = String(src.provider || '').trim();
  const model = String(src.model || '').trim();
  const contextTokens = Number(src.contextTokens) > 0
    ? Math.round(Number(src.contextTokens))
    : DEFAULT_SETTINGS.contextTokens;
  const semanticSearch = src.semanticSearch === true;
  const semanticUrl = normalizeServiceUrl(src.semanticUrl, { keepPath: false });
  const speechUrl = normalizeServiceUrl(src.speechUrl, { keepPath: false });
  const ttsUrl = normalizeServiceUrl(src.ttsUrl, { keepPath: false });
  const voiceModelUrl = normalizeServiceUrl(src.voiceModelUrl);
  const ttsVoice = VOICE_NAME.test(String(src.ttsVoice || '').trim()) ? String(src.ttsVoice).trim() : '';
  const voiceModel = MODEL_NAME.test(String(src.voiceModel || '').trim()) ? String(src.voiceModel).trim() : '';
  const backgroundAi = normalizeBackgroundAi(src.backgroundAi);
  const welcome = normalizeWelcome(src.welcome);
  const semanticNs = String(src.semanticNs || DEFAULT_SETTINGS.semanticNs).trim().replace(/[^\w.-]+/g, '-') || 'default';
  const piEngine = src.piEngine === 'rpc' ? 'rpc' : 'sdk';
  const artifactNetwork = src.artifactNetwork === 'libraries' ? 'libraries' : 'open';
  const programsRecordAgents = src.programsRecordAgents === true;
  const previewBase = /^https:\/\/(?:\{id\}\.)?[a-z0-9.-]+(?::\d+)?$/i.test(String(src.previewBase || '').trim()) ? String(src.previewBase).trim() : '';
  const simplifyAnswers = src.simplifyAnswers !== false;
  const simplifyPrompt = typeof src.simplifyPrompt === 'string' && src.simplifyPrompt.trim() ? src.simplifyPrompt : DEFAULT_SIMPLIFY_PROMPT;
  const plainSteps = normalizePlainSteps(src.plainSteps);
  const autoResumeNetwork = src.autoResumeNetwork === true;
  const resumePrompt = typeof src.resumePrompt === 'string' && src.resumePrompt.trim() ? src.resumePrompt.trim().slice(0, 4000) : DEFAULT_RESUME_PROMPT;
  const quietMinutes = normalizeQuietMinutes(src.quietMinutes);
  const piTheme = typeof src.piTheme === 'string' && src.piTheme.trim() ? src.piTheme.trim() : DEFAULT_SETTINGS.piTheme;
  const usageBilling = normalizeUsageBilling(src.usageBilling);
  const budgets = normalizeBudgets(src.budgets);
  const isolation = src.isolation === 'per-person' ? 'per-person' : 'household';
  const sso = normalizeSso(src.sso);
  const snippetTrigger = normalizeSnippetTrigger(src.snippetTrigger);
  const doneSound = DONE_SOUND_MODES.includes(src.doneSound) ? src.doneSound : DEFAULT_SETTINGS.doneSound;
  const machines = normalizeMachines(src.machines);
  const lan = src.lan === true ? true : src.lan === false ? false : null;
  const guestLimits = normalizeGuestLimits(src.guestLimits);
  const publicDoor = src.publicDoor === true;
  const tailscaleApiKey = typeof src.tailscaleApiKey === 'string' ? src.tailscaleApiKey.trim().slice(0, 200) : '';
  const anywhere = normalizeAnywhere(src.anywhere);
  const liveTerminal = normalizeLiveTerminal(src.liveTerminal);
  // A fixed model needs both halves; half a choice is Pi's default.
  const piDefault = src.usePiDefault === true || !provider || !model;
  return {
    settingsVersion: SETTINGS_VERSION,
    usePiDefault: piDefault,
    provider: piDefault ? '' : provider,
    model: piDefault ? '' : model,
    thinking,
    contextTokens,
    semanticSearch,
    semanticUrl,
    semanticNs,
    speechUrl,
    ttsUrl,
    ttsVoice,
    voiceModelUrl,
    voiceModel,
    backgroundAi,
    welcome,
    piEngine,
    artifactNetwork,
    previewBase,
    programsRecordAgents,
    simplifyAnswers,
    simplifyPrompt,
    plainSteps,
    autoResumeNetwork,
    resumePrompt,
    quietMinutes,
    piTheme,
    usageBilling,
    budgets,
    isolation,
    sso,
    snippetTrigger,
    doneSound,
    machines,
    lan,
    guestLimits,
    publicDoor,
    tailscaleApiKey,
    anywhere,
    liveTerminal,
  };
}

const LIVE_TERMINAL_CHOICES = ['off', 'choose', 'always'];
function normalizeLiveTerminal(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const agents = {};
  const given = src.agents && typeof src.agents === 'object' ? src.agents : {};
  for (const [id, fallback] of Object.entries(DEFAULT_SETTINGS.liveTerminal.agents)) agents[id] = LIVE_TERMINAL_CHOICES.includes(given[id]) ? given[id] : fallback;
  if (agents.claude === 'choose') agents.claude = 'always';
  const idle = Number(src.idleMinutes);
  const args = {};
  const givenArgs = src.args && typeof src.args === 'object' ? src.args : {};
  for (const id of Object.keys(DEFAULT_SETTINGS.liveTerminal.agents)) {
    const list = Array.isArray(givenArgs[id]) ? givenArgs[id] : [];
    args[id] = list.filter(a => typeof a === 'string' && a.length && a.length <= 300 && !/[\0\r\n]/.test(a)).slice(0, 24);
  }
  return { agents, idleMinutes: idle >= 1 && idle <= 24 * 60 ? Math.round(idle) : DEFAULT_SETTINGS.liveTerminal.idleMinutes, record: src.record !== false, args };
}

// A relay is an https address (http only on this computer itself, for
// running one beside it); anything else is no choice: the default.
function normalizeAnywhere(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  let relay = '';
  try {
    const u = new URL(String(src.relay || '').trim());
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
    if ((u.protocol === 'https:' || (u.protocol === 'http:' && local)) && !u.username && !u.password) relay = (u.origin + u.pathname).replace(/\/+$/, '');
  } catch {}
  return { relay, off: src.off === true };
}

// Whole minutes, 0 (off) or 5 to 1440. Under five minutes a model thinking
// through a hard step would be flagged; over a day nobody is waiting.
// Anything else is not a choice a person made: the default.
function normalizeQuietMinutes(raw) {
  if (raw === 0 || raw === '0') return 0;
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n >= 5 && n <= 1440 ? n : DEFAULT_SETTINGS.quietMinutes;
}

// 1–4 visible characters; never a bare / or @, which already own the
// composer's other palettes.
function normalizeSnippetTrigger(raw) {
  const t = typeof raw === 'string' ? raw.trim() : '';
  if (!t || t.length > 4 || /\s/.test(t) || t === '/' || t === '@') return DEFAULT_SETTINGS.snippetTrigger;
  return t;
}

function hasClaudeCodeCredential(data) {
  return !!(data && data.claudeAiOauth && typeof data.claudeAiOauth === 'object');
}

function buildPiArgs(settings, options = {}) {
  const s = normalizeSettings(settings);
  const args = [
    '-p', '--no-session', '--no-tools', '--no-extensions', '--no-skills',
    '--no-prompt-templates', '--no-context-files',
    '--thinking', s.thinking,
  ];
  if (!s.usePiDefault) {
    if (s.provider) args.push('--provider', s.provider);
    if (s.model) args.push('--model', s.model);
    // claude-code is a local Pi extension. --no-extensions still allows explicit -e.
    if (s.provider === 'claude-code' && options.claudeCodeExtension) {
      args.push('-e', options.claudeCodeExtension);
    }
  }
  return args;
}

function modelLabel(settings, piDefault) {
  const s = normalizeSettings(settings);
  if (s.usePiDefault) {
    if (piDefault && (piDefault.provider || piDefault.model)) {
      return 'pi default (' + [piDefault.provider, piDefault.model].filter(Boolean).join('/') + ')';
    }
    return 'pi default';
  }
  return s.provider ? s.provider + '/' + s.model : s.model;
}

function resolveContextTokens(settings, models, piDefault) {
  const s = normalizeSettings(settings);
  if (s.usePiDefault) {
    const hit = findModel(models, piDefault && piDefault.provider, piDefault && piDefault.model);
    if (hit && hit.context) return hit.context;
  } else {
    const hit = findModel(models, s.provider, s.model);
    if (hit && hit.context) return hit.context;
  }
  return s.contextTokens || DEFAULT_CONTEXT_TOKENS;
}

function applyResolvedContext(settings, models, piDefault) {
  const s = normalizeSettings(settings);
  s.contextTokens = resolveContextTokens(s, models, piDefault);
  return s;
}

module.exports = {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_RESUME_PROMPT,
  DEFAULT_SETTINGS,
  THINKING_LEVELS,
  DONE_SOUND_MODES,
  SETTINGS_VERSION,
  LEGACY_DEFAULTS,
  BACKGROUND_AI_KINDS,
  migrateSettings,
  normalizeBackgroundAi,
  normalizeWelcome,
  settingsInputError,
  hasClaudeCodeCredential,
  parseTokenCount,
  formatTokenCount,
  usageContextTokens,
  parseListModels,
  findModel,
  normalizeUsageBilling,
  normalizeMachines,
  normalizeSettings,
  normalizeGuestLimits,
  buildPiArgs,
  modelLabel,
  resolveContextTokens,
  applyResolvedContext,
};
