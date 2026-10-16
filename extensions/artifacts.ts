import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Artifacts (Chattering design/67). Two tools:
//   artifact — files the agent wrote (a web page or app folder, slides, a PDF,
//              a document) open in Chattering's side panel, versioned with the
//              conversation: the reader sees the version from their branch.
//   show     — a small self-contained HTML widget shown inline in the
//              conversation, rendered as an MCP App on Chattering's preview
//              address. Its HTML lives in the conversation, so it follows
//              regenerations and branches.
// Loaded by Chattering for web sessions (-e …/extensions/artifacts.ts).

const port = () => Number(process.env.CHATTERING_PORT || process.env.PORT || 7433);
const token = () => {
  if (process.env.CHATTERING_TOKEN) return process.env.CHATTERING_TOKEN;
  try { return readFileSync(join(homedir(), ".cache", "chattering", "lan-token"), "utf8").trim(); } catch { return ""; }
};
const here = (() => { try { return dirname(fileURLToPath(import.meta.url)); } catch { return __dirname; } })();
const SLIDES_SKILL = join(here, "..", "artifact-types", "slides", "SKILL.md");
const WIDGET_MAX = 256 * 1024;

const KIT = "Pages get Chattering's theme as the standard MCP Apps CSS variables — use them with a fallback, e.g. " +
  "background: var(--color-background-primary, #fff); color: var(--color-text-primary, #111); font-family: var(--font-sans, system-ui); " +
  "border-radius: var(--border-radius-md, 8px); also --color-background-secondary, --color-text-secondary, --color-border-primary, " +
  "--color-text-info/danger/success/warning, --font-mono. The reader may use a dark or a black-and-white e-ink theme: never hard-code a page colour you did not also theme. " +
  "window.chattering (await chattering.ready) offers sendMessage(text) (puts text in the reader's message box), openLink(url), " +
  "requestDisplayMode('fullscreen'). Pages may load libraries from any CDN (jsDelivr, unpkg, esm.sh, cdnjs) and fetch APIs.";

export default function artifacts(pi: ExtensionAPI) {
  pi.registerTool({
    name: "artifact", label: "artifact",
    description: "Open files you made in Chattering's artifact panel beside the conversation: a web page or app (a folder with index.html, or one .html file), " +
      "a slide deck (a folder with deck.json), a PDF, a Markdown document, an image, SVG or video. The files stay in the project; " +
      "Chattering keeps a version after each of your tool calls and shows the reader the version from their branch. " +
      "Call it after writing the files, once per artifact (again only to open a different one). " +
      "It returns preview addresses: open one with agent_browser, if you have it, to check the page works before you answer.",
    promptSnippet: "Show files you made (web page, app, slides, PDF, document) in the artifact panel beside the conversation",
    promptGuidelines: [
      "For anything the reader should see or use rather than read — a web page, an interactive app or game, a dashboard, a slide deck, a report as PDF — write real files in the project (a folder of its own, e.g. game/index.html plus its assets) and call artifact with that path. Prefer a folder over a single file when there are assets.",
      "Small, one-off visuals that belong in the flow of the answer (a chart, a diagram, a tiny demo) go inline with the show tool instead.",
      "Slides: before writing a deck, read " + SLIDES_SKILL + " and follow its format (deck.json plus one HTML file per slide).",
      KIT,
    ],
    parameters: Type.Object({
      path: Type.String({ description: "The folder or file, relative to the working directory or absolute." }),
      title: Type.Optional(Type.String({ description: "A short title for the panel and the card in the conversation." })),
      type: Type.Optional(StringEnum(["auto", "web", "slides", "pdf", "markdown", "image", "svg", "video"] as const)),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const session = ctx?.sessionManager?.getSessionFile?.();
      if (!session) throw new Error("This conversation is not saved yet, so it cannot hold an artifact.");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token()) headers.Authorization = "Bearer " + token();
      let res: Response;
      try {
        res = await fetch(`http://127.0.0.1:${port()}/api/artifacts/declare`, { method: "POST", headers, signal,
          body: JSON.stringify({ session, path: params.path, title: params.title || "", type: params.type || "auto" }) });
      } catch (e: any) {
        throw new Error(`Chattering is not answering on port ${port()} (${e?.cause?.code || e?.message}); the files are still in the project.`);
      }
      const data: any = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const lines = [`Opened ${params.title ? `"${params.title}" ` : ""}(${data.kind}) at ${data.path} in the reader's artifact panel.`];
      if (!data.versioned && data.scopeError) lines.push(`Versions of its binary assets are not kept: ${data.scopeError}`);
      if (data.versionNote) lines.push(data.versionNote);
      if (data.urls?.length) lines.push("Preview addresses (live files, for testing): " + data.urls.join("  "));
      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: data };
    },
  });

  pi.registerTool({
    name: "show", label: "show",
    description: "Show a small, self-contained HTML widget inline in the conversation, where your answer is: a chart, a diagram, an interactive explanation, a tiny game or calculator. " +
      "One HTML document (inline CSS and JavaScript; libraries from a CDN are fine), at most 256 KB. It is sized to its content, up to most of the screen height, and follows the reader's theme. " +
      "For anything larger, multi-file, or meant to be kept and reopened (an app, a site, slides, a report), write files and use the artifact tool instead.",
    promptSnippet: "Show a small HTML widget (chart, diagram, tiny interactive) inline in the conversation",
    promptGuidelines: [
      "Use show for visuals that belong inside the answer; keep the HTML focused and responsive (width 100%, no fixed page width).",
      KIT,
    ],
    parameters: Type.Object({
      html: Type.String({ description: "A complete HTML document or fragment." }),
      title: Type.Optional(Type.String({ description: "A short title, shown above the widget." })),
    }),
    async execute(_id, params) {
      const size = Buffer.byteLength(params.html || "", "utf8");
      if (!params.html || !params.html.trim()) throw new Error("The widget has no HTML.");
      if (size > WIDGET_MAX) throw new Error(`The widget is ${Math.round(size / 1024)} KB; the limit is 256 KB. Write files and use the artifact tool for something this large.`);
      return { content: [{ type: "text" as const, text: `Shown inline${params.title ? `: ${params.title}` : ""} (${Math.round(size / 1024)} KB).` }], details: { bytes: size } };
    },
  });
}
