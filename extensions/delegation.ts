import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { readFileSync, statSync } from "node:fs";
import {
  launchDelegation, resumeDelegation, listDelegations, getDelegation, controlDelegation, reportDelegationReview, normalizeMode, modeSha256,
} from "../delegation.js";

// Load with -e /absolute/path/extensions/delegation.ts. Do not also install a global copy.
// The existing modes extension must be loaded. We do not replace global Pi resources.
const terminal = new Set(["succeeded", "failed", "cancelled", "lost"]);
const toolNames = Type.Array(Type.String({ minLength: 1 }), { maxItems: 256 });
const modeSchema = Type.Object({
  key: Type.String(), label: Type.String(),
  opener: Type.Optional(Type.String()), appendix: Type.Optional(Type.String()),
  systemPrompt: Type.Optional(Type.String()), removeSections: Type.Optional(Type.Array(Type.String())),
  tools: toolNames,
}, { additionalProperties: false });

function sessionPath(ctx: any): string {
  const file = ctx.sessionManager.getSessionFile();
  if (!file) throw new Error("Delegation requires a saved parent session.");
  return file;
}
function compact(task: any) {
  return { id: task.id, parentTaskId: task.parentTaskId, title: task.title, role: task.role,
    status: task.status, review: task.review, paused: task.paused, cancelRequested: task.cancelRequested,
    sessionPath: task.sessionPath, parentSessionPath: task.parentSessionPath, parentEntryId: task.parentEntryId,
    model: task.model, tools: task.tools, modeHash: task.modeHash, modePath: task.modePath,
    promptPath: task.promptPath, outputDir: task.outputDir, logPath: task.logPath, stderrPath: task.stderrPath,
    delivery: task.delivery, error: task.error, failure: task.failure ?? null, attempt: task.attempt,
    modelsUsed: task.modelsUsed, takenOver: task.takenOver ?? null, result: task.result };
}
function result(value: any) {
  const full = JSON.stringify(value, null, 2);
  const text = full.length > 45000 ? full.slice(0, 45000) + "\n[Display truncated. Read the saved task files for full details.]" : full;
  return { content: [{ type: "text" as const, text }], details: full.length > 45000 ? { text, truncated: true } : value };
}
async function related(ctx: any) {
  const file = sessionPath(ctx);
  const all = await listDelegations();
  const ids = new Set<string>(all.filter((t: any) => t.parentSessionPath === file || t.sessionPath === file).map((t: any) => t.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of all) if (ids.has(task.parentTaskId) && !ids.has(task.id)) { ids.add(task.id); changed = true; }
  }
  return all.filter((t: any) => ids.has(t.id));
}
async function controlledTask(id: string, ctx: any) {
  const task = (await related(ctx)).find((t: any) => t.id === id);
  if (!task || task.sessionPath === sessionPath(ctx)) throw new Error("You can control only this conversation's delegated descendants.");
  return task;
}

export default function delegation(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI || !ctx.sessionManager.getSessionFile()) return;
    const tasks = await related(ctx);
    const pending = tasks.filter((t: any) => terminal.has(t.status) && t.review === "unreviewed");
    if (pending.length) ctx.ui.notify(`${pending.length} delegation results need review. Run /delegations.`, "info");
  });

  // Identity comes from this context, never a shared environment variable.
  // The worker-only ID locates its request; an exact session match is still mandatory.
  const validateWorker = async (_event: any, ctx: any) => {
    const ownId = process.env.PI_DELEGATION_ID;
    if (!ownId) return;
    try {
      const task = await getDelegation(ownId);
      if (task.sessionPath !== ctx.sessionManager.getSessionFile()) return;
      if (task.cancelRequested || task.status === "lost") throw new Error("Delegation is cancelled or lost.");
      const saved = [...ctx.sessionManager.getBranch()].reverse().find((entry: any) => entry.type === "custom" && entry.customType === "mode-switch") as any;
      const snapshot = normalizeMode(JSON.parse(readFileSync(task.modePath, "utf8")));
      const effective = saved?.data;
      const sameTools = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
      if (modeSha256(snapshot) !== task.modeHash || !effective?.definition ||
        modeSha256(normalizeMode(effective.definition)) !== task.modeHash || effective.sha256 !== task.modeHash ||
        !Array.isArray(effective.effectiveTools) || !sameTools(effective.effectiveTools, task.tools) ||
        !sameTools(pi.getActiveTools(), task.tools)) throw new Error("Delegated mode contract does not match the saved mode or active tools.");
      // After a human takeover the person picks the model; the mode and tool contract still holds.
      if (!task.takenOver && (!ctx.model || `${ctx.model.provider}/${ctx.model.id}` !== task.model)) throw new Error("Delegated model does not match the requested model.");
    } catch (error) {
      // Pi reports provider-hook errors and continues. Explicit abort also cancels the provider signal.
      ctx.abort();
      throw error;
    }
  };
  pi.on("before_provider_request", validateWorker);
  pi.on("input", async (event, ctx) => {
    try { await validateWorker(event, ctx); return { action: "continue" as const }; }
    catch (error: any) {
      console.error("[delegation preflight] " + error.message);
      return { action: "handled" as const };
    }
  });
  pi.on("tool_call", async (event, ctx) => {
    try { await validateWorker(event, ctx); }
    catch (error: any) { return { block: true, terminate: true, reason: error.message }; }
  });
  // Pi owns model retries. A failed message must not abort recovery or poison
  // later requests. Every retried request still passes the contract guard.

  pi.registerTool({
    name: "delegate", label: "Delegate",
    description: "Start a durable independent Pi conversation. Provide a full mode snapshot and matching tools. Include delegate in mode.tools to allow recursion. This is not a fork or sandbox. Completion requests review, not acceptance.",
    promptSnippet: "Delegate an authorized task to a saved child conversation with durable status and parent links",
    promptGuidelines: ["Use delegate for background Pi workers instead of ad hoc shell launchers. Give parallel writers disjoint worktrees or output scopes. Use delegation_status to inspect results, and delegation_review only after checking evidence. Execution success is not acceptance.",
      "Before you say whether any delegation is running, finished, stuck or reviewed, call delegation_status and answer from it. Never answer from memory or from the absence of a callback: callbacks can be delayed.",
      "Tell workers to run tests and other commands that could hang with a time limit (for example `timeout 600 npm test`), so a hung command fails instead of stalling the worker."],
    parameters: Type.Object({ title: Type.String(), role: Type.String(), prompt: Type.String(),
      mode: modeSchema, tools: toolNames, model: Type.Optional(Type.String()),
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
      cwd: Type.Optional(Type.String()) }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const model = params.model || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "");
      const slash = model.indexOf("/");
      if (slash < 1 || !ctx.modelRegistry.find(model.slice(0, slash), model.slice(slash + 1))) throw new Error("Select an exact known provider/model before delegation.");
      const available = new Set(pi.getAllTools().map(tool => tool.name));
      const missing = params.tools.filter(tool => !available.has(tool));
      if (missing.length) throw new Error(`Requested tools are unavailable: ${missing.join(", ")}`);
      const task = await launchDelegation({ ...params, model, thinking: params.thinking ?? ctx.thinkingLevel,
        cwd: params.cwd ?? ctx.cwd, parentSessionPath: sessionPath(ctx), parentEntryId: ctx.sessionManager.getLeafId(),
        delivery: ctx.mode === "rpc" ? "web" : "nextTurn" });
      if (ctx.hasUI) ctx.ui.notify(`Delegation ${task.id}: ${task.status}. Completion will request review.`, "info");
      return result(compact(task));
    },
  });
  pi.registerTool({
    name: "delegation_status", label: "Delegation status",
    description: "Read durable status for this conversation and its delegated descendants: the truth about what is running, finished or reviewed, including work whose callback has not arrived yet. Call it before stating any delegation's state. Shows up to 50 tasks and 45,000 characters. Success does not mean accepted.",
    parameters: Type.Object({ id: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _update, ctx) {
      const tasks = await related(ctx);
      if (params.id) {
        const task = tasks.find((t: any) => t.id === params.id);
        if (!task) throw new Error("Delegation is not associated with this conversation.");
        return result(compact(task));
      }
      return result({ tasks: tasks.slice(0, 50).map(compact), omitted: Math.max(0, tasks.length - 50) });
    },
  });
  pi.registerTool({
    name: "delegation_control", label: "Delegation control",
    description: "Control delegated descendants. Pause prevents new descendants; running workers continue. Cancel requests durable subtree cancellation. Resume cannot undo cancellation.",
    parameters: Type.Object({ id: Type.String(), action: StringEnum(["pause", "resume", "cancel"] as const) }),
    async execute(_id, params, _signal, _update, ctx) {
      await controlledTask(params.id, ctx);
      return result(compact(await controlDelegation(params.id, params.action)));
    },
  });
  pi.registerTool({
    name: "delegation_resume", label: "Continue delegated work",
    description: "Continue a failed or lost direct child on its own saved session, with all its history and files. Use after a usage limit, overload, interruption, or context overflow. Optionally change the model or reasoning level (for example a larger context window after context-overflow) and add short instructions. Refused when the child is cancelled, paused, still alive, taken over by a person, or stopped on a contract violation.",
    parameters: Type.Object({ id: Type.String(), model: Type.Optional(Type.String()),
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
      instructions: Type.Optional(Type.String()) }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const task = await getDelegation(params.id);
      if (task.parentSessionPath !== sessionPath(ctx)) throw new Error("Only the direct parent can continue this delegation.");
      if (params.model) {
        const slash = params.model.indexOf("/");
        if (slash < 1 || !ctx.modelRegistry.find(params.model.slice(0, slash), params.model.slice(slash + 1))) throw new Error("Select an exact known provider/model.");
      }
      const resumed = await resumeDelegation(params.id, { model: params.model, thinking: params.thinking, instructions: params.instructions,
        parentSessionPath: sessionPath(ctx), by: "parent" });
      if (ctx.hasUI) ctx.ui.notify(`Delegation ${resumed.id} continues (attempt ${resumed.attempt}, ${resumed.model}).`, "info");
      return result(compact(resumed));
    },
  });
  pi.registerTool({
    name: "delegation_review", label: "Review delegated work",
    description: "Record this parent conversation's review of a direct child after checking its results. Requires evidence. This is not a human vouch. A worker cannot accept itself or a sibling.",
    parameters: Type.Object({ id: Type.String(), review: StringEnum(["accepted", "rejected"] as const), evidence: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      const task = await getDelegation(params.id);
      if (task.parentSessionPath !== sessionPath(ctx)) throw new Error("Only the direct parent can review this assignment.");
      return result(compact(await reportDelegationReview(params.id, params.review, params.evidence, { reviewerSessionPath: sessionPath(ctx) })));
    },
  });
  pi.registerCommand("delegations", {
    description: "Show delegated conversations and durable controls",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const tasks = await related(ctx);
      if (!tasks.length) { ctx.ui.notify("No delegations for this conversation.", "info"); return; }
      const choices = tasks.slice(0, 100).map((t: any) => `${t.id} | ${t.status}${t.failure ? ` (${t.failure.kind})` : ""} | ${t.review} | ${t.title}`);
      const choice = await ctx.ui.select("Delegations (up to 100; success still needs review)", choices);
      if (!choice) return;
      const task = tasks[choices.indexOf(choice)];
      const canContinue = ["failed", "lost"].includes(task.status) && task.parentSessionPath === sessionPath(ctx) && !task.takenOver;
      const action = await ctx.ui.select(`${task.title}: ${task.status}`, ["Show saved paths", ...(canContinue ? ["Continue on its session"] : []), "Pause new descendants", "Resume new descendants", "Cancel subtree"]);
      if (!action) return;
      if (action === "Show saved paths") {
        ctx.ui.notify(`Session: ${task.sessionPath}\nPrompt: ${task.promptPath}\nMode: ${task.modePath}\nOutput: ${task.outputDir}\nLog: ${task.logPath}`, "info");
        return;
      }
      if (action === "Continue on its session") {
        const model = await ctx.ui.input("Model (provider/model; empty keeps " + task.model + ")", "");
        const resumed = await resumeDelegation(task.id, { model: model?.trim() || undefined, parentSessionPath: sessionPath(ctx), by: "parent" });
        ctx.ui.notify(`Attempt ${resumed.attempt} started with ${resumed.model}.`, "info");
        return;
      }
      await controlledTask(task.id, ctx);
      if (action === "Cancel subtree" && !await ctx.ui.confirm("Cancel subtree?", "This requests cancellation of all descendants. It cannot be undone.")) return;
      await controlDelegation(task.id, action.startsWith("Pause") ? "pause" : action.startsWith("Resume") ? "resume" : "cancel");
      ctx.ui.notify(action === "Pause new descendants" ? "New descendants are paused. Running workers continue." : `${action} requested.`, "info");
    },
  });
  // No notification claims or acknowledgements here. The host owns web delivery.
  // Terminal roots receive a repeatable next-turn review reminder, without automatic model turns.
  // Web parents receive a short status line instead (see statusMessage).
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!ctx.sessionManager.getSessionFile()) return;
    if (ctx.mode === "rpc") return statusMessage(ctx);
    const pending = (await related(ctx)).filter((t: any) => t.parentSessionPath === sessionPath(ctx) &&
      t.delivery === "nextTurn" && terminal.has(t.status) && t.review === "unreviewed");
    if (!pending.length) return;
    return { message: { customType: "delegation-review-pending", display: true,
      content: "Delegation results need parent review. Do not treat completion as acceptance. Stopped work (failed or lost) keeps its session; delegation_resume continues it.\n" +
        pending.slice(0, 30).map((t: any) => `${t.id}: ${t.status}${t.failure ? ` (${t.failure.kind})` : ""}; session ${t.sessionPath}`).join("\n") } };
  });
}

// What this conversation's direct children are doing, read from their
// durable records at the start of each turn, so the model never answers
// "is it done?" from memory while a callback is still on its way (it once
// told the user none of four builders had finished when three had). Sent
// only when the set of running and returned-unreviewed children changed
// since the last line on this branch: context only, never shown in the
// transcript (display false) and never a turn of its own.
const STATUS_TYPE = "delegation-status";
function lastOutputMs(task: any): number {
  let last = 0;
  for (const file of [task.logPath, task.sessionPath]) {
    try { last = Math.max(last, statSync(file).mtimeMs); } catch {}
  }
  return last;
}
function spoken(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60000));
  if (min < 1) return "under a minute";
  if (min < 60) return min + " min";
  return Math.floor(min / 60) + " h" + (min % 60 ? " " + (min % 60) + " min" : "");
}
// Did this conversation ever launch a worker? Reading every task record on
// every turn of every conversation would be wasted work for the many that
// never delegate; the saved entries answer in memory.
function everDelegated(ctx: any): boolean {
  for (const e of ctx.sessionManager.getEntries() as any[]) {
    if (e.type === "custom_message" && e.customType === STATUS_TYPE) return true;
    const content = e.type === "message" && e.message?.role === "assistant" ? e.message.content : null;
    if (Array.isArray(content) && content.some((c: any) => c?.type === "toolCall" && c.name === "delegate")) return true;
  }
  return false;
}
async function statusMessage(ctx: any) {
  if (!everDelegated(ctx)) return;
  const file = sessionPath(ctx);
  const children = (await listDelegations()).filter((t: any) => t.parentSessionPath === file);
  const running = children.filter((t: any) => !terminal.has(t.status));
  const waiting = children.filter((t: any) => terminal.has(t.status) && t.status !== "cancelled" && t.review === "unreviewed");
  const signature = [...running.map((t: any) => "r:" + t.id), ...waiting.map((t: any) => "w:" + t.id + ":" + t.status + ":" + (t.attempt || 1))].sort().join(",");
  const previous = [...ctx.sessionManager.getBranch()].reverse()
    .find((e: any) => e.type === "custom_message" && e.customType === STATUS_TYPE) as any;
  if ((previous?.details?.signature ?? "") === signature) return;
  const now = Date.now();
  const line = (t: any) => {
    if (!terminal.has(t.status)) {
      const last = lastOutputMs(t);
      return `${t.title} (${t.id}): running${t.startedAt ? ` for ${spoken(now - t.startedAt)}` : ""}${last ? `, last output ${spoken(now - last)} ago` : ""}`;
    }
    return `${t.title} (${t.id}): ${t.status}${t.failure ? ` (${t.failure.kind})` : ""}, not reviewed yet`;
  };
  const listed = [...running, ...waiting];
  const content = signature
    ? "Delegation status from the durable records at the start of this turn (a runner note, not a user message):\n" +
      listed.slice(0, 20).map((t: any) => "- " + line(t)).join("\n") +
      (listed.length > 20 ? `\n- and ${listed.length - 20} more: call delegation_status` : "") +
      "\nState changes after this; call delegation_status before you tell the user what is running or finished."
    : "Delegation status: nothing this conversation delegated is running or waiting for review.";
  return { message: { customType: STATUS_TYPE, display: false, content, details: { signature } } };
}
