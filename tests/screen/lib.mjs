// Shared bits of the screen-test kit (#2 press_button, #3 layout, #7
// directions card): booting the worker and the site the way tests/voice/run.mjs
// does, and opening the full kiosk page WITHOUT ever touching production.
//
// The 3DVista tour loads Mia's frame from the absolute production URL, so any
// test that opens `/` MUST go through kioskPage() below: it blocks every
// request to officemal.mobileappslabs.ca and rewrites the AIWEB frame URL (in
// the tour's locale file) to this run's local site.
import { spawn, spawnSync, execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { OUT as VOICE_OUT, REPO, envPath, options as voiceOptions, readEnv, sleep } from "../voice/lib.mjs";
import { writeSandboxTeam } from "../voice/sandbox-team.mjs";

export { REPO, envPath, readEnv, sleep };
export const KIT = path.dirname(fileURLToPath(import.meta.url));
export const OUT = path.join(KIT, "out"); // git-ignored: screenshots, reports

export const PROD_SITE = "https://officemal.mobileappslabs.ca";

export function options(argv) {
  const opts = voiceOptions(argv); // --id u --port 3123 → mia-u, simli-worker:u
  opts.site = `http://localhost:${opts.port}`;
  return opts;
}

// --- worker and site (same shape as tests/voice/run.mjs) --------------------
const docker = (...args) => execFileSync("docker", args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
const started = { worker: false, site: null };

function containerRunning(name) {
  try { return docker("inspect", "-f", "{{.State.Running}}", name).trim() === "true"; } catch { return false; }
}

export function dockerLogs(container, ...args) {
  const r = spawnSync("docker", ["logs", ...args, container], { maxBuffer: 64 << 20 });
  return `${r.stdout}${r.stderr}`;
}

// The worker, with the sandbox team mounted over /app/team.json: every email a
// test provokes goes to delivered@resend.dev, never to real staff.
export async function ensureWorker(opts) {
  fs.mkdirSync(VOICE_OUT, { recursive: true });
  const team = writeSandboxTeam();
  if (containerRunning(opts.container) && !opts.flags.has("restart")) {
    console.log(`worker: using running ${opts.container}`);
    return;
  }
  let haveImage = true;
  try { docker("image", "inspect", opts.image); } catch { haveImage = false; }
  if (!haveImage || opts.flags.has("build")) {
    console.log(`worker: building ${opts.image} from agent-worker/ ...`);
    execFileSync("docker", ["build", "-t", opts.image, path.join(REPO, "agent-worker")], { stdio: "inherit" });
  }
  try { docker("rm", "-f", opts.container); } catch {}
  docker("run", "-d", "--name", opts.container, "--env-file", envPath(), "-e", `LIVEKIT_AGENT_NAME=${opts.agent}`,
    "-v", `${team}:/app/team.json:ro`, opts.image);
  started.worker = true;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (/registered worker/i.test(dockerLogs(opts.container))) {
      console.log(`worker: ${opts.container} registered as ${opts.agent}`);
      return;
    }
  }
  throw new Error(`worker ${opts.container} did not register:\n${dockerLogs(opts.container, "--tail", "30")}`);
}

async function siteUp(url) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(60000) })).ok; } catch { return false; }
}

export async function ensureSite(opts) {
  const probe = `${opts.site}/receptionist-embed`;
  if (await siteUp(probe)) {
    console.log(`site: using running server on ${opts.port} (it must dispatch to ${opts.agent})`);
    return;
  }
  const ENV = readEnv();
  const nextBin = path.join(REPO, "node_modules", "next", "dist", "bin", "next");
  if (!fs.existsSync(nextBin)) throw new Error("no node_modules: run `npm ci` first");
  const env = {
    ...process.env,
    LIVEKIT_URL: ENV.LIVEKIT_URL, LIVEKIT_API_KEY: ENV.LIVEKIT_API_KEY, LIVEKIT_API_SECRET: ENV.LIVEKIT_API_SECRET,
    LIVEKIT_AGENT_NAME: opts.agent, NEXT_PUBLIC_AVATAR_PROVIDER: "simli-livekit",
    // A test opens MeetingModal, whose /api/notify-meeting emails ADMIN_EMAIL
    // through Resend: make sure the dev server can never send a real email,
    // whatever is in this machine's environment.
    RESEND_API_KEY: "", ADMIN_EMAIL: "",
  };
  fs.mkdirSync(OUT, { recursive: true });
  const log = fs.openSync(path.join(OUT, "site.log"), "w");
  const keep = opts.flags.has("keep");
  started.site = spawn(process.execPath, [nextBin, "dev", "-p", String(opts.port)], { cwd: REPO, env, stdio: ["ignore", log, log], detached: keep });
  if (keep) started.site.unref();
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await siteUp(probe)) { console.log(`site: next dev on ${opts.port} (compiled)`); return; }
  }
  throw new Error(`site did not start, see ${path.join(OUT, "site.log")}`);
}

export function cleanup(opts) {
  if (opts.flags.has("keep")) return;
  if (started.site) {
    try { execFileSync("taskkill", ["/pid", String(started.site.pid), "/T", "/F"], { stdio: "ignore" }); } catch { started.site.kill(); }
    console.log("site: stopped");
  }
  if (started.worker) {
    try { docker("rm", "-f", opts.container); console.log(`worker: ${opts.container} removed`); } catch {}
  }
}

// --- the kiosk page, production blocked --------------------------------------
// Returns { page, prodHits }: prodHits collects any request that tried to reach
// production (the test must fail if it is not empty — it should never be).
export async function kioskPage(context, opts, log = () => {}) {
  const prodHits = [];
  await context.route(`${PROD_SITE}/**`, (route) => {
    prodHits.push(route.request().url());
    return route.abort();
  });
  // The tour's AIWEB frame URL lives in its locale file (any query string).
  await context.route((url) => url.pathname.includes("/3dvista/locale/"), async (route) => {
    const res = await route.fetch();
    const text = await res.text();
    const body = text.replaceAll(`${PROD_SITE}/receptionist-embed`, `${opts.site}/receptionist-embed`);
    if (body !== text) log(`AIWEB pointed at ${opts.site}/receptionist-embed`);
    await route.fulfill({ response: res, body });
  });
  const page = await context.newPage();
  return { page, prodHits };
}

// AIWEB ships hidden in the tour: tap the AI button, like a visitor, until
// Mia's frame is loaded — and verified local — then return it.
export async function startMia(page, opts, timeoutMs = 90000) {
  const button = page.locator("button[title*='AI receptionist']");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (page.frames().some((f) => f.url().includes("/receptionist-embed"))) {
      return embedFrame(page, opts); // throws if it is production
    }
    try {
      const title = await button.getAttribute("title");
      if (/Show|Talk/.test(title ?? "")) await button.click();
    } catch {}
    if (Date.now() > deadline) throw new Error("the AI button never brought up Mia's frame");
    await sleep(2000);
  }
}

// The receptionist embed's frame inside the kiosk page — and PROOF that it is
// the local one, never production, before a test drives anything.
export async function embedFrame(page, opts, timeoutMs = 60000) {
  const want = `${opts.site}/receptionist-embed`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frame = page.frames().find((f) => f.url().startsWith(want));
    if (frame) return frame;
    const prod = page.frames().find((f) => f.url().startsWith(PROD_SITE));
    if (prod) throw new Error(`AIWEB frame is PRODUCTION (${prod.url()}) — aborting`);
    if (Date.now() > deadline) {
      throw new Error(`no local embed frame appeared; frames: ${page.frames().map((f) => f.url()).join(", ")}`);
    }
    await sleep(500);
  }
}
