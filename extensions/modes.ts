import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Input, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const CUSTOM_TYPE = "mode-switch";
// Opt-in tools. A mode without an explicit `tools` list never gets them.
// Each active tool puts its description and guidance into the system prompt.
// The delegation tools carry orchestration text that only orchestrator modes
// should see; the browser tools carry approval rules that only browser modes
// need. Every other mode stays free of that context.
const OPT_IN_TOOLS = new Set(["web_search", "delegate", "delegation_status", "delegation_control", "delegation_resume", "delegation_review", "agent_browser", "agent_browser_session"]);
const SYSTEM_PROMPT_SECTIONS = new Set(["available_tools", "custom_tools_note", "guidelines", "pi_docs", "append_prompt", "project_context", "skills", "date", "cwd"]);
const SECTION_HEADINGS: Record<string, string[]> = {
  available_tools: ["Tools", "Available tools"],
  custom_tools_note: ["Custom tools"],
  guidelines: ["Guidelines"],
  pi_docs: ["Pi documentation"],
  append_prompt: ["Additional instructions"],
  project_context: ["Project Context"],
  skills: ["Skills", "Available skills"],
};

type ModeDef = { key: string; label: string; opener?: string; appendix?: string; systemPrompt?: string; removeSections?: string[]; tools?: string[] };
type ModeSource = { kind: string; path?: string };
type EffectiveMode = { definition: ModeDef; source: ModeSource; resolution: string; sha256: string; effectiveTools: string[] };
type StoredMode = { definition?: unknown; mode?: unknown; source?: unknown; sha256?: unknown };

const REQUEST_ENV_CACHE = Symbol.for("pi.modes.requested-environment");
const EFFECTIVE_ENV_KEYS = [
  "PI_EFFECTIVE_PROMPT_MODE",
  "PI_EFFECTIVE_PROMPT_MODE_SHA256",
  "PI_EFFECTIVE_PROMPT_MODE_SOURCE",
  "PI_EFFECTIVE_PROMPT_MODE_FILE",
  "PI_EFFECTIVE_PROMPT_MODE_TOOLS",
] as const;

const BUILTIN: ModeDef[] = [
  { key: "coding", label: "Coding", appendix: "Focus on concise, practical coding help." },
  { key: "plan", label: "Plan", opener: "Make a concise implementation plan before changing files.", appendix: "Do not edit files unless the user asks you to proceed." },
  { key: "review", label: "Review", opener: "Review the current work for correctness, risks, and missing tests." },
  { key: "explain", label: "Explain", opener: "Explain the relevant code and decisions clearly before proposing changes." },
];

function agentDir() { return getAgentDir(); }
function modeDir() { return join(agentDir(), "modes"); }
function modePath(key: string) { return join(modeDir(), `${key}.json`); }
function slugifyKey(value: string) { return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, ""); }
function valid(raw: any): ModeDef | null {
  const key = String(raw?.key ?? "").trim().toLowerCase();
  const label = String(raw?.label ?? "").trim();
  const opener = String(raw?.opener ?? "").trim();
  const appendix = typeof raw?.appendix === "string" ? raw.appendix : "";
  const systemPrompt = typeof raw?.systemPrompt === "string" ? raw.systemPrompt : "";
  const removeSections = Array.isArray(raw?.removeSections) ? raw.removeSections.filter((s: any) => typeof s === "string" && SYSTEM_PROMPT_SECTIONS.has(s)) : [];
  const tools: string[] | undefined = Array.isArray(raw?.tools)
    ? [...new Set((raw.tools as unknown[]).filter((tool): tool is string => typeof tool === "string" && !!tool.trim()).map((tool) => tool.trim()))]
    : undefined;
  if (!/^[a-z][a-z0-9_-]*$/.test(key) || !label || (!opener && !appendix.trim() && !systemPrompt)) return null;
  return { key, label, ...(opener ? { opener } : {}), ...(appendix.trim() ? { appendix } : {}), ...(systemPrompt.trim() ? { systemPrompt } : {}), ...(removeSections.length ? { removeSections } : {}), ...(tools !== undefined ? { tools } : {}) };
}
function loadModes(): ModeDef[] {
  const byKey = new Map(BUILTIN.map((m) => [m.key, m]));
  try {
    if (existsSync(modeDir())) for (const file of readdirSync(modeDir())) {
      if (!file.endsWith(".json")) continue;
      const mode = valid(JSON.parse(readFileSync(join(modeDir(), file), "utf8")));
      if (mode) byKey.set(mode.key, mode);
    }
  } catch {}
  return [...byKey.values()];
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
// Hash the normalized shape (empty fields dropped) so the checksum does not
// depend on how a definition was written. Resume re-validates the snapshot
// through valid(), so hashing anything else breaks every later startup.
function modeSha256(mode: ModeDef): string {
  return createHash("sha256").update(canonicalJson(valid(mode) ?? mode)).digest("hex");
}
function strictMode(raw: unknown, origin: string): ModeDef {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${origin}: expected a JSON object`);
  const object = raw as Record<string, unknown>;
  const allowed = new Set(["key", "label", "opener", "appendix", "systemPrompt", "removeSections", "tools"]);
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${origin}: unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  if (typeof object.key !== "string" || !/^[a-z][a-z0-9_-]*$/.test(object.key)) throw new Error(`${origin}: key must match ^[a-z][a-z0-9_-]*$`);
  if (typeof object.label !== "string" || !object.label.trim()) throw new Error(`${origin}: label must be a non-empty string`);
  for (const field of ["opener", "appendix", "systemPrompt"] as const) {
    if (object[field] !== undefined && typeof object[field] !== "string") throw new Error(`${origin}: ${field} must be a string`);
  }
  if (object.removeSections !== undefined) {
    if (!Array.isArray(object.removeSections) || object.removeSections.some((item) => typeof item !== "string" || !SYSTEM_PROMPT_SECTIONS.has(item))) {
      throw new Error(`${origin}: removeSections must contain only: ${[...SYSTEM_PROMPT_SECTIONS].join(", ")}`);
    }
  }
  if (object.tools !== undefined) {
    if (!Array.isArray(object.tools) || object.tools.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error(`${origin}: tools must be an array of non-empty strings`);
    }
  }
  const mode = valid(object);
  if (!mode) throw new Error(`${origin}: at least one of opener, appendix, or systemPrompt must be non-empty`);
  return mode;
}
function loadModeFile(path: string): ModeDef {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error: any) { throw new Error(`cannot read ${path}: ${error.message}`); }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (error: any) { throw new Error(`invalid JSON in ${path}: ${error.message}`); }
  return strictMode(raw, path);
}
function globalMode(key: string): { mode: ModeDef; path?: string } | null {
  let found = BUILTIN.find((mode) => mode.key === key);
  let foundPath: string | undefined;
  try {
    if (existsSync(modeDir())) for (const file of readdirSync(modeDir())) {
      if (!file.endsWith(".json")) continue;
      const path = join(modeDir(), file);
      const mode = valid(JSON.parse(readFileSync(path, "utf8")));
      if (mode?.key === key) { found = mode; foundPath = path; }
    }
  } catch {}
  return found ? { mode: found, ...(foundPath ? { path: foundPath } : {}) } : null;
}
function requestedEnvironment(): { mode?: string; file?: string } {
  const holder = process as any;
  if (!holder[REQUEST_ENV_CACHE]) {
    holder[REQUEST_ENV_CACHE] = {
      ...(typeof process.env.PI_PROMPT_MODE === "string" ? { mode: process.env.PI_PROMPT_MODE } : {}),
      ...(typeof process.env.PI_PROMPT_MODE_FILE === "string" ? { file: process.env.PI_PROMPT_MODE_FILE } : {}),
    };
  }
  // Requested-mode variables are consumed by this process. Children receive only PI_EFFECTIVE_* metadata.
  delete process.env.PI_PROMPT_MODE;
  delete process.env.PI_PROMPT_MODE_FILE;
  return holder[REQUEST_ENV_CACHE];
}
function storedModeFromEntries(entries: readonly any[]): StoredMode | null {
  let stored: StoredMode | null = null;
  for (const entry of entries) {
    if (entry?.type === "custom" && entry.customType === CUSTOM_TYPE && entry.data && typeof entry.data === "object") stored = entry.data;
  }
  return stored;
}
function customModeKeys(): string[] {
  try {
    if (!existsSync(modeDir())) return [];
    return readdirSync(modeDir()).filter((f) => f.endsWith(".json")).map((f) => basename(f, ".json")).sort();
  } catch {
    return [];
  }
}
function saveMode(mode: ModeDef) {
  mkdirSync(modeDir(), { recursive: true });
  writeFileSync(modePath(mode.key), JSON.stringify(mode, null, 2) + "\n", "utf8");
}
function escapeRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function removeSectionByHeading(prompt: string, heading: string): string {
  const h = escapeRegex(heading);
  return prompt.replace(new RegExp(`\\n?#{1,3}\\s+${h}\\s*\\n[\\s\\S]*?(?=\\n#{1,3}\\s+|$)`, "gi"), "\n").trim();
}
function removePromptSections(prompt: string, sections: string[] | undefined): string {
  let next = prompt;
  for (const section of sections ?? []) {
    if (section === "date") next = next.replace(/^Current date:.*$/gim, "").trim();
    else if (section === "cwd") next = next.replace(/^Current working directory:.*$/gim, "").trim();
    else for (const heading of SECTION_HEADINGS[section] ?? []) next = removeSectionByHeading(next, heading);
  }
  return next.replace(/\n{3,}/g, "\n\n").trim();
}
function buildClaudeCodeModeSystemPrompt(mode: ModeDef, event: any): string {
  const removed = new Set(mode.removeSections ?? []);
  const parts: string[] = ["You are Claude Code, Anthropic's official CLI for Claude."];

  if (mode.systemPrompt?.trim()) {
    parts.push(mode.systemPrompt.trim());
  } else {
    const extra = [mode.opener, mode.appendix].filter(Boolean).join("\n\n").trim();
    if (extra) parts.push("# Current prompt mode: " + mode.label + "\n" + extra);
  }

  if (!removed.has("append_prompt")) {
    const append = String(event.systemPromptOptions?.appendSystemPrompt ?? "").trim();
    if (append) parts.push("# Additional instructions\n" + append);
  }

  if (!removed.has("project_context")) {
    const contextFiles = event.systemPromptOptions?.contextFiles ?? [];
    if (Array.isArray(contextFiles) && contextFiles.length > 0) {
      const context = contextFiles
        .map((file: any) => `## ${file.path}\n\n${String(file.content ?? "").trim()}`)
        .join("\n\n");
      if (context.trim()) parts.push("# Project Context\n\nProject-specific instructions and guidelines:\n\n" + context);
    }
  }

  if (!removed.has("cwd")) {
    const cwd = event.systemPromptOptions?.cwd;
    if (cwd) parts.push("Current working directory: " + String(cwd).replace(/\\/g, "/"));
  }
  if (!removed.has("date")) {
    const now = new Date();
    parts.push("Current date: " + now.toISOString().slice(0, 10));
  }
  return parts.filter((part) => part.trim()).join("\n\n");
}

function updateModeStatus(ctx: any, mode: ModeDef) {
  if (ctx.hasUI) ctx.ui.setStatus("mode", ctx.ui.theme.fg("accent", `mode:${mode.label}`));
}

async function selectModeFuzzy(ctx: any, title: string, modes: ModeDef[], activeMode: string): Promise<string | null> {
  type Item = { mode: ModeDef; haystack: string; score: number };

  return await ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: (value: string | null) => void) => {
    const input = new Input();
    input.focused = true;
    let selected = 0;
    let cachedLines: string[] | undefined;

    const textOf = (m: ModeDef) => (m.opener || m.appendix || m.systemPrompt || "").replace(/\s+/g, " ").trim();
    const baseItems: Item[] = modes.map((mode) => ({
      mode,
      haystack: `${mode.key} ${mode.label} ${textOf(mode)}`.toLowerCase(),
      score: 0,
    }));

    function fuzzyScore(query: string, haystack: string): number {
      if (!query) return 1;
      let qi = 0;
      let score = 0;
      let streak = 0;
      for (let hi = 0; hi < haystack.length && qi < query.length; hi++) {
        if (haystack[hi] !== query[qi]) { streak = 0; continue; }
        streak++;
        score += 4 + streak * 3 - Math.min(hi, 40) * 0.02;
        qi++;
      }
      return qi === query.length ? score : -1;
    }

    function filtered(): Item[] {
      const query = input.getValue().trim().toLowerCase();
      return baseItems
        .map((item) => ({ ...item, score: fuzzyScore(query, item.haystack) }))
        .filter((item) => item.score >= 0)
        .sort((a, b) => b.score - a.score || a.mode.key.localeCompare(b.mode.key));
    }
    function clampSelected(items = filtered()) {
      selected = items.length ? Math.max(0, Math.min(items.length - 1, selected)) : 0;
    }
    function visibleItemCount(): number {
      const rows = process.stdout.rows || 30;
      return Math.max(3, Math.floor((rows * 0.75 - 9) / 2));
    }
    function visibleWindow(items: Item[]) {
      const count = visibleItemCount();
      const start = Math.max(0, Math.min(selected - count + 1, items.length - count));
      return { start, end: Math.min(items.length, start + count), count };
    }

    function refresh() { cachedLines = undefined; tui.requestRender(); }
    function select(delta: number) {
      const items = filtered();
      selected = items.length ? Math.max(0, Math.min(items.length - 1, selected + delta)) : 0;
      refresh();
    }
    function submit() {
      const item = filtered()[selected];
      if (item) done(item.mode.key);
    }
    function pad(line: string, width: number) {
      return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
    }
    function panel(line: string, width: number) {
      return theme.bg("customMessageBg", pad(truncateToWidth(line, width), width));
    }
    function add(lines: string[], width: number, line = "") {
      lines.push(panel(line, width));
    }

    input.onSubmit = submit;
    input.onEscape = () => done(null);

    function handleInput(data: string) {
      if (matchesKey(data, Key.escape)) { done(null); return; }
      if (matchesKey(data, Key.enter)) { submit(); return; }
      if (matchesKey(data, Key.up)) { select(-1); return; }
      if (matchesKey(data, Key.down)) { select(1); return; }

      input.handleInput(data);
      selected = 0;
      refresh();
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;
      const inner = Math.max(40, width - 4);
      const items = filtered();
      clampSelected(items);
      const { start, end } = visibleWindow(items);
      const visible = items.slice(start, end);
      const lines: string[] = [];

      add(lines, width, theme.fg("accent", "╭" + "─".repeat(width - 2) + "╮"));
      add(lines, width, theme.fg("accent", `│ ${title}`) + theme.fg("dim", " — fuzzy search, ↑↓, Enter, Esc"));
      add(lines, width, theme.fg("accent", "├" + "─".repeat(width - 2) + "┤"));
      add(lines, width, theme.fg("muted", "│ Search"));
      for (const line of input.render(inner)) add(lines, width, theme.fg("accent", "│ ") + line);
      add(lines, width, theme.fg("accent", "├" + "─".repeat(width - 2) + "┤"));

      if (visible.length === 0) {
        add(lines, width, theme.fg("warning", "│ No matching modes"));
      } else {
        for (let i = 0; i < visible.length; i++) {
          const itemIndex = start + i;
          const mode = visible[i].mode;
          const isSelected = itemIndex === selected;
          const cursor = isSelected ? theme.fg("accent", "❯") : " ";
          const current = mode.key === activeMode ? theme.fg("success", " current") : "";
          const title = `${mode.key} — ${mode.label}`;
          add(lines, width, `│ ${cursor} ${isSelected ? theme.fg("accent", title) : theme.fg("text", title)}${current}`);

          const desc = textOf(mode);
          if (desc) add(lines, width, theme.fg("muted", `│     ${truncateToWidth(desc, inner - 5)}`));
        }
      }

      add(lines, width, theme.fg("accent", "├" + "─".repeat(width - 2) + "┤"));
      const range = items.length ? `showing ${start + 1}-${end}` : "showing 0";
      add(lines, width, theme.fg("dim", `│ ${items.length} match${items.length === 1 ? "" : "es"} / ${modes.length} modes • ${range}`));
      add(lines, width, theme.fg("accent", "╰" + "─".repeat(width - 2) + "╯"));

      cachedLines = lines;
      return lines;
    }

    return {
      get focused() { return true; },
      set focused(value: boolean) { input.focused = value; },
      render,
      invalidate: () => { cachedLines = undefined; input.invalidate(); },
      handleInput,
    };
  }, { overlay: true, overlayOptions: { width: "75%", maxHeight: "80%", minWidth: 64 } });
}

async function openModeForm(ctx: any, initial: ModeDef, availableTools: string[], defaultTools: string[]): Promise<ModeDef | null> {
  const sections = [...SYSTEM_PROMPT_SECTIONS];

  return await ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: (value: ModeDef | null) => void) => {
    const editorTheme: EditorTheme = {
      borderColor: (s) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (s) => theme.fg("accent", s),
        selectedText: (s) => theme.fg("accent", s),
        description: (s) => theme.fg("muted", s),
        scrollInfo: (s) => theme.fg("dim", s),
        noMatch: (s) => theme.fg("warning", s),
      },
    };

    const fieldNames = ["key", "label", "opener", "systemPrompt", "appendix", "removeSections", "tools"] as const;
    type FieldName = typeof fieldNames[number];
    const labels: Record<FieldName, string> = {
      key: "Key",
      label: "Label",
      opener: "Opener",
      systemPrompt: "System Prompt",
      appendix: "Appendix",
      removeSections: "Remove Sections",
      tools: "Tools",
    };
    let active = 0;
    let checklistIndex = 0;
    let toolChecklistIndex = 0;
    let cachedLines: string[] | undefined;
    let outerFocused = true;
    const selectedSections = new Set(initial.removeSections ?? []);
    let manageTools = initial.tools !== undefined;
    const selectedTools = new Set(initial.tools ?? defaultTools);

    const editors: Record<Exclude<FieldName, "removeSections" | "tools">, Editor> = {
      key: new Editor(tui, editorTheme),
      label: new Editor(tui, editorTheme),
      opener: new Editor(tui, editorTheme),
      systemPrompt: new Editor(tui, editorTheme),
      appendix: new Editor(tui, editorTheme),
    };
    editors.key.setText(initial.key ?? "");
    editors.label.setText(initial.label ?? "");
    editors.opener.setText(initial.opener ?? "");
    editors.systemPrompt.setText(initial.systemPrompt ?? "");
    editors.appendix.setText(initial.appendix ?? "");
    for (const editor of Object.values(editors)) editor.disableSubmit = true;

    function refresh() {
      cachedLines = undefined;
      tui.requestRender();
    }
    function activeField(): FieldName { return fieldNames[active]; }
    function moveTab(delta: number) {
      active = (active + delta + fieldNames.length) % fieldNames.length;
      refresh();
    }
    function currentMode(): ModeDef | null {
      const key = slugifyKey(editors.key.getExpandedText());
      const label = editors.label.getExpandedText().trim();
      const opener = editors.opener.getExpandedText().trim();
      const systemPrompt = editors.systemPrompt.getExpandedText().trim();
      const appendix = editors.appendix.getExpandedText().trim();
      const removeSections = sections.filter((s) => selectedSections.has(s));
      const tools = manageTools ? availableTools.filter((tool) => selectedTools.has(tool)) : undefined;
      return valid({ key, label, opener, systemPrompt, appendix, removeSections, tools });
    }

    function save() {
      const mode = currentMode();
      if (!mode) return;
      done(mode);
    }

    function pad(line: string, width: number) {
      return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
    }
    function panel(line: string, width: number) {
      return theme.bg("customMessageBg", pad(truncateToWidth(line, width), width));
    }
    function add(lines: string[], width: number, line = "") {
      lines.push(panel(line, width));
    }

    function handleInput(data: string) {
      if (matchesKey(data, Key.escape)) { done(null); return; }
      if (matchesKey(data, Key.ctrl("s"))) { save(); return; }
      if (matchesKey(data, Key.tab)) { moveTab(1); return; }
      if (matchesKey(data, Key.shift("tab"))) { moveTab(-1); return; }

      if (activeField() === "removeSections") {
        if (matchesKey(data, Key.up)) checklistIndex = Math.max(0, checklistIndex - 1);
        else if (matchesKey(data, Key.down)) checklistIndex = Math.min(sections.length - 1, checklistIndex + 1);
        else if (matchesKey(data, Key.space) || matchesKey(data, Key.enter)) {
          const section = sections[checklistIndex];
          if (selectedSections.has(section)) selectedSections.delete(section);
          else selectedSections.add(section);
        }
        refresh();
        return;
      }

      if (activeField() === "tools") {
        if (matchesKey(data, Key.up)) toolChecklistIndex = Math.max(0, toolChecklistIndex - 1);
        else if (matchesKey(data, Key.down)) toolChecklistIndex = Math.min(availableTools.length, toolChecklistIndex + 1);
        else if (matchesKey(data, Key.space) || matchesKey(data, Key.enter)) {
          if (toolChecklistIndex === 0) manageTools = !manageTools;
          else {
            manageTools = true;
            const tool = availableTools[toolChecklistIndex - 1];
            if (selectedTools.has(tool)) selectedTools.delete(tool);
            else selectedTools.add(tool);
          }
        }
        refresh();
        return;
      }

      const editor = editors[activeField() as Exclude<FieldName, "removeSections" | "tools">];
      editor.handleInput(data);
      refresh();
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;
      for (const [name, editor] of Object.entries(editors)) editor.focused = outerFocused && name === activeField();

      const lines: string[] = [];
      const inner = Math.max(40, width - 4);
      add(lines, width, theme.fg("accent", "╭" + "─".repeat(width - 2) + "╮"));
      add(lines, width, theme.fg("accent", "│ Edit prompt mode") + theme.fg("dim", " — Tab/Shift+Tab fields, Ctrl+S save, Esc cancel"));
      add(lines, width, theme.fg("accent", "├" + "─".repeat(width - 2) + "┤"));

      const tabLine = fieldNames.map((name, i) => {
        const label = ` ${labels[name]} `;
        return i === active ? theme.bg("selectedBg", theme.fg("accent", label)) : theme.fg("muted", label);
      }).join(" ");
      add(lines, width, "│ " + tabLine);
      add(lines, width, theme.fg("accent", "├" + "─".repeat(width - 2) + "┤"));

      const field = activeField();
      add(lines, width, theme.fg("accent", `│ ${labels[field]}`));
      add(lines, width, theme.fg("dim", "│ " + (field === "removeSections" || field === "tools" ? "↑↓ move • Space toggle" : "Edit text. Tab moves to the next field.")));
      add(lines, width, "│");

      if (field === "removeSections") {
        for (let i = 0; i < sections.length; i++) {
          const section = sections[i];
          const cursor = i === checklistIndex ? theme.fg("accent", "❯") : " ";
          const check = selectedSections.has(section) ? theme.fg("success", "☑") : theme.fg("muted", "☐");
          const text = i === checklistIndex ? theme.fg("accent", section) : theme.fg("text", section);
          add(lines, width, `│ ${cursor} ${check} ${text}`);
        }
      } else if (field === "tools") {
        const manageCursor = toolChecklistIndex === 0 ? theme.fg("accent", "❯") : " ";
        const manageCheck = manageTools ? theme.fg("success", "☑") : theme.fg("muted", "☐");
        add(lines, width, `│ ${manageCursor} ${manageCheck} ${toolChecklistIndex === 0 ? theme.fg("accent", "Use this mode's tool selection") : theme.fg("text", "Use this mode's tool selection")}`);
        for (let i = 0; i < availableTools.length; i++) {
          const tool = availableTools[i];
          const selected = selectedTools.has(tool);
          const focused = toolChecklistIndex === i + 1;
          const cursor = focused ? theme.fg("accent", "❯") : " ";
          const check = selected ? theme.fg("success", "☑") : theme.fg("muted", "☐");
          const text = focused ? theme.fg("accent", tool) : theme.fg(manageTools ? "text" : "dim", tool);
          add(lines, width, `│ ${cursor} ${check} ${text}`);
        }
      } else {
        const editor = editors[field];
        const maxEditorLines = Math.max(6, process.stdout.rows ? process.stdout.rows - 14 : 18);
        const editorLines = editor.render(inner);
        for (const line of editorLines.slice(0, maxEditorLines)) add(lines, width, theme.fg("accent", "│ ") + line);
        if (editorLines.length > maxEditorLines) add(lines, width, theme.fg("dim", `│ … ${editorLines.length - maxEditorLines} more editor lines hidden`));
      }

      add(lines, width, theme.fg("accent", "├" + "─".repeat(width - 2) + "┤"));
      const mode = currentMode();
      if (!mode) add(lines, width, theme.fg("warning", "│ Invalid mode: key, label, and opener, appendix, or systemPrompt are required."));
      else add(lines, width, theme.fg("success", `│ Will save: ${mode.key} — ${mode.label}`));
      add(lines, width, theme.fg("accent", "╰" + "─".repeat(width - 2) + "╯"));
      cachedLines = lines;
      return lines;
    }

    return {
      get focused() { return outerFocused; },
      set focused(value: boolean) { outerFocused = value; for (const [name, editor] of Object.entries(editors)) editor.focused = value && name === activeField(); },
      render,
      invalidate: () => { cachedLines = undefined; },
      handleInput,
    };
  }, { overlay: true, overlayOptions: { width: "82%", maxHeight: "85%", minWidth: 64 } });
}

export default function(pi: ExtensionAPI) {
  let activeMode = "coding";
  let defaultTools: string[] = [];
  let effective: EffectiveMode | undefined;
  let startupError: string | undefined;
  const requestedEnv = requestedEnvironment();

  pi.registerFlag("prompt-mode", {
    description: "Use a named prompt mode for this run/session",
    type: "string",
  });
  pi.registerFlag("prompt-mode-file", {
    description: "Use a run-scoped ModeDef JSON file (takes precedence over --prompt-mode)",
    type: "string",
  });

  function availableToolNames(): string[] {
    return pi.getAllTools().map((tool) => tool.name).sort();
  }

  function selectedTools(mode: ModeDef): { active: string[]; missing: string[] } {
    const available = new Set(availableToolNames());
    const requested = mode.tools ?? defaultTools;
    return {
      active: requested.filter((tool) => available.has(tool)),
      missing: requested.filter((tool) => !available.has(tool)),
    };
  }

  function sourceValue(raw: unknown): ModeSource {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { kind: "session-snapshot" };
    const object = raw as Record<string, unknown>;
    const kind = typeof object.kind === "string" && object.kind ? object.kind : "session-snapshot";
    return { kind, ...(typeof object.path === "string" && object.path ? { path: object.path } : {}) };
  }

  function warn(message: string, ctx?: any) {
    console.error(`[prompt-mode] warning: ${message}`);
    if (ctx?.hasUI) ctx.ui.notify(message, "warning");
  }

  function makeEffective(mode: ModeDef, source: ModeSource, resolution: string): EffectiveMode {
    const tools = selectedTools(mode);
    return { definition: mode, source, resolution, sha256: modeSha256(mode), effectiveTools: tools.active };
  }

  function persistEffective(value: EffectiveMode) {
    pi.appendEntry(CUSTOM_TYPE, {
      version: 1,
      mode: value.definition.key,
      definition: value.definition,
      source: value.source,
      sha256: value.sha256,
      effectiveTools: value.effectiveTools,
    });
  }

  function exportEffective(value: EffectiveMode) {
    for (const key of EFFECTIVE_ENV_KEYS) delete process.env[key];
    process.env.PI_EFFECTIVE_PROMPT_MODE = value.definition.key;
    process.env.PI_EFFECTIVE_PROMPT_MODE_SHA256 = value.sha256;
    process.env.PI_EFFECTIVE_PROMPT_MODE_SOURCE = value.resolution;
    process.env.PI_EFFECTIVE_PROMPT_MODE_TOOLS = value.effectiveTools.join(",");
    if (value.source.path) process.env.PI_EFFECTIVE_PROMPT_MODE_FILE = value.source.path;
  }

  function activate(mode: ModeDef, source: ModeSource, resolution: string, ctx: any, persist: boolean, strictTools = false) {
    const next = makeEffective(mode, source, resolution);
    const missing = selectedTools(mode).missing;
    if (missing.length && (strictTools || mode.tools !== undefined)) throw new Error(`mode ${mode.key} requests unavailable tool${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
    if (missing.length) warn(`mode ${mode.key} requests unavailable tools (disabled): ${missing.join(", ")}`, ctx);
    effective = next;
    activeMode = mode.key;
    pi.setActiveTools(next.effectiveTools);
    exportEffective(next);
    if (persist) persistEffective(next);
    updateModeStatus(ctx, mode);
  }

  function modeByRequestedKey(raw: string, sourceKind: string): { mode: ModeDef; source: ModeSource } {
    const key = raw.trim().toLowerCase();
    if (!key) throw new Error(`${sourceKind} mode key is empty`);
    const found = globalMode(key);
    if (!found) throw new Error(`unknown prompt mode key ${JSON.stringify(key)}; available: ${loadModes().map((mode) => mode.key).join(", ")}`);
    return { mode: found.mode, source: { kind: sourceKind, ...(found.path ? { path: found.path } : {}) } };
  }

  function modeByRequestedFile(raw: string, sourceKind: string): { mode: ModeDef; source: ModeSource } {
    if (!raw.trim()) throw new Error(`${sourceKind} mode file path is empty`);
    const path = resolve(process.cwd(), raw);
    return { mode: loadModeFile(path), source: { kind: sourceKind, path } };
  }

  function resolveStartup(ctx: any): { mode: ModeDef; source: ModeSource; resolution: string; persist: boolean; strictTools: boolean } {
    const cliFile = pi.getFlag("prompt-mode-file");
    const cliMode = pi.getFlag("prompt-mode");
    if (typeof cliFile === "string") {
      if (typeof cliMode === "string") warn("--prompt-mode-file takes precedence over --prompt-mode", ctx);
      const selected = modeByRequestedFile(cliFile, "cli-file");
      return { ...selected, resolution: "cli-file", persist: true, strictTools: true };
    }
    if (typeof cliMode === "string") {
      const selected = modeByRequestedKey(cliMode, "cli-key");
      return { ...selected, resolution: "cli-key", persist: true, strictTools: true };
    }

    const stored = storedModeFromEntries(ctx.sessionManager.getBranch());
    if (stored?.definition !== undefined) {
      const mode = strictMode(stored.definition, "persisted prompt-mode snapshot");
      if (stored.mode !== undefined && stored.mode !== mode.key) throw new Error("persisted prompt-mode snapshot key does not match data.mode");
      const sha256 = modeSha256(mode);
      // Older snapshots hashed the raw definition (with empty fields kept); accept those too.
      const rawSha256 = createHash("sha256").update(canonicalJson(stored.definition)).digest("hex");
      if (typeof stored.sha256 !== "string" || (stored.sha256 !== sha256 && stored.sha256 !== rawSha256)) throw new Error(`persisted prompt-mode snapshot SHA-256 mismatch (computed ${sha256})`);
      return { mode, source: sourceValue(stored.source), resolution: "session-snapshot", persist: false, strictTools: false };
    }
    if (typeof stored?.mode === "string") {
      const found = globalMode(stored.mode.trim().toLowerCase());
      if (found) {
        return {
          mode: found.mode,
          source: { kind: "legacy-key", ...(found.path ? { path: found.path } : {}) },
          resolution: "legacy-session-key",
          persist: true,
          strictTools: false,
        };
      }
      warn(`legacy session mode ${JSON.stringify(stored.mode)} is unavailable; continuing fallback resolution`, ctx);
    }

    if (typeof requestedEnv.file === "string" && requestedEnv.file.trim()) {
      try {
        const selected = modeByRequestedFile(requestedEnv.file, "env-file");
        return { ...selected, resolution: "env-file", persist: true, strictTools: true };
      } catch (error: any) {
        warn(`PI_PROMPT_MODE_FILE ignored: ${error.message}`, ctx);
      }
    }
    if (typeof requestedEnv.mode === "string" && requestedEnv.mode.trim()) {
      try {
        const selected = modeByRequestedKey(requestedEnv.mode, "env-key");
        return { ...selected, resolution: "env-key", persist: true, strictTools: true };
      } catch (error: any) {
        warn(`PI_PROMPT_MODE ignored: ${error.message}`, ctx);
      }
    }
    const coding = globalMode("coding")!;
    return { mode: coding.mode, source: { kind: "default", ...(coding.path ? { path: coding.path } : {}) }, resolution: "default", persist: true, strictTools: false };
  }

  function activateInteractive(mode: ModeDef, source: ModeSource, ctx: any) {
    activate(mode, source, "interactive", ctx, true, true);
    startupError = undefined;
  }

  pi.registerCommand("mode", {
    description: "Switch prompt mode",
    getArgumentCompletions: (prefix: string) => loadModes().filter((m) => m.key.startsWith(prefix.trim().toLowerCase())).map((m) => ({ value: m.key, label: m.label, opener: m.opener, appendix: m.appendix, systemPrompt: m.systemPrompt, removeSections: m.removeSections, tools: m.tools })),
    handler: async (args, ctx) => {
      const modes = loadModes();
      let key = args.trim().toLowerCase();
      if (!key) {
        const choice = await selectModeFuzzy(ctx, "Select prompt mode", modes, activeMode);
        if (!choice) {
          ctx.ui.notify("Current mode: " + activeMode + ". Available: " + modes.map((m) => m.key).join(", "), "info");
          return;
        }
        key = choice.trim().toLowerCase();
      }
      const mode = modes.find((m) => m.key === key);
      if (!mode) { ctx.ui.notify("Unknown mode: " + key + ". Available: " + modes.map((m) => m.key).join(", "), "error"); return; }
      const found = globalMode(mode.key);
      activateInteractive(mode, { kind: "interactive-key", ...(found?.path ? { path: found.path } : {}) }, ctx);
      ctx.ui.notify("Mode: " + mode.label, "info");
    },
  });

  pi.registerCommand("mode-new", {
    description: "Create a prompt mode from the TUI",
    handler: async (args, ctx) => {
      const key = slugifyKey(args.trim() || "new-mode");
      const mode = await openModeForm(ctx, { key, label: key, opener: "" }, availableToolNames(), defaultTools);
      if (!mode) return;
      if (existsSync(modePath(mode.key))) {
        const overwrite = await ctx.ui.confirm("Overwrite mode?", `${modePath(mode.key)} already exists.`);
        if (!overwrite) return;
      }
      saveMode(mode);
      activateInteractive(mode, { kind: "interactive-new", path: modePath(mode.key) }, ctx);
      ctx.ui.notify(`Created and switched to mode: ${mode.label}`, "info");
    },
  });

  pi.registerCommand("mode-edit", {
    description: "Edit a prompt mode (built-ins are saved as custom overrides)",
    getArgumentCompletions: (prefix: string) => loadModes().filter((mode) => mode.key.startsWith(prefix.trim().toLowerCase())).map((mode) => ({ value: mode.key, label: mode.label })),
    handler: async (args, ctx) => {
      let key = args.trim().toLowerCase();
      if (!key) {
        const choice = await selectModeFuzzy(ctx, "Edit prompt mode", loadModes(), activeMode);
        if (!choice) return;
        key = choice;
      }
      const path = modePath(key);
      let initial: ModeDef | null = null;
      if (existsSync(path)) {
        try { initial = valid(JSON.parse(readFileSync(path, "utf8"))); } catch (err: any) { ctx.ui.notify(`Invalid JSON: ${err.message}`, "error"); return; }
      } else {
        initial = loadModes().find((mode) => mode.key === key) ?? null;
      }
      if (!initial) { ctx.ui.notify(`Mode not found or invalid: ${key}`, "error"); return; }
      const mode = await openModeForm(ctx, initial, availableToolNames(), defaultTools);
      if (!mode) return;
      saveMode(mode);
      if (mode.key !== key && existsSync(path)) unlinkSync(path);
      if (activeMode === key) activateInteractive(mode, { kind: "interactive-edit", path: modePath(mode.key) }, ctx);
      ctx.ui.notify(`Saved mode: ${mode.key}`, "info");
    },
  });

  pi.registerCommand("mode-delete", {
    description: "Delete a custom prompt mode",
    getArgumentCompletions: (prefix: string) => customModeKeys().filter((key) => key.startsWith(prefix.trim().toLowerCase())).map((key) => ({ value: key, label: key })),
    handler: async (args, ctx) => {
      let key = args.trim().toLowerCase();
      if (!key) {
        const customKeys = new Set(customModeKeys());
        const choice = await selectModeFuzzy(ctx, "Delete custom mode", loadModes().filter((m) => customKeys.has(m.key)), activeMode);
        if (!choice) return;
        key = choice;
      }
      const path = modePath(key);
      if (!existsSync(path)) { ctx.ui.notify(`Custom mode not found: ${key}`, "error"); return; }
      if (!await ctx.ui.confirm("Delete mode?", path)) return;
      unlinkSync(path);
      if (activeMode === key) {
        const coding = globalMode("coding")!;
        activateInteractive(coding.mode, { kind: "interactive-delete-fallback", ...(coding.path ? { path: coding.path } : {}) }, ctx);
      }
      ctx.ui.notify(`Deleted mode: ${key}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    startupError = undefined;
    defaultTools = pi.getActiveTools().filter((tool) => !OPT_IN_TOOLS.has(tool));
    try {
      const selected = resolveStartup(ctx);
      activate(selected.mode, selected.source, selected.resolution, ctx, selected.persist, selected.strictTools);
    } catch (error: any) {
      startupError = `Prompt mode startup failed: ${error.message}`;
      process.exitCode = 2;
      pi.setActiveTools([]);
      console.error(`[prompt-mode] error: ${startupError}`);
      if (ctx.hasUI) {
        ctx.ui.setStatus("mode", ctx.ui.theme.fg("error", "mode:error"));
        ctx.ui.notify(startupError, "error");
        // Terminal/RPC shutdown stays explicit; SDK hosts also receive the
        // session_start extension_error below and must reject creation.
        ctx.shutdown();
      }
      throw new Error(startupError);
    }
  });

  pi.on("input", async () => startupError ? { action: "handled" as const } : { action: "continue" as const });

  pi.on("before_agent_start", async (event, ctx) => {
    if (startupError || !effective) return;
    const mode = effective.definition;
    if (ctx.model?.provider === "claude-code") return { systemPrompt: buildClaudeCodeModeSystemPrompt(mode, event) };
    let systemPrompt = mode.systemPrompt?.trim() ? mode.systemPrompt : removePromptSections(event.systemPrompt, mode.removeSections);
    const extra = [mode.systemPrompt?.trim() ? "" : mode.opener, mode.appendix].filter(Boolean).join("\n\n").trim();
    if (extra) systemPrompt += "\n\n# Current prompt mode: " + mode.label + "\n" + extra;
    // A full systemPrompt override replaces the base prompt, which is where pi
    // embeds --append-system-prompt. Keep that content (headless/RPC callers
    // rely on it), mirroring the claude-code branch above.
    if (mode.systemPrompt?.trim() && !(mode.removeSections ?? []).includes("append_prompt")) {
      const append = String(event.systemPromptOptions?.appendSystemPrompt ?? "").trim();
      if (append) systemPrompt += "\n\n# Additional instructions\n" + append;
    }
    return { systemPrompt };
  });
}
