// ---------------------------------------------------------------------------
// Web backend: drives the logged-in Gemini web UI via Playwright.
// Used for the things the free Gemini CLI cannot do: image (Nano Banana) and
// video (Veo) generation, plus an optional web fallback for plain questions.
//
// NOTE: some selectors match the GERMAN Gemini UI. Adapt them in SEL / the
// "Jetzt ausprobieren" regex for other locales. `node server.js dump` helps.
// ---------------------------------------------------------------------------
import { chromium } from "playwright-core";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(__dirname, "..");

function resolveBrowser() {
  const home = os.homedir();
  const PF = process.env["ProgramFiles"] || "C:\\Program Files";
  const PF86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const LAD = process.env["LOCALAPPDATA"] || path.join(home, "AppData", "Local");
  const candidates = [
    process.env.GEMINI_BROWSER_PATH,
    path.join(PF, "Google\\Chrome\\Application\\chrome.exe"),
    path.join(PF86, "Google\\Chrome\\Application\\chrome.exe"),
    path.join(LAD, "Google\\Chrome\\Application\\chrome.exe"),
    path.join(LAD, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
    path.join(PF, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
    path.join(PF, "Microsoft\\Edge\\Application\\msedge.exe"),
    path.join(PF86, "Microsoft\\Edge\\Application\\msedge.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/brave-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(
    "No Chromium browser (Chrome/Brave/Edge) found. Set GEMINI_BROWSER_PATH."
  );
}

const BROWSER_PATH = (() => {
  try {
    return resolveBrowser();
  } catch {
    return null;
  }
})();

const GEMINI_URL = "https://gemini.google.com/app";
const USER_DATA_DIR =
  process.env.GEMINI_PROFILE_DIR || path.join(PKG_ROOT, ".gemini-profile");
const HEADLESS = process.env.GEMINI_HEADLESS === "1";
export const OUTPUT_DIR =
  process.env.GEMINI_OUTPUT_DIR || path.join(PKG_ROOT, "output");

const SEL = {
  editor: 'div.ql-editor[contenteditable="true"]',
  response: "model-response",
  responseText: ".markdown",
  uploadTriggerName: "Uploads & Tools",
  uploadMenuItemText: "Dateien hochladen", // [German UI]
  modelTriggerName: /Modusauswahl öffnen/i, // [German UI]
  imageModeName: /Bild erstellen/i, // [German UI]
  videoModeName: /Video erstellen/i, // [German UI]
};

const MODEL_MAP = {
  "flash-lite": /3\.1 Flash-Lite/i,
  flash: /3\.5 Flash/i,
  pro: /3\.1 Pro/i,
};

let ctx = null;
let page = null;

async function launch({ headless = HEADLESS } = {}) {
  if (!BROWSER_PATH)
    throw new Error("No browser found. Set GEMINI_BROWSER_PATH.");
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless,
    executablePath: BROWSER_PATH,
    viewport: { width: 1280, height: 900 },
    bypassCSP: true,
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  const pg = context.pages()[0] || (await context.newPage());
  return { context, pg };
}

async function ensurePage() {
  if (page && !page.isClosed()) return page;
  const launched = await launch();
  ctx = launched.context;
  page = launched.pg;
  if (!/gemini\.google\.com/.test(page.url()))
    await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
  return page;
}

const LOGIN_PREDICATE = () => {
  const hasEditor = !!document.querySelector('div.ql-editor[contenteditable="true"]');
  const hasSignIn = [...document.querySelectorAll("a,button")].some((e) =>
    /^\s*(anmelden|sign in)\s*$/i.test((e.textContent || "").trim())
  );
  return hasEditor && !hasSignIn;
};

async function isLoggedIn(p) {
  try {
    await p.waitForSelector(SEL.editor, { timeout: 8000 });
    await p.waitForTimeout(500);
    return await p.evaluate(LOGIN_PREDICATE);
  } catch {
    return false;
  }
}

async function uploadFiles(p, files) {
  for (const f of files)
    if (!fs.existsSync(f)) throw new Error(`File not found: ${f}`);
  const trigger = p.getByRole("button", { name: SEL.uploadTriggerName }).first();
  await trigger.waitFor({ state: "visible", timeout: 30000 });
  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await trigger.click({ timeout: 8000 });
  } catch {
    await trigger.evaluate((el) => el.click());
  }
  const menuItem = p
    .getByRole("menuitem", { name: SEL.uploadMenuItemText })
    .first();
  await menuItem.waitFor({ state: "visible", timeout: 8000 });
  const [chooser] = await Promise.all([
    p.waitForEvent("filechooser", { timeout: 10000 }),
    menuItem.click(),
  ]);
  await chooser.setFiles(files);
  await p.waitForTimeout(1500);
  await p
    .waitForFunction(() => !document.querySelector('[role="progressbar"]'), {
      timeout: 60000,
    })
    .catch(() => {});
}

async function selectModel(p, model) {
  if (!model) return;
  const target = MODEL_MAP[String(model).toLowerCase().trim()];
  if (!target) return;
  const trigger = p.getByRole("button", { name: SEL.modelTriggerName }).first();
  await trigger.waitFor({ state: "visible", timeout: 15000 });
  await trigger.click();
  const item = p.getByRole("menuitem", { name: target }).first();
  await item.waitFor({ state: "visible", timeout: 8000 });
  await item.click();
  await p.waitForTimeout(500);
}

async function enableMode(p, modeName) {
  const trigger = p.getByRole("button", { name: SEL.uploadTriggerName }).first();
  await trigger.waitFor({ state: "visible", timeout: 30000 });
  try {
    await trigger.click({ timeout: 8000 });
  } catch {
    await trigger.evaluate((el) => el.click());
  }
  const item = p.getByRole("menuitemcheckbox", { name: modeName }).first();
  await item.waitFor({ state: "visible", timeout: 8000 });
  await item.click();
  await p.waitForTimeout(800);
}

async function sendPrompt(p, prompt) {
  const editor = p.locator(SEL.editor).first();
  await editor.click();
  await p.keyboard.insertText(prompt);
  await p.keyboard.press("Enter");
}

async function waitForStableText(p, before, deadline) {
  while (Date.now() < deadline) {
    if ((await p.locator(SEL.response).count()) > before) break;
    await p.waitForTimeout(300);
  }
  let lastText = "";
  let stable = 0;
  while (Date.now() < deadline) {
    const txt = await p
      .locator(SEL.response)
      .last()
      .locator(SEL.responseText)
      .first()
      .innerText()
      .catch(() => "");
    if (txt && txt === lastText) {
      if (++stable >= 5) break;
    } else {
      stable = 0;
      lastText = txt;
    }
    await p.waitForTimeout(500);
  }
  return lastText.trim();
}

async function extractMedia(p, kind, deadline) {
  const minDim = 200;
  while (Date.now() < deadline) {
    const ready = await p
      .evaluate(
        ({ kind, minDim }) => {
          const resp = document.querySelectorAll("model-response");
          const last = resp[resp.length - 1];
          if (!last) return false;
          if (kind === "video") {
            const v = last.querySelector("video");
            return !!(v && (v.src || v.currentSrc));
          }
          return (
            [...last.querySelectorAll("img")].filter(
              (im) => im.naturalWidth >= minDim && im.naturalHeight >= minDim
            ).length > 0
          );
        },
        { kind, minDim }
      )
      .catch(() => false);
    if (ready) break;
    await p.waitForTimeout(1500);
  }

  let media = [];
  if (kind === "video") {
    const urls = await p.evaluate(() => {
      const resp = document.querySelectorAll("model-response");
      const last = resp[resp.length - 1];
      if (!last) return [];
      return [...last.querySelectorAll("video")]
        .map((v) => v.currentSrc || v.src)
        .filter(Boolean);
    });
    const apiCtx = p.context().request;
    for (const url of urls) {
      try {
        if (url.startsWith("blob:")) {
          const b64 = await p.evaluate(async (u) => {
            const r = await fetch(u);
            const b = await r.blob();
            const d = await new Promise((res, rej) => {
              const fr = new FileReader();
              fr.onload = () => res(fr.result);
              fr.onerror = () => rej(fr.error || new Error("FileReader"));
              fr.readAsDataURL(b);
            });
            return String(d).split(",")[1];
          }, url);
          media.push({ b64, type: "video/mp4" });
        } else {
          const r = await apiCtx.get(url);
          media.push({
            buffer: await r.body(),
            type: r.headers()["content-type"] || "video/mp4",
          });
        }
      } catch (e) {
        media.push({ error: String(e), src: url.slice(0, 100) });
      }
    }
  } else {
    media = await p.evaluate(
      ({ minDim }) => {
        const resp = document.querySelectorAll("model-response");
        const last = resp[resp.length - 1];
        const out = [];
        if (!last) return out;
        const imgs = [...last.querySelectorAll("img")].filter(
          (im) => im.naturalWidth >= minDim && im.naturalHeight >= minDim
        );
        for (const im of imgs) {
          try {
            const c = document.createElement("canvas");
            c.width = im.naturalWidth;
            c.height = im.naturalHeight;
            c.getContext("2d").drawImage(im, 0, 0);
            out.push({
              b64: c.toDataURL("image/png").split(",")[1],
              type: "image/png",
            });
          } catch (e) {
            out.push({ error: String(e) });
          }
        }
        return out;
      },
      { minDim }
    );
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const saved = [];
  const stamp = Date.now();
  let i = 0;
  for (const m of media) {
    if (!m || (!m.b64 && !m.buffer)) continue;
    const ext =
      kind === "video"
        ? (m.type || "").includes("webm")
          ? "webm"
          : "mp4"
        : (m.type || "").includes("webp")
          ? "webp"
          : "png";
    const file = path.join(OUTPUT_DIR, `gemini-${kind}-${stamp}-${i++}.${ext}`);
    fs.writeFileSync(file, m.buffer ? m.buffer : Buffer.from(m.b64, "base64"));
    saved.push(file);
  }
  return saved;
}

// --- Public API -------------------------------------------------------------

export async function webAsk({
  prompt,
  files = [],
  new_chat = false,
  model = null,
  timeout_seconds = 180,
}) {
  if (!prompt || !prompt.trim()) throw new Error("prompt is empty.");
  const p = await ensurePage();
  if (new_chat) await p.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
  if (!(await isLoggedIn(p)))
    throw new Error("Not logged in to Gemini. Run `npm run login`.");
  if (model) await selectModel(p, model);
  const editor = p.locator(SEL.editor).first();
  await editor.click();
  if (files.length) await uploadFiles(p, files);
  const before = await p.locator(SEL.response).count();
  await sendPrompt(p, prompt);
  const text = await waitForStableText(
    p,
    before,
    Date.now() + timeout_seconds * 1000
  );
  if (!text)
    throw new Error("No answer from Gemini (timeout or UI change).");
  return text;
}

export async function generateImage({ prompt, timeout_seconds = 180 }) {
  if (!prompt || !prompt.trim()) throw new Error("prompt is empty.");
  const p = await ensurePage();
  await p.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
  if (!(await isLoggedIn(p)))
    throw new Error("Not logged in to Gemini. Run `npm run login`.");
  await enableMode(p, SEL.imageModeName);
  const before = await p.locator(SEL.response).count();
  await sendPrompt(p, prompt);
  const deadline = Date.now() + timeout_seconds * 1000;
  while (Date.now() < deadline) {
    if ((await p.locator(SEL.response).count()) > before) break;
    await p.waitForTimeout(500);
  }
  const files = await extractMedia(p, "image", deadline);
  if (!files.length) throw new Error("No image found (timeout or UI change).");
  return files;
}

export async function generateVideo({ prompt, timeout_seconds = 420 }) {
  if (!prompt || !prompt.trim()) throw new Error("prompt is empty.");
  const p = await ensurePage();
  await p.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
  if (!(await isLoggedIn(p)))
    throw new Error("Not logged in to Gemini. Run `npm run login`.");
  await enableMode(p, SEL.videoModeName);
  const tryBtn = p.getByRole("button", { name: /Jetzt ausprobieren/i }).first();
  if (await tryBtn.isVisible().catch(() => false)) {
    await tryBtn.click().catch(() => {});
    await p.waitForTimeout(1000);
  }
  const before = await p.locator(SEL.response).count();
  await sendPrompt(p, prompt);
  const deadline = Date.now() + timeout_seconds * 1000;
  while (Date.now() < deadline) {
    if ((await p.locator(SEL.response).count()) > before) break;
    await p.waitForTimeout(1000);
  }
  const files = await extractMedia(p, "video", deadline);
  if (!files.length) throw new Error("No video found (timeout or UI change).");
  return files;
}

export async function closeBrowser() {
  try {
    if (ctx) await ctx.close();
  } catch {}
}

export async function runLogin() {
  process.stderr.write("\n>> Browser: " + BROWSER_PATH + "\n");
  const { context, pg } = await launch({ headless: false });
  await pg.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
  process.stderr.write(
    ">> Please sign in to Google/Gemini in the window that opened.\n" +
      ">> Waiting for the input field (up to 5 min)...\n"
  );
  try {
    await pg.waitForFunction(LOGIN_PREDICATE, null, {
      timeout: 300000,
      polling: 1000,
    });
    process.stderr.write(
      ">> Login detected. Profile saved at:\n   " + USER_DATA_DIR + "\n"
    );
    await pg.waitForTimeout(3000);
  } catch {
    process.stderr.write(">> No login detected within 5 min. Aborting.\n");
  }
  await context.close();
}

export async function runCheck() {
  const { context, pg } = await launch({ headless: true });
  await pg.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(3000);
  const info = await pg.evaluate(() => {
    const signIn = [...document.querySelectorAll("a,button")].some((e) =>
      /anmelden|sign in/i.test(e.textContent || "")
    );
    return {
      url: location.href,
      hasEditor: !!document.querySelector('div.ql-editor[contenteditable="true"]'),
      hasSignInButton: signIn,
    };
  });
  process.stdout.write(JSON.stringify(info, null, 2) + "\n");
  await context.close();
}

export async function runDump() {
  const { context, pg } = await launch({ headless: true });
  await pg.goto(GEMINI_URL, { waitUntil: "domcontentloaded" });
  await pg.waitForSelector(SEL.editor, { timeout: 15000 });
  await pg.waitForTimeout(1500);
  const data = await pg.evaluate(() =>
    [...document.querySelectorAll("button")]
      .map((b) => b.getAttribute("aria-label"))
      .filter(Boolean)
      .slice(0, 50)
  );
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  await context.close();
}
