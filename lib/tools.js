// ---------------------------------------------------------------------------
// Tool registry: definitions + handlers, grouped, with presets.
//
// Backends:
//   - "cli"  : the Gemini CLI (free, robust, autonomous read-only tools)
//   - "web"  : the Gemini web UI via Playwright (for image/video generation)
//   - "ask"  : routed by GEMINI_BACKEND (auto -> cli if available, else web)
// ---------------------------------------------------------------------------
import * as cli from "./cli.js";
import * as web from "./web.js";

const j = (o) => JSON.stringify(o, null, 2);
const num = (v, d) => (typeof v === "number" ? v : d);

async function pickAskBackend() {
  const b = (process.env.GEMINI_BACKEND || "auto").toLowerCase();
  if (b === "web") return "web";
  if (b === "cli") return "cli";
  return (await cli.cliAvailable()) ? "cli" : "web";
}

export const TOOLS = [
  // --- core -----------------------------------------------------------------
  {
    name: "ask_gemini",
    group: "core",
    description:
      "Ask Google Gemini a question. No API key. Multimodal: attach files (images/PDFs/...) " +
      "and/or a whole directory of code as context. Routed to the Gemini CLI by default " +
      "(free, robust, can read files & search the web), falling back to the web UI. " +
      "Great for Q&A, code/file analysis, and a second opinion from another model.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The question / instruction." },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Optional. Absolute paths to attach (image/PDF/text/...).",
        },
        directory: {
          type: "string",
          description:
            "Optional. Absolute path to a folder to include as context (CLI backend; great for codebases).",
        },
        model: {
          type: "string",
          description: "Optional. 'flash-lite' | 'flash' | 'pro', or a raw model id.",
        },
        new_chat: {
          type: "boolean",
          description: "Optional (web backend). true = start a fresh chat.",
        },
        timeout_seconds: { type: "number", description: "Optional (default 180)." },
      },
      required: ["prompt"],
    },
    handler: async (a) => {
      const backend = await pickAskBackend();
      if (backend === "cli")
        return cli.cliAsk({
          prompt: a.prompt,
          files: a.files || [],
          directory: a.directory || null,
          model: a.model || null,
          timeout_seconds: num(a.timeout_seconds, 180),
        });
      return web.webAsk({
        prompt: a.prompt,
        files: a.files || [],
        model: a.model || null,
        new_chat: !!a.new_chat,
        timeout_seconds: num(a.timeout_seconds, 180),
      });
    },
  },
  {
    name: "gemini_brainstorm",
    group: "core",
    description:
      "Brainstorm a list of diverse, concrete ideas for a topic/problem (Gemini CLI).",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "What to brainstorm about." },
        count: { type: "number", description: "How many ideas (default 8)." },
        timeout_seconds: { type: "number" },
      },
      required: ["topic"],
    },
    handler: (a) =>
      cli.brainstorm({
        topic: a.topic,
        count: num(a.count, 8),
        timeout_seconds: num(a.timeout_seconds, 180),
      }),
  },

  // --- research -------------------------------------------------------------
  {
    name: "gemini_search",
    group: "research",
    description:
      "Web search via Gemini — grounded answer with source URLs (Gemini CLI). Free, real-time.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for." },
        timeout_seconds: { type: "number" },
      },
      required: ["query"],
    },
    handler: (a) =>
      cli.search({ query: a.query, timeout_seconds: num(a.timeout_seconds, 120) }),
  },
  {
    name: "gemini_deep_research",
    group: "research",
    description:
      "Autonomous multi-step web research on a topic; returns a structured report with sources (Gemini CLI). Can take a few minutes.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "The research topic / question." },
        timeout_seconds: { type: "number", description: "Default 600." },
      },
      required: ["topic"],
    },
    handler: (a) =>
      cli.deepResearch({ topic: a.topic, timeout_seconds: num(a.timeout_seconds, 600) }),
  },
  {
    name: "gemini_youtube",
    group: "research",
    description:
      "Analyze / summarize a YouTube video (transcript + content) via Gemini CLI.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "YouTube URL." },
        question: { type: "string", description: "Optional. What to ask about it." },
        timeout_seconds: { type: "number" },
      },
      required: ["url"],
    },
    handler: (a) =>
      cli.youtube({
        url: a.url,
        question: a.question,
        timeout_seconds: num(a.timeout_seconds, 300),
      }),
  },

  // --- analysis -------------------------------------------------------------
  {
    name: "gemini_analyze_code",
    group: "analysis",
    description:
      "Review/analyze a codebase folder (bugs, security, performance, quality) using the Gemini CLI with full directory context.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Absolute path to the code folder." },
        focus: { type: "string", description: "Optional. What to focus on." },
        question: { type: "string", description: "Optional. A specific question instead." },
        timeout_seconds: { type: "number", description: "Default 300." },
      },
      required: ["directory"],
    },
    handler: (a) =>
      cli.analyzeCode({
        directory: a.directory,
        focus: a.focus,
        question: a.question,
        timeout_seconds: num(a.timeout_seconds, 300),
      }),
  },
  {
    name: "gemini_analyze_files",
    group: "analysis",
    description:
      "Analyze one or more files (images, PDFs, documents, text) and answer a question about them (Gemini CLI, multimodal).",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "Absolute file paths.",
        },
        question: { type: "string", description: "What to ask about the files." },
        timeout_seconds: { type: "number" },
      },
      required: ["files"],
    },
    handler: (a) =>
      cli.analyzeFiles({
        files: a.files,
        question: a.question,
        timeout_seconds: num(a.timeout_seconds, 240),
      }),
  },
  {
    name: "gemini_analyze_url",
    group: "analysis",
    description: "Fetch and analyze/summarize a web page (Gemini CLI).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        question: { type: "string", description: "Optional." },
        timeout_seconds: { type: "number" },
      },
      required: ["url"],
    },
    handler: (a) =>
      cli.analyzeUrl({
        url: a.url,
        question: a.question,
        timeout_seconds: num(a.timeout_seconds, 180),
      }),
  },
  {
    name: "gemini_compare_urls",
    group: "analysis",
    description: "Fetch multiple web pages and compare them (Gemini CLI).",
    inputSchema: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string" } },
        question: { type: "string", description: "Optional." },
        timeout_seconds: { type: "number" },
      },
      required: ["urls"],
    },
    handler: (a) =>
      cli.compareUrls({
        urls: a.urls,
        question: a.question,
        timeout_seconds: num(a.timeout_seconds, 240),
      }),
  },

  // --- data -----------------------------------------------------------------
  {
    name: "gemini_structured",
    group: "data",
    description:
      "Get a structured JSON response matching a schema you provide (Gemini CLI). Returns parsed JSON.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The task / data." },
        schema: {
          type: "string",
          description: "JSON schema or example shape the output must match.",
        },
        timeout_seconds: { type: "number" },
      },
      required: ["prompt", "schema"],
    },
    handler: async (a) =>
      j(
        await cli.structured({
          prompt: a.prompt,
          schema: a.schema,
          timeout_seconds: num(a.timeout_seconds, 180),
        })
      ),
  },
  {
    name: "gemini_extract",
    group: "data",
    description:
      "Extract specific fields (entities/facts) from text as JSON (Gemini CLI).",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The source text." },
        fields: {
          type: "array",
          items: { type: "string" },
          description: "Field names to extract.",
        },
        timeout_seconds: { type: "number" },
      },
      required: ["text", "fields"],
    },
    handler: async (a) =>
      j(
        await cli.extract({
          text: a.text,
          fields: a.fields,
          timeout_seconds: num(a.timeout_seconds, 120),
        })
      ),
  },
  {
    name: "gemini_summarize",
    group: "data",
    description: "Summarize text at short/medium/long detail (Gemini CLI).",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        length: {
          type: "string",
          enum: ["short", "medium", "long"],
          description: "Default medium.",
        },
        timeout_seconds: { type: "number" },
      },
      required: ["content"],
    },
    handler: (a) =>
      cli.summarize({
        content: a.content,
        length: a.length || "medium",
        timeout_seconds: num(a.timeout_seconds, 180),
      }),
  },
  {
    name: "gemini_count_tokens",
    group: "data",
    description: "Rough, free token estimate for a piece of text (no API call).",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    handler: (a) => j(cli.countTokens({ text: a.text })),
  },

  // --- media (web UI; free, no API) ----------------------------------------
  {
    name: "generate_image",
    group: "media",
    description:
      "Generate an image with Gemini's image model ('Nano Banana') via the web UI. " +
      "Free (no API). Saves PNG(s) to disk and returns the paths.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Image description." },
        timeout_seconds: { type: "number", description: "Default 180." },
      },
      required: ["prompt"],
    },
    handler: async (a) => {
      const files = await web.generateImage({
        prompt: a.prompt,
        timeout_seconds: num(a.timeout_seconds, 180),
      });
      return "Image(s) saved:\n" + files.join("\n") + "\n(Open with the Read tool to view.)";
    },
  },
  {
    name: "generate_video",
    group: "media",
    description:
      "Generate a video with Gemini's video model ('Veo') via the web UI. " +
      "Free (uses subscription quota). Takes 1-3 min. Saves an MP4 and returns the path.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Video description." },
        timeout_seconds: { type: "number", description: "Default 420." },
      },
      required: ["prompt"],
    },
    handler: async (a) => {
      const files = await web.generateVideo({
        prompt: a.prompt,
        timeout_seconds: num(a.timeout_seconds, 420),
      });
      return "Video saved:\n" + files.join("\n");
    },
  },
];

// Presets to control how many tools are exposed (saves context window).
const PRESETS = {
  minimal: ["ask_gemini", "gemini_search", "generate_image"],
  core: ["core", "media"], // group names allowed
  research: ["ask_gemini", "research", "gemini_analyze_url", "gemini_compare_urls"],
  analysis: ["ask_gemini", "analysis", "data"],
  media: ["ask_gemini", "media"],
  data: ["ask_gemini", "data"],
  full: null, // all
};

export function selectTools() {
  // Explicit list wins.
  const explicit = (process.env.GEMINI_TOOLS || "").trim();
  if (explicit) {
    const want = new Set(explicit.split(",").map((s) => s.trim()).filter(Boolean));
    return TOOLS.filter((t) => want.has(t.name) || want.has(t.group));
  }
  const preset = (process.env.GEMINI_PRESET || "full").toLowerCase();
  const spec = PRESETS[preset];
  if (!spec) return TOOLS; // "full" or unknown -> all
  const want = new Set(spec);
  return TOOLS.filter((t) => want.has(t.name) || want.has(t.group));
}
