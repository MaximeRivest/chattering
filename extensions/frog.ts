import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { frogContext } from "../frog-context.js";
import { homedir } from "node:os";
import { join } from "node:path";

// The frog's tools (design/102): the one conversation a person talks to
// steers all the others through them. Each tool is a thin call to this
// server's /api/frog/<op>; the rules live in frog-assistant.js and server.js.
//
// Loaded for every Chattering web session (server.js piProviderExtraArgs),
// but its tools are opt-in (extensions/modes.ts): only a mode that lists them,
// the frog mode, has them. Its workspace note is added only there too.

const port = () => Number(process.env.CHATTERING_PORT || process.env.PORT || 7433);
const token = () => {
  if (process.env.CHATTERING_TOKEN) return process.env.CHATTERING_TOKEN;
  const home = homedir();
  const files = [process.env.CHATTERING_TOKEN_FILE, process.env.CHATTERING_CACHE_DIR && join(process.env.CHATTERING_CACHE_DIR, "lan-token"),
    join(home, ".cache", "chattering", "lan-token"), join(home, "Library", "Caches", "Chattering", "lan-token"),
    join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "Chattering", "cache", "lan-token")];
  for (const f of files) { if (!f) continue; try { const t = readFileSync(f, "utf8").trim(); if (t) return t; } catch {} }
  return "";
};

async function call(op: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  const PORT = port(), TOKEN = token();
  const headers: Record<string, string> = { ...(TOKEN ? { Authorization: "Bearer " + TOKEN } : {}), ...(body ? { "Content-Type": "application/json" } : {}) };
  const url = `http://127.0.0.1:${PORT}/api/frog/${op}`;
  const init: RequestInit = { headers, signal };
  if (body) { init.method = "POST"; init.body = JSON.stringify(body); }
  let res: Response;
  try { res = await fetch(url, init); }
  catch (e: any) { throw new Error(`Chattering is not answering on port ${PORT} (${e?.cause?.code || e?.message}).`); }
  const data: any = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const get = (op: string, params: Record<string, unknown>, signal?: AbortSignal) => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  return call(op + (qs.toString() ? "?" + qs : ""), undefined, signal);
};
const out = (value: any, text?: string) => ({ content: [{ type: "text" as const, text: text ?? JSON.stringify(value) }], details: value });

export default function frog(pi: ExtensionAPI) {
  const id = Type.String({ description: "The conversation's id, as workspace or find_conversations printed it" });

  pi.registerTool({
    name: "workspace", label: "Workspace",
    description: "Who is working on what, now: conversations working (and on what), waiting for the person, stopped with an error, replied and unread, the side list's groups, and how many asks you are watching. A fresh copy is also added before each of the person's messages.",
    parameters: Type.Object({}),
    async execute(_id, _p, signal) { const d = await get("workspace", {}, signal); return out(d, d.text); },
  });
  pi.registerTool({
    name: "find_conversations", label: "Find conversations",
    description: "Conversations whose title, project or last words contain all the words, newest first, with their id, project, state and last words. For what was said inside conversations, use chattering_search.",
    parameters: Type.Object({
      q: Type.Optional(Type.String({ description: "Words; all must match" })),
      project: Type.Optional(Type.String({ description: "Only this project" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 })),
    }),
    async execute(_id, p, signal) { return out(await get("find", p, signal)); },
  });
  pi.registerTool({
    name: "read_conversation", label: "Read conversation",
    description: "The latest messages of a conversation (its current branch), with each message's entry id: what it said last, what it asks, what it did. Entry ids are what fork_conversation and branch_conversation take. With at: the messages around that entry instead (a memory's source names one).",
    parameters: Type.Object({ id, last: Type.Optional(Type.Integer({ minimum: 1, maximum: 60, description: "How many messages (default 12)" })), at: Type.Optional(Type.String({ description: "An entry id: read around it instead of the end" })) }),
    async execute(_id, p, signal) { return out(await get("read", p, signal)); },
  });
  pi.registerTool({
    name: "send_to_conversation", label: "Send to conversation",
    description: "Send a message to another conversation, as the person. Its agent starts working on it (or takes it after its current turn). The person's own words, cleaned of fillers, unless they asked you to write it.",
    parameters: Type.Object({ id, text: Type.String() }),
    async execute(_id, p, signal) { return out(await call("send", p, signal)); },
  });
  pi.registerTool({
    name: "start_conversation", label: "Start conversation",
    description: "Start a new conversation in a project (or any folder) with a first message; its agent starts at once. Optionally a title, a model (provider/model), a prompt mode, a side-list group. To build something for yourself (a watcher, a timer, a notifier), start it in the assistant project.",
    parameters: Type.Object({
      project: Type.Optional(Type.String()), folder: Type.Optional(Type.String({ description: "A folder path, when it is not a project's" })),
      prompt: Type.String({ description: "The first message: a complete brief, since that agent does not see this conversation" }),
      title: Type.Optional(Type.String()), model: Type.Optional(Type.String({ description: "provider/model; default: the person's last pick" })),
      mode: Type.Optional(Type.String()), group: Type.Optional(Type.String({ description: "Put it in this side-list group (made if missing)" })),
    }),
    async execute(_id, p, signal) { return out(await call("start", p, signal)); },
  });
  pi.registerTool({
    name: "create_project", label: "Create project",
    description: "Create a new project: a folder (under ~/Projects unless parent says otherwise) with Git, registered in Chattering, with an optional purpose that seeds its memory.",
    parameters: Type.Object({ name: Type.String(), purpose: Type.Optional(Type.String()), parent: Type.Optional(Type.String()) }),
    async execute(_id, p, signal) { return out(await call("project", p, signal)); },
  });
  pi.registerTool({
    name: "stop_conversation", label: "Stop conversation",
    description: "Stop what a conversation's agent is doing now. A step already running may have done part of its work.",
    parameters: Type.Object({ id }),
    async execute(_id, p, signal) { return out(await call("stop", p, signal)); },
  });
  pi.registerTool({
    name: "fork_conversation", label: "Fork conversation",
    description: "Copy a conversation into a new one, from its newest message or from an entry id, to try another direction without touching the original.",
    parameters: Type.Object({ id, at: Type.Optional(Type.String({ description: "Entry id (read_conversation); default: the newest" })) }),
    async execute(_id, p, signal) { return out(await call("fork", p, signal)); },
  });
  pi.registerTool({
    name: "branch_conversation", label: "Branch conversation",
    description: "Make a conversation continue from an earlier message (Pi conversations): the next message goes on from there, the later ones stay in its tree.",
    parameters: Type.Object({ id, at: Type.String({ description: "Entry id of the message to continue from" }) }),
    async execute(_id, p, signal) { return out(await call("branch", p, signal)); },
  });
  pi.registerTool({
    name: "rename_conversation", label: "Rename conversation",
    description: "Give a conversation a title.",
    parameters: Type.Object({ id, title: Type.String() }),
    async execute(_id, p, signal) { return out(await call("title", p, signal)); },
  });
  pi.registerTool({
    name: "organize_list", label: "Organize the list",
    description: "Arrange the person's side list: open or close rows (closing deletes nothing), pin, put conversations in a named group (made if missing), take them out, fold or unfold a group, rename a group. Every device shows the result.",
    parameters: Type.Object({
      open: Type.Optional(Type.Array(Type.String())), close: Type.Optional(Type.Array(Type.String())),
      pin: Type.Optional(Type.Array(Type.String())), unpin: Type.Optional(Type.Array(Type.String())),
      group: Type.Optional(Type.Object({ name: Type.String(), ids: Type.Array(Type.String()), folded: Type.Optional(Type.Boolean()) })),
      ungroup: Type.Optional(Type.Array(Type.String())),
      fold: Type.Optional(Type.Object({ name: Type.String(), folded: Type.Optional(Type.Boolean()) })),
      rename: Type.Optional(Type.Object({ from: Type.String(), to: Type.String() })),
    }),
    async execute(_id, p, signal) { return out(await call("organize", p, signal)); },
  });
  pi.registerTool({
    name: "mark_read", label: "Mark read",
    description: "Say which replies the person has now really received through you, so they stop showing as unread. as: told (the default) when you have just told them what a reply says, fully enough that they need not open it: a status, a result, a finished task with nothing left for them. It becomes read only once they have your answer (they read it or write to you next), and stays unread if that conversation says anything new first. Not for a reply that asks them to decide, review, try or read something, or that holds more than you passed on: leave it unread. as: read or unread, now, when the person asks (\"mark it read\", \"keep it, I'll look later\").",
    parameters: Type.Object({
      ids: Type.Array(Type.String(), { description: "Conversation ids, as workspace or find_conversations printed them" }),
      as: Type.Optional(StringEnum(["told", "read", "unread"] as const)),
      why: Type.Optional(Type.String({ description: "What you told them, in a few words" })),
    }),
    async execute(_id, p, signal) { return out(await call("mark-read", p, signal)); },
  });
  pi.registerTool({
    name: "context_use", label: "Context use",
    description: "How full each conversation's context window is: tokens used by its last reply against its model's window, fullest first (the side list's conversations; one with id). Past half, answers get slower and costlier, and near the end the agent must compact or start fresh: mention it. Plan usage limits are not readable here.",
    parameters: Type.Object({ id: Type.Optional(id), all: Type.Optional(Type.Boolean({ description: "Every conversation, not only the side list's" })) }),
    async execute(_id, p, signal) { return out(await get("context", p, signal)); },
  });
  pi.registerTool({
    name: "fresh_start", label: "Fresh start",
    description: "Start a fresh conversation from a full one: its messages only (what the person and the agent said, not tool calls or their results), then your message, in the same folder, model, mode and side-list group. For a conversation past half or near its end, when the person agrees. The message must say what to do next, since the agent starts with only the conversation's words. On your own conversation: it continues fresh when this turn ends, your memory in front and the last turns as they were (your context is compacted by itself anyway; this is for when the person asks).",
    parameters: Type.Object({ id, message: Type.String({ description: "The first message of the fresh conversation" }), title: Type.Optional(Type.String()) }),
    async execute(_id, p, signal) { return out(await call("fresh", p, signal)); },
  });
  // Its memory (design/102, part 3): the print stands at the top of its
  // context; these go further.
  pi.registerTool({
    name: "remember", label: "Remember",
    description: "Write one memory now: one line, at most 280 bytes, a fact with lasting effect (what the person decided or asked you to keep in mind, something about their life or the people around them, how they want things done). Memories are also written for you from each turn as it leaves your context, so this is for what must not wait or must be said exactly.",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, p, signal) { return out(await call("memory/note", { text: p.text }, signal)); },
  });
  pi.registerTool({
    name: "recall_memory", label: "Recall",
    description: "Search every memory ever recorded of this conversation, word for word: all the words must appear (case does not matter); newest matches last. Each memory names the conversation part and entries it came from: read_conversation with at reads the words themselves.",
    parameters: Type.Object({ q: Type.String({ description: "Words to find; or a regular expression with regex: true" }), regex: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }),
    async execute(_id, p, signal) { return out(await get("memory/recall", p, signal)); },
  });
  pi.registerTool({
    name: "zoom_memory", label: "Zoom memory",
    description: "Open a summed-up range of your memory (a line like #16-31 at the top of your context) into its two halves, each a summary or the memories themselves, down to single memories with where they came from.",
    parameters: Type.Object({ id: Type.String({ description: "The range, like #16-31" }) }),
    async execute(_id, p, signal) { return out(await get("memory/zoom", p, signal)); },
  });
  pi.registerTool({
    name: "asides", label: "Asides",
    description: "The asides the person dropped while you were speaking (each answered with only 'noted'): list the open ones, or close those you have dealt with or the person dropped.",
    parameters: Type.Object({ done: Type.Optional(Type.Array(Type.String({ description: "Aside ids (a…)" }))) }),
    async execute(_id, p, signal) { return out(p.done && p.done.length ? await call("asides", { done: p.done }, signal) : await get("asides", {}, signal)); },
  });
  pi.registerTool({
    name: "ask_when", label: "Ask when",
    description: "Watch a conversation for the person: when its agent finishes, stops with an error, or ends by asking a question, you get told (then: tell), and their phone gets a notification (then: notify) or rings as for a call (then: call; answered, they are talking with you). Once, unless repeat.",
    parameters: Type.Object({
      id,
      when: Type.Optional(Type.Array(StringEnum(["done", "failed", "question"] as const), { description: "Default: all three" })),
      then: Type.Optional(StringEnum(["tell", "notify", "call"] as const)),
      note: Type.Optional(Type.String({ description: "What the person asked, in their words" })),
      repeat: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, p, signal) { return out(await call("ask", p, signal)); },
  });
  pi.registerTool({
    name: "list_asks", label: "List asks",
    description: "The asks you are watching for the person.",
    parameters: Type.Object({}),
    async execute(_id, _p, signal) { return out(await get("asks", {}, signal)); },
  });
  pi.registerTool({
    name: "cancel_ask", label: "Cancel ask",
    description: "Stop watching one ask.",
    parameters: Type.Object({ ask: Type.String({ description: "The ask's id (w…)" }) }),
    async execute(_id, p, signal) { return out(await call("ask/cancel", p, signal)); },
  });
  pi.registerTool({
    name: "notify_person", label: "Notify the person",
    description: "A notification on the person's phone and other devices, now, even while they are at a screen. For what they asked to be pinged about, or what cannot wait. With call: true the phone rings as for a call (answered, they are talking with you: greet them, say why you called); only when they asked to be called, or it truly cannot wait.",
    parameters: Type.Object({ title: Type.Optional(Type.String()), text: Type.String(), urgent: Type.Optional(Type.Boolean()), call: Type.Optional(Type.Boolean()) }),
    async execute(_id, p, signal) { return out(await call("notify", p, signal)); },
  });

  // What the frog reads of its past (design/102, part 3, "speed first"):
  // turns older than the last few keep their messages and lose their tool
  // steps, thinking and workspace notes (frog-context.js). Only for this
  // model call: the saved conversation keeps everything. Off unless
  // CHATTERING_FROG_SHRINK=1: measured on the frog's real ~200k context it
  // did not bring its first word sooner (the provider's cache reads 200k
  // about as fast as 80k), and the shrunk history made it think before
  // answering, a second later. Kept for when the context grows past that.
  pi.on("context", async (event) => {
    if (process.env.CHATTERING_FROG_SHRINK !== "1") return;
    if (!new Set(pi.getActiveTools()).has("workspace")) return;
    const r = frogContext(event.messages as any[]);
    if (!r.shrunk) return;
    return { messages: r.messages as any };
  });

  // Before each of the person's messages: the live workspace, so "who is
  // working on what?" is answered from the first words, with no tool call
  // (only when it changed since the last one); and, when the person cut off
  // the reading of its last answer, where (design/102). Only in the frog mode.
  let lastNote = "";
  pi.on("before_agent_start", async () => {
    const active = new Set(pi.getActiveTools());
    if (!active.has("workspace")) return;
    const parts: string[] = [];
    try {
      const cut = await call("interrupted", {});
      if (cut && cut.text) parts.push("Read aloud (from Chattering, not said by the person):\n" + cut.text);
    } catch {}
    try {
      const d = await get("workspace", {});
      if (d.text && d.text !== lastNote) {
        lastNote = d.text;
        parts.push(`Workspace at ${new Date().toTimeString().slice(0, 5)} (live, from Chattering; not said by the person):\n${d.text}`);
      }
    } catch {}
    if (!parts.length) return;
    return { message: { customType: "frog-workspace", display: false, content: parts.join("\n\n") } };
  });
}
