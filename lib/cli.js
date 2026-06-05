// ---------------------------------------------------------------------------
// CLI backend: shells out to the official Gemini CLI (`gemini`).
// Free (uses your Google login), robust (no DOM scraping), and the model can
// autonomously use read-only tools (web search, file/URL reading) thanks to
// `--approval-mode plan` (read-only: it never edits your files).
//
// The prompt is passed via STDIN (no shell quoting issues for arbitrary text);
// flags (-m, --include-directories) go through argv. Output is JSON (`-o json`),
// from which we read `.response`.
// ---------------------------------------------------------------------------
import { spawn } from "node:child_process";

const GEMINI_CMD = "gemini"; // shell:true resolves gemini.cmd on Windows

let _available = null;
export async function cliAvailable() {
  if (_available !== null) return _available;
  _available = await new Promise((resolve) => {
    try {
      const c = spawn(GEMINI_CMD, ["--version"], { shell: true });
      const t = setTimeout(() => {
        try {
          c.kill();
        } catch {}
        resolve(false);
      }, 10000);
      c.on("error", () => {
        clearTimeout(t);
        resolve(false);
      });
      c.on("exit", (code) => {
        clearTimeout(t);
        resolve(code === 0);
      });
    } catch {
      resolve(false);
    }
  });
  return _available;
}

// Friendly keys -> CLI model ids. Unknown values are passed through as-is.
const CLI_MODEL_MAP = {
  "flash-lite": "gemini-2.5-flash-lite",
  flash: "gemini-2.5-flash",
  pro: "gemini-2.5-pro",
};

const q = (s) => '"' + String(s).replace(/"/g, '\\"') + '"';

// Core invocation. Returns { response, sessionId, stats }.
export function runCli(prompt, opts = {}) {
  const {
    model = null,
    directories = [],
    approval = "plan", // read-only by default
    timeoutMs = 180000,
  } = opts;
  if (!prompt || !String(prompt).trim())
    return Promise.reject(new Error("prompt is empty."));

  const args = ["-o", "json"];
  if (approval) args.push("--approval-mode", approval);
  if (model) args.push("-m", q(CLI_MODEL_MAP[String(model).toLowerCase()] || model));
  for (const d of directories) if (d) args.push("--include-directories", q(d));

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(GEMINI_CMD, args, { shell: true });
    } catch (e) {
      reject(new Error("Failed to start Gemini CLI: " + e.message));
      return;
    }
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      reject(
        new Error(
          "Gemini CLI timed out after " + Math.round(timeoutMs / 1000) + "s."
        )
      );
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(
        new Error(
          "Could not run the Gemini CLI (" +
            e.message +
            "). Install it with: npm i -g @google/gemini-cli, then `gemini` once to log in."
        )
      );
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const s = out.indexOf("{");
      if (s >= 0) {
        try {
          const j = JSON.parse(out.slice(s));
          resolve({
            response: (j.response || "").trim(),
            sessionId: j.session_id,
            stats: j.stats,
          });
          return;
        } catch {}
      }
      if (code === 0 && out.trim()) {
        resolve({ response: out.trim() });
        return;
      }
      reject(
        new Error("Gemini CLI failed (exit " + code + "): " + (err || out).slice(0, 400))
      );
    });
    child.stdin.write(String(prompt));
    child.stdin.end();
  });
}

// Append @file references so the CLI reads them (multimodal: images/PDFs too).
function withFiles(prompt, files = []) {
  if (!files || !files.length) return prompt;
  const refs = files.map((f) => "@" + f).join("\n");
  return prompt + "\n\nUse these attached files as context:\n" + refs;
}

const text = (r) => r.response;

// --- High-level CLI tools ---------------------------------------------------

export async function cliAsk({
  prompt,
  files = [],
  directory = null,
  model = null,
  timeout_seconds = 180,
}) {
  const r = await runCli(withFiles(prompt, files), {
    model,
    directories: directory ? [directory] : [],
    timeoutMs: timeout_seconds * 1000,
  });
  return text(r);
}

export async function search({ query, timeout_seconds = 120 }) {
  const r = await runCli(
    "Use web search to answer the following accurately and concisely, and list the source URLs you used at the end.\n\nQuestion: " +
      query,
    { timeoutMs: timeout_seconds * 1000 }
  );
  return text(r);
}

export async function deepResearch({ topic, timeout_seconds = 600 }) {
  const r = await runCli(
    "Do thorough, multi-step web research on the topic below. Search multiple sources, cross-check facts, and produce a structured report with: a short summary, key findings (bulleted), and a list of source URLs.\n\nTopic: " +
      topic,
    { timeoutMs: timeout_seconds * 1000 }
  );
  return text(r);
}

export async function brainstorm({ topic, count = 8, timeout_seconds = 180 }) {
  const r = await runCli(
    "Brainstorm " +
      count +
      " diverse, concrete, non-obvious ideas for the following. For each: a one-line title and a one-sentence rationale.\n\nTopic: " +
      topic,
    { timeoutMs: timeout_seconds * 1000 }
  );
  return text(r);
}

export async function analyzeCode({
  directory,
  focus = "bugs, security, performance and code quality",
  question = null,
  timeout_seconds = 300,
}) {
  if (!directory) throw new Error("directory is required.");
  const prompt = question
    ? question
    : "Review the code in the included directory. Focus on: " +
      focus +
      ". Give concrete, actionable findings with file references, ordered by severity.";
  const r = await runCli(prompt, {
    directories: [directory],
    timeoutMs: timeout_seconds * 1000,
  });
  return text(r);
}

export async function analyzeFiles({
  files,
  question = "Analyze these files and summarize their content.",
  timeout_seconds = 240,
}) {
  if (!files || !files.length) throw new Error("files is required.");
  const r = await runCli(withFiles(question, files), {
    timeoutMs: timeout_seconds * 1000,
  });
  return text(r);
}

export async function analyzeUrl({
  url,
  question = "Summarize the key points of this page.",
  timeout_seconds = 180,
}) {
  const r = await runCli(
    "Fetch and read this URL, then answer.\nURL: " + url + "\n\nTask: " + question,
    { timeoutMs: timeout_seconds * 1000 }
  );
  return text(r);
}

export async function compareUrls({
  urls,
  question = "Compare these pages: similarities, differences, and which is better and why.",
  timeout_seconds = 240,
}) {
  if (!urls || urls.length < 2) throw new Error("Provide at least two urls.");
  const r = await runCli(
    "Fetch and read each of these URLs, then answer.\nURLs:\n" +
      urls.join("\n") +
      "\n\nTask: " +
      question,
    { timeoutMs: timeout_seconds * 1000 }
  );
  return text(r);
}

export async function youtube({
  url,
  question = "Summarize this video with key points and approximate timestamps.",
  timeout_seconds = 300,
}) {
  const r = await runCli(
    "Analyze this YouTube video and answer.\nVideo: " + url + "\n\nTask: " + question,
    { timeoutMs: timeout_seconds * 1000 }
  );
  return text(r);
}

export async function structured({ prompt, schema, timeout_seconds = 180 }) {
  const schemaStr =
    typeof schema === "string" ? schema : JSON.stringify(schema, null, 2);
  const r = await runCli(
    "Respond with ONLY valid JSON, no markdown fences and no prose, matching this schema:\n" +
      schemaStr +
      "\n\nTask / data:\n" +
      prompt,
    { timeoutMs: timeout_seconds * 1000 }
  );
  let raw = r.response.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();
  try {
    return JSON.parse(raw);
  } catch {
    const s = raw.indexOf("{");
    const e = raw.lastIndexOf("}");
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(raw.slice(s, e + 1));
      } catch {}
    }
    return { _parse_error: true, raw: r.response };
  }
}

export async function extract({ text: content, fields, timeout_seconds = 120 }) {
  const fieldList = Array.isArray(fields) ? fields.join(", ") : fields;
  return structured({
    prompt:
      "Extract these fields: " +
      fieldList +
      ".\n\nFrom the following content:\n" +
      content,
    schema:
      "{ " +
      (Array.isArray(fields) ? fields : String(fields).split(","))
        .map((f) => JSON.stringify(String(f).trim()) + ": <value or null>")
        .join(", ") +
      " }",
    timeout_seconds,
  });
}

export async function summarize({
  content,
  length = "medium",
  timeout_seconds = 180,
}) {
  const r = await runCli(
    "Summarize the following at '" +
      length +
      "' length (short = 2-3 sentences, medium = a paragraph, long = detailed with bullet points).\n\nContent:\n" +
      content,
    { timeoutMs: timeout_seconds * 1000 }
  );
  return text(r);
}

// Rough, free token estimate (~4 chars per token). No API call.
export function countTokens({ text: content }) {
  const chars = (content || "").length;
  return {
    characters: chars,
    estimated_tokens: Math.ceil(chars / 4),
    note: "Rough estimate (~4 chars/token); not an exact tokenizer count.",
  };
}
