#!/usr/bin/env node
/**
 * gemini-bridge-mcp
 * -----------------
 * A comprehensive MCP server for Google Gemini that needs NO API key.
 *
 * Two free backends:
 *   - Gemini CLI  -> Q&A, web search, deep research, code/file/URL analysis,
 *                    structured output, extract, summarize, ... (robust, official)
 *   - Web UI      -> image (Nano Banana) and video (Veo) generation, which the
 *                    free CLI cannot do (Playwright automation of gemini.google.com)
 *
 * Modes:
 *   node server.js                 -> MCP server over stdio
 *   node server.js http            -> MCP server over Streamable HTTP
 *   node server.js login           -> one-time web-UI login (for image/video)
 *   node server.js tools           -> list the currently enabled tools
 *   node server.js ask "..."       -> quick CLI test of ask_gemini
 *   node server.js search "..."    -> quick test of gemini_search
 *   node server.js image "..."     -> quick test of generate_image (web)
 *   node server.js video "..."     -> quick test of generate_video (web)
 *   node server.js check | dump    -> web-UI diagnostics
 *
 * Built with the help of Claude Code (Anthropic's Claude Opus 4.8, extended thinking).
 * Inspired by rlabs-inc/gemini-mcp (feature breadth) and eLyiN/gemini-bridge (CLI bridge).
 */

import { TOOLS, selectTools } from "./lib/tools.js";
import {
  runLogin,
  runCheck,
  runDump,
  closeBrowser,
} from "./lib/web.js";

// ---------------------------------------------------------------------------
// MCP server built from the selected (preset-filtered) tool registry.
// ---------------------------------------------------------------------------
async function buildServer() {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import(
    "@modelcontextprotocol/sdk/types.js"
  );
  const tools = selectTools();
  const server = new Server(
    { name: "gemini-bridge", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const t = tools.find((x) => x.name === req.params.name);
    if (!t)
      return {
        isError: true,
        content: [{ type: "text", text: "Unknown tool: " + req.params.name }],
      };
    try {
      const out = await t.handler(req.params.arguments || {});
      return {
        content: [
          { type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) },
        ],
      };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: " + (e?.message || String(e)) }],
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// stdio mode.
// ---------------------------------------------------------------------------
async function runMcp() {
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const server = await buildServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    "gemini-bridge MCP running (stdio) with " + selectTools().length + " tools.\n"
  );
}

// ---------------------------------------------------------------------------
// Streamable HTTP mode (for MCP clients that connect to a URL).
// Serves https automatically if ./certs/cert.pem + key.pem exist.
// ---------------------------------------------------------------------------
async function runHttp() {
  const http = await import("node:http");
  const https = await import("node:https");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { randomUUID } = await import("node:crypto");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const { isInitializeRequest } = await import(
    "@modelcontextprotocol/sdk/types.js"
  );
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const PORT = Number(process.env.GEMINI_PORT || 7801);
  const transports = {};

  const readBody = (req) =>
    new Promise((resolve) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });

  const handler = async (req, res) => {
    const origin = req.headers.origin || "*";
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, Authorization"
    );
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, Mcp-Protocol-Version");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end("Not found");
      return;
    }
    try {
      const sessionId = req.headers["mcp-session-id"];
      if (req.method === "POST") {
        const body = await readBody(req);
        let transport;
        if (sessionId && transports[sessionId]) {
          transport = transports[sessionId];
        } else if (!sessionId && isInitializeRequest(body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              transports[sid] = transport;
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) delete transports[transport.sessionId];
          };
          const server = await buildServer();
          await server.connect(transport);
        } else {
          res.writeHead(400, { "Content-Type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "No valid session." },
              id: null,
            })
          );
          return;
        }
        await transport.handleRequest(req, res, body);
      } else if (req.method === "GET" || req.method === "DELETE") {
        if (!sessionId || !transports[sessionId]) {
          res.writeHead(400).end("Invalid or missing session id.");
          return;
        }
        await transports[sessionId].handleRequest(req, res);
      } else {
        res.writeHead(405).end("Method not allowed");
      }
    } catch (err) {
      process.stderr.write("HTTP error: " + (err?.message || err) + "\n");
      if (!res.headersSent) res.writeHead(500).end("Server error");
    }
  };

  const certPath =
    process.env.GEMINI_TLS_CERT || path.join(__dirname, "certs", "cert.pem");
  const keyPath =
    process.env.GEMINI_TLS_KEY || path.join(__dirname, "certs", "key.pem");
  const useTls = fs.existsSync(certPath) && fs.existsSync(keyPath);
  const server = useTls
    ? https.createServer(
        { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) },
        handler
      )
    : http.createServer(handler);
  server.listen(PORT, "127.0.0.1", () => {
    const scheme = useTls ? "https" : "http";
    process.stderr.write(
      "gemini-bridge " +
        scheme.toUpperCase() +
        "-MCP running at " +
        scheme +
        "://localhost:" +
        PORT +
        "/mcp\n"
    );
  });
}

// ---------------------------------------------------------------------------
// Quick CLI test helper: run one tool by name and print the result.
// ---------------------------------------------------------------------------
async function runTool(name, args) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error("Unknown tool: " + name);
  const out = await t.handler(args);
  process.stdout.write(
    "\n--- " + name + " ---\n" +
      (typeof out === "string" ? out : JSON.stringify(out, null, 2)) +
      "\n"
  );
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------
const mode = process.argv[2];
const rest = process.argv.slice(3).join(" ");

(async () => {
  try {
    switch (mode) {
      case "login":
        await runLogin();
        break;
      case "check":
        await runCheck();
        break;
      case "dump":
        await runDump();
        break;
      case "tools":
        process.stdout.write(
          "Enabled tools (" +
            selectTools().length +
            "):\n" +
            selectTools().map((t) => "  - " + t.name + "  [" + t.group + "]").join("\n") +
            "\n"
        );
        break;
      case "ask":
        await runTool("ask_gemini", { prompt: rest });
        break;
      case "search":
        await runTool("gemini_search", { query: rest });
        break;
      case "image":
        await runTool("generate_image", { prompt: rest });
        break;
      case "video":
        await runTool("generate_video", { prompt: rest });
        break;
      case "http":
        await runHttp();
        return; // keep process alive
      default:
        await runMcp();
        return; // keep process alive
    }
    await closeBrowser();
    process.exit(0);
  } catch (e) {
    process.stderr.write("Error: " + (e?.message || String(e)) + "\n");
    await closeBrowser().catch(() => {});
    process.exit(1);
  }
})();

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await closeBrowser().catch(() => {});
    process.exit(0);
  });
}
