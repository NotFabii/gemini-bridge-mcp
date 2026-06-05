# gemini-bridge-mcp

A **comprehensive MCP server for Google Gemini that needs NO API key.** It combines two
free backends so any MCP client (Claude Code, Claude Desktop, …) gets the full Gemini
toolbox:

- 🧠 **Gemini CLI backend** — Q&A, web search, deep research, code/file/URL analysis,
  structured output, extraction, summarization. Official, robust (no DOM scraping),
  free with your Google login. The model can autonomously use **read-only** tools
  (search, read files/URLs) — it never edits your files (`--approval-mode plan`).
- 🎨 **Web-UI backend** — **image** (Nano Banana) and **video** (Veo) generation, which
  the free CLI can't do. Driven via Playwright against `gemini.google.com`.

> Inspired by [rlabs-inc/gemini-mcp](https://github.com/rlabs-inc/gemini-mcp) (feature
> breadth) and [eLyiN/gemini-bridge](https://github.com/eLyiN/gemini-bridge) (CLI bridge) —
> but **API-key-free**: it uses the Gemini CLI + the web UI instead of the paid API.

## Tools

| Tool | Group | Backend | What it does |
|---|---|---|---|
| `ask_gemini` | core | CLI→web | Ask anything. Attach `files` and/or a `directory` of code. Multimodal. |
| `gemini_brainstorm` | core | CLI | Brainstorm N concrete ideas for a topic. |
| `gemini_search` | research | CLI | Web search → grounded answer **with source URLs**. |
| `gemini_deep_research` | research | CLI | Autonomous multi-step research → structured report + sources. |
| `gemini_youtube` | research | CLI | Summarize / analyze a YouTube video. |
| `gemini_analyze_code` | analysis | CLI | Review a codebase **folder** (bugs/security/perf/quality). |
| `gemini_analyze_files` | analysis | CLI | Analyze images / PDFs / docs / text (multimodal). |
| `gemini_analyze_url` | analysis | CLI | Fetch & analyze a web page. |
| `gemini_compare_urls` | analysis | CLI | Fetch & compare multiple pages. |
| `gemini_structured` | data | CLI | JSON output matching a schema you give (returns parsed JSON). |
| `gemini_extract` | data | CLI | Extract named fields from text as JSON. |
| `gemini_summarize` | data | CLI | Summarize text (short/medium/long). |
| `gemini_count_tokens` | data | local | Rough, free token estimate (no API call). |
| `generate_image` | media | Web UI | Generate image(s) with **Nano Banana**. Saves PNG(s). |
| `generate_video` | media | Web UI | Generate a video with **Veo**. Saves an MP4. |

## Requirements

- **Node.js 18+**
- **[Gemini CLI](https://github.com/google-gemini/gemini-cli)** for the CLI-backed tools
  (everything except image/video): `npm i -g @google/gemini-cli`, then run `gemini` once
  to log in with your Google account.
- For **image/video** only: a **Chromium browser** (Chrome / Brave / Edge) + a one-time
  web login (`npm run login`).

## Setup

```bash
npm install                       # server deps (no browser download)

# CLI backend (for ask, search, research, analysis, ...):
npm i -g @google/gemini-cli
gemini                            # run once, sign in with Google, then exit

# Web backend (only needed for generate_image / generate_video):
npm run login                     # opens a window; sign in to Gemini once
```

## Use as an MCP server

```json
{
  "mcpServers": {
    "gemini-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/gemini-bridge-mcp/server.js"],
      "env": { "GEMINI_HEADLESS": "1" }
    }
  }
}
```

Or with the Claude Code CLI:

```bash
claude mcp add gemini-bridge --env GEMINI_HEADLESS=1 -- node /absolute/path/to/server.js
```

## Presets (control how many tools are exposed)

15 tools can be a lot of context. Trim them via env vars:

```bash
GEMINI_PRESET=minimal     # ask_gemini, gemini_search, generate_image
GEMINI_PRESET=core        # core + media
GEMINI_PRESET=research    # ask + research + URL tools
GEMINI_PRESET=analysis    # ask + analysis + data
GEMINI_PRESET=media       # ask + image/video
GEMINI_PRESET=data        # ask + data tools
GEMINI_PRESET=full        # everything (default)

# Or pick exactly what you want (tool names and/or group names):
GEMINI_TOOLS=ask_gemini,gemini_search,generate_image
```

## Environment variables

| Variable | Effect |
|---|---|
| `GEMINI_BACKEND` | `auto` (default: CLI if available, else web), `cli`, or `web` — for `ask_gemini`. |
| `GEMINI_PRESET` / `GEMINI_TOOLS` | Which tools to expose (see above). |
| `GEMINI_HEADLESS=1` | Run the web UI invisibly (recommended). |
| `GEMINI_BROWSER_PATH` | Path to chrome/brave/edge if auto-detect misses. |
| `GEMINI_PROFILE_DIR` | Web login profile folder (default `./.gemini-profile`). |
| `GEMINI_OUTPUT_DIR` | Where generated media is saved (default `./output`). |
| `GEMINI_PORT` | HTTP mode port (default `7801`). |
| `GEMINI_TLS_CERT` / `GEMINI_TLS_KEY` | Serve HTTP mode over https (else `./certs/cert.pem`+`key.pem`). |

## CLI (testing)

```bash
node server.js tools                    # list enabled tools
node server.js ask "your question"
node server.js search "latest Node LTS?"
node server.js image "a red sports car at sunset"
node server.js video "a balloon over mountains"
node server.js login | check | dump     # web-UI login / diagnostics
node server.js http                      # run over Streamable HTTP
```

## Relation to rlabs-inc/gemini-mcp

This server covers the major capability groups of `rlabs-inc/gemini-mcp` **without an API
key** (CLI + web UI instead). A few of its tools are intentionally **not** included because
they require the paid API or aren't feasible via the free CLI:

- **Text-to-speech** (`speak`, `dialogue`, voices) — API-only.
- **Context caching** (`create/query/list/delete cache`) — API-only (the CLI manages its
  own context window).
- **Image-edit sessions** & **async video polling** — our image/video generation is
  synchronous (the tool waits and returns the file).
- **Python code-execution sandbox** — for safety this isn't exposed as a tool; ask
  `ask_gemini` with a coding prompt instead.

Everything else (search, deep research, code/text/document/image analysis, URL & YouTube
analysis, structured output, extraction, summarization, image & video generation) is here.

## ⚠️ Locale note

Some **web-UI** selectors match the **German** Gemini UI (e.g. `Bild erstellen`,
`Video erstellen`). If your Gemini UI is in another language, edit `SEL` in
[`lib/web.js`](lib/web.js) (and the `Jetzt ausprobieren` regex) — English would be
`Create image`, `Create video`, etc. `node server.js dump` prints current labels. The
**CLI** tools are locale-independent.

## ⚠️ Disclaimer

The **web-UI** part automates Gemini's web interface of **your own** account; it uses **no
official API**. Automating Google's web UI may violate Google's Terms of Service — **use at
your own risk, for personal use only**. The CLI part uses Google's official `gemini` CLI.
Provided **"as is"**, without warranty. Not affiliated with Google or Anthropic. "Gemini",
"Nano Banana", "Veo" are products/trademarks of Google.

## Acknowledgements

- Designed and coded with the help of **[Claude Code](https://claude.com/claude-code)**
  (Anthropic's **Claude Opus 4.8**, with extended thinking).
- Feature inspiration: **[rlabs-inc/gemini-mcp](https://github.com/rlabs-inc/gemini-mcp)**
  and **[eLyiN/gemini-bridge](https://github.com/eLyiN/gemini-bridge)**.

## License

[MIT](LICENSE)
