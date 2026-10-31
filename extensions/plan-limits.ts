import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { limitHeaders } from "../plan-limits-live.js";

// Plan limits, as replies say them (design/109). Each reply of a
// subscription carries the plan's limit headers (Claude's
// anthropic-ratelimit-unified-*, ChatGPT's x-codex-*); a refused reply says
// "usage limit" and often when it is back. This sends both to Chattering, so
// the model picker shows the plan as it is now, between Chattering's own
// reads of each account, and a refusal is known the moment it happens.
//
// What leaves: the provider and model of the reply, its status, and its
// LIMIT headers only (plan-limits-live.js HEADER_ALLOW: never a request
// header, never a key or a cookie), or a refusal's message. To this
// computer's Chattering only, as the person the run belongs to.
//
// Loaded into every Pi run Chattering starts: web runs (server.js
// piProviderExtraArgs), delegated work (delegation.js) and Chattering's own
// model calls (piExec). Silent: a Chattering that does not answer costs a
// reply nothing.

const port = () => Number(process.env.CHATTERING_PORT || process.env.PORT || 7433);
const token = () => {
  if (process.env.CHATTERING_TOKEN) return process.env.CHATTERING_TOKEN;
  const home = homedir();
  const files = [process.env.CHATTERING_TOKEN_FILE, process.env.CHATTERING_CACHE_DIR && join(process.env.CHATTERING_CACHE_DIR, "lan-token"),
    join(home, ".local", "state", "chattering", "token"),
    join(home, ".cache", "chattering", "lan-token"), join(home, "Library", "Caches", "Chattering", "lan-token"),
    join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "Chattering", "cache", "lan-token")];
  for (const f of files) { if (!f) continue; try { const t = readFileSync(f, "utf8").trim(); if (t) return t; } catch {} }
  return "";
};

// Replies of one provider are sent at most this often; a refusal at once.
export const EVERY_MS = 5000;

async function send(body: Record<string, unknown>): Promise<void> {
  const TOKEN = token();
  try {
    await fetch(`http://127.0.0.1:${port()}/api/plan-limits/observe`, {
      method: "POST", signal: AbortSignal.timeout(3000),
      headers: { "Content-Type": "application/json", ...(TOKEN ? { Authorization: "Bearer " + TOKEN } : {}) },
      body: JSON.stringify(body),
    });
  } catch {}
}

// A model's plan as Chattering knows it now: { state, usedPercent, label,
// resetsAt, until } or null (not a plan, not known, Chattering not answering).
export async function planState(provider: string, model: string): Promise<any> {
  const TOKEN = token();
  try {
    const res = await fetch(`http://127.0.0.1:${port()}/api/plan-limits`, { signal: AbortSignal.timeout(3000), headers: TOKEN ? { Authorization: "Bearer " + TOKEN } : {} });
    if (!res.ok) return null;
    const v: any = await res.json();
    return (v.models && v.models[provider + "/" + model]) || (v.providers && v.providers[provider]) || null;
  } catch { return null; }
}

export default function planLimits(pi: ExtensionAPI, { post = send, now = () => Date.now() } = {}) {
  const lastSent = new Map<string, number>();
  const held = new Map<string, { body: Record<string, unknown>; timer: ReturnType<typeof setTimeout> }>();
  const flush = (provider: string) => {
    const h = held.get(provider);
    if (!h) return;
    held.delete(provider);
    lastSent.set(provider, now());
    void post(h.body);
  };
  pi.on("after_provider_response", async (event: any, ctx: any) => {
    const headers = limitHeaders(event && event.headers);
    if (!Object.keys(headers).length) return;
    // The request's own provider and model when Pi says them (proposed
    // upstream, design/109); else the session's, right for its replies.
    const model = ctx && ctx.model;
    const provider = String((event && event.provider) || (model && model.provider) || "");
    if (!provider) return;
    const body = { provider, model: String((event && typeof event.model === "string" && event.model) || (model && model.id) || ""), status: Number(event.status) || 0, headers, at: now() };
    // A refusal, or the plan saying "rejected": at once. Otherwise the
    // newest reply of each provider, every few seconds at most.
    const urgent = body.status === 429 || Object.entries(headers).some(([k, v]) => k.endsWith("-status") && v === "rejected");
    const prev = held.get(provider);
    if (prev) clearTimeout(prev.timer);
    const wait = urgent ? 0 : Math.max(0, EVERY_MS - (now() - (lastSent.get(provider) || 0)));
    const timer = setTimeout(() => flush(provider), wait);
    (timer as any).unref?.();
    held.set(provider, { body, timer });
  });
  pi.on("message_end", async (event: any) => {
    const m = event && event.message;
    if (!m || m.role !== "assistant" || m.stopReason !== "error" || !m.errorMessage || !m.provider) return;
    void post({ provider: String(m.provider), model: String(m.model || ""), error: String(m.errorMessage).slice(0, 2000), at: now() });
  });
  pi.on("session_shutdown", async () => { for (const p of [...held.keys()]) { const h = held.get(p); if (h) clearTimeout(h.timer); flush(p); } });
}
