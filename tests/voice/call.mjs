// Video call to staff (#22), end to end: two browsers through the real
// LiveKit project and a local worker. The kiosk is the full kiosk page (the
// 3DVista tour, the AI button, Linda in the tour's AIWEB frame, the call
// window on top); the team member is a phone (/join, iPhone viewport). Both
// have Chrome's fake camera and a mic we speak into on cue (Deepgram TTS clips
// through a getUserMedia stand-in, in whichever frame asks for the mic).
//
//   node tests/voice/call.mjs --id w --port 3111                # all three scenarios
//   node tests/voice/call.mjs --id w --port 3111 answered       # one
//   node tests/voice/call.mjs --id w --port 3111 --build        # rebuild the image first
//
// answered: AI button → Linda → talk to Nicolas → offer → yes + name →
//   call_staff → the call window opens on the kiosk ("Calling Nicolas…"), the
//   embed's mic shuts → the email (sandbox inbox, read back from Resend) →
//   the phone opens its link, PreJoin, Join → both see each other (fake
//   cameras) and hear each other → Linda's session ends (kiosk room deleted,
//   AIWEB hidden) while the call goes on → Nicolas leaves → the window closes,
//   the call room is deleted, the AI stays hidden → the AI button starts a
//   fresh session → the link now says the visitor has left.
// noanswer: CALL_ANSWER_TIMEOUT shortened to 25 s: call Alexandre, nobody
//   joins → the window closes, she offers a message and hears the answer.
// cancel: call Nicolas, the visitor taps Cancel → the window closes, the call
//   room is deleted, she offers a message; the link says the visitor has left.
//
// Needs the tour in public/3dvista (git-ignored; copy it from the main
// checkout). Its AIWEB frame points at the production site; the test rewrites
// that URL to this site on the fly (locale/en.txt), so the frame is the local,
// same-origin embed.
//
// Like run.mjs it starts the worker (container mia-<id>, the sandbox
// team.json mounted, so every email goes to delivered@resend.dev) and the
// site (next dev -p <port>), and stops them at the end. Output in
// tests/voice/out/call/: screenshots, the email, recordings, transcripts,
// report.md. Exit code 0 when every check passes.
import { spawn, spawnSync, execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { chromium, devices } from "@playwright/test";
import { RoomServiceClient } from "livekit-server-sdk";
import { OUT, REPO, envPath, options, readEnv, sleep } from "./lib.mjs";
import { writeSandboxTeam } from "./sandbox-team.mjs";

const opts = options(process.argv.slice(2));
const ENV = readEnv();
const DIR = path.join(OUT, "call");
fs.mkdirSync(DIR, { recursive: true });
const SITE = `http://localhost:${opts.port}`;
const NAME = "Linda";
const PROD_SITE = "https://officemal.mobileappslabs.ca";
const PROD_EMBED = `${PROD_SITE}/receptionist-embed`;

const SCENARIOS = {
  answered: {},
  noanswer: { CALL_ANSWER_TIMEOUT: "25" },
  cancel: {},
};

const rooms = new RoomServiceClient(ENV.LIVEKIT_URL.replace(/^ws/, "http"), ENV.LIVEKIT_API_KEY, ENV.LIVEKIT_API_SECRET);
async function roomOpen(name) {
  return (await rooms.listRooms([name])).length > 0;
}
async function participants(name) {
  try {
    return (await rooms.listParticipants(name)).map((p) => p.identity);
  } catch {
    return null; // no such room
  }
}

// --- report -----------------------------------------------------------------
const report = [];
const failures = [];
let current = "";
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
function step(text) {
  console.log(`\n[${stamp()}] ${text}`);
  report.push(`\n**${text}**`);
}
function check(ok, what) {
  console.log(`  ${ok ? "✓" : "✗"} ${what}`);
  report.push(`- ${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures.push(`${current}: ${what}`);
  return ok;
}
function note(text) {
  console.log(`  ${text}`);
  report.push(`  ${text}`);
}
async function until(fn, timeoutS, every = 500) {
  const end = Date.now() + timeoutS * 1000;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {}
    await sleep(every);
  }
  return false;
}

// --- worker and site ------------------------------------------------------------
const docker = (...args) => execFileSync("docker", args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
let site = null;

function dockerLogs(...args) {
  const r = spawnSync("docker", ["logs", ...args, opts.container], { maxBuffer: 64 << 20 });
  return `${r.stdout}${r.stderr}`;
}

function workerLogs(since) {
  return dockerLogs("--since", since)
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        const j = JSON.parse(l);
        return j.message ?? l;
      } catch {
        return l;
      }
    });
}

async function startWorker(extraEnv) {
  try { docker("rm", "-f", opts.container); } catch {}
  const env = { LIVEKIT_AGENT_NAME: opts.agent, SITE_URL: SITE, ASSISTANT_NAME: NAME, ...extraEnv };
  const args = ["run", "-d", "--name", opts.container, "--env-file", envPath()];
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  args.push("-v", `${writeSandboxTeam()}:/app/team.json:ro`, opts.image);
  docker(...args);
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (/registered worker/i.test(dockerLogs())) return note(`worker ${opts.container} up (${JSON.stringify(extraEnv)})`);
  }
  throw new Error(`worker did not register:\n${dockerLogs("--tail", "30")}`);
}

async function siteUp() {
  try { return (await fetch(`${SITE}/receptionist-embed`, { signal: AbortSignal.timeout(60000) })).ok; } catch { return false; }
}

async function startSite() {
  if (!fs.existsSync(path.join(REPO, "public", "3dvista", "index.html"))) {
    throw new Error("public/3dvista is missing: copy the tour from the main checkout first");
  }
  if (await siteUp()) return note(`site: using the server already on ${opts.port}`);
  const env = {
    ...process.env,
    LIVEKIT_URL: ENV.LIVEKIT_URL, LIVEKIT_API_KEY: ENV.LIVEKIT_API_KEY, LIVEKIT_API_SECRET: ENV.LIVEKIT_API_SECRET,
    LIVEKIT_AGENT_NAME: opts.agent, NEXT_PUBLIC_AVATAR_PROVIDER: "simli-livekit", NEXT_PUBLIC_ASSISTANT_NAME: NAME,
  };
  const log = fs.openSync(path.join(DIR, "site.log"), "w");
  site = spawn(process.execPath, [path.join(REPO, "node_modules", "next", "dist", "bin", "next"), "dev", "-p", String(opts.port)],
    { cwd: REPO, env, stdio: ["ignore", log, log] });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await siteUp()) {
      // Compile the pages now, not mid-call.
      await fetch(`${SITE}/join`).catch(() => {});
      await fetch(`${SITE}/`).catch(() => {});
      return note(`site: next dev on ${opts.port}`);
    }
  }
  throw new Error("site did not start, see site.log");
}

function cleanup() {
  if (site) {
    try { execFileSync("taskkill", ["/pid", String(site.pid), "/T", "/F"], { stdio: "ignore" }); } catch { site.kill(); }
  }
  try { docker("rm", "-f", opts.container); } catch {}
}

// Waits for a worker log line matching `re` logged since `since` (ISO time),
// and after one matching `after` if given.
async function waitLog(re, since, timeoutS = 30, after = null) {
  const end = Date.now() + timeoutS * 1000;
  while (Date.now() < end) {
    let lines = workerLogs(since);
    if (after) lines = lines.slice(lines.findIndex((m) => after.test(m)) + 1 || lines.length);
    const hit = lines.find((m) => re.test(m));
    if (hit) return hit;
    await sleep(500);
  }
  return null;
}
const nowIso = () => new Date(Date.now() - 500).toISOString();

// --- voices ---------------------------------------------------------------------
const clips = new Map();
async function clip(text, voice) {
  const key = `${voice}|${text}`;
  if (clips.has(key)) return clips.get(key);
  const res = await fetch(`https://api.deepgram.com/v1/speak?model=${voice}&encoding=linear16&sample_rate=48000&container=wav`, {
    method: "POST",
    headers: { Authorization: `Token ${ENV.DEEPGRAM_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Deepgram TTS ${res.status}: ${await res.text()}`);
  const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
  clips.set(key, b64);
  return b64;
}
const VISITOR = "aura-2-thalia-en";
const STAFF = "aura-2-orion-en";

// Each frame's microphone: an AudioContext stream we play clips into on cue.
// Video requests still get Chrome's fake camera.
const FAKE_MIC = () => {
  let ctx = null;
  let dest = null;
  const ensure = () => {
    if (!ctx) {
      ctx = new AudioContext({ sampleRate: 48000 });
      dest = ctx.createMediaStreamDestination();
    }
    return { ctx, dest };
  };
  window.__mic = {
    async play(b64) {
      const { ctx, dest } = ensure();
      await ctx.resume();
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const audio = await ctx.decodeAudioData(bytes.buffer);
      const src = ctx.createBufferSource();
      src.buffer = audio;
      src.connect(dest);
      src.start();
      return audio.duration;
    },
  };
  if (!navigator.mediaDevices) return;
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    const out = new MediaStream();
    if (c?.video) (await original({ video: c.video })).getVideoTracks().forEach((t) => out.addTrack(t));
    if (c?.audio) ensure().dest.stream.getAudioTracks().forEach((t) => out.addTrack(t.clone()));
    return out;
  };
};

// Records an <audio> element's stream (the first one in the frame matching
// `selector` that has a stream) into window.__rec[key].
const RECORDER = () => {
  window.__rec = {};
  window.__recordAudio = (key, selector = "audio") => {
    if (window.__rec[key]) return true;
    const a = [...document.querySelectorAll(selector)].find((el) => el.srcObject);
    if (!a) return false;
    const chunks = [];
    const rec = new MediaRecorder(a.srcObject, { mimeType: "audio/webm" });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.start(1000);
    window.__rec[key] = { rec, chunks };
    return true;
  };
  window.__stopAudio = async (key) => {
    const r = window.__rec[key];
    if (!r) return "";
    if (r.rec.state !== "inactive") r.rec.stop();
    await new Promise((res) => setTimeout(res, 1200));
    const buf = new Uint8Array(await new Blob(r.chunks).arrayBuffer());
    let s = "";
    for (const x of buf) s += String.fromCharCode(x);
    return btoa(s);
  };
};

async function say(frame, who, text, voice) {
  const seconds = await frame.evaluate((b64) => window.__mic.play(b64), await clip(text, voice));
  note(`${who}: "${text}"`);
  await sleep(seconds * 1000);
}

async function transcribe(b64) {
  if (!b64 || b64.length < 3000) return "";
  const res = await fetch("https://api.deepgram.com/v1/listen?model=nova-3&language=en&punctuate=true", {
    method: "POST",
    headers: { Authorization: `Token ${ENV.DEEPGRAM_API_KEY}`, "Content-Type": "audio/webm" },
    body: Buffer.from(b64, "base64"),
  });
  if (!res.ok) return `(Deepgram ${res.status})`;
  return (await res.json()).results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
}

// --- browsers -------------------------------------------------------------------
const MEDIA_ARGS = ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"];

// The kiosk page with the tour; Linda's frame pointed at this site.
async function openKiosk() {
  const browser = await chromium.launch({ args: MEDIA_ARGS });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, permissions: ["camera", "microphone"] });
  const page = await context.newPage();
  const log = [];
  page.on("console", (m) => {
    const t = m.text();
    if (/\[(SimliLK|call|AiToggle)\]/.test(t)) log.push(`${stamp()} ${t.slice(0, 200)}`);
  });
  // Never the production site: its embed would talk to the production
  // worker, whose team.json emails the real team. Blocked, and the run fails.
  await context.route(`${PROD_SITE}/**`, (route) => {
    check(false, `blocked a request to production: ${route.request().url()}`);
    return route.abort();
  });
  // The tour's AIWEB frame URL lives in its locale file (any query string).
  await context.route((url) => url.pathname.includes("/3dvista/locale/"), async (route) => {
    const res = await route.fetch();
    const text = await res.text();
    const body = text.replaceAll(PROD_EMBED, `${SITE}/receptionist-embed`);
    if (body !== text) log.push(`${stamp()} [test] AIWEB pointed at ${SITE}/receptionist-embed (${route.request().url()})`);
    await route.fulfill({ response: res, body });
  });
  await page.addInitScript(FAKE_MIC);
  await page.addInitScript(RECORDER);
  await page.goto(`${SITE}/`);
  return { browser, page, log };
}

const embed = (kiosk) => kiosk.page.frames().find((f) => f.url().includes("/receptionist-embed"));

const aiButton = (kiosk) => kiosk.page.locator("button[title*='AI receptionist']");

// Taps the AI button until Linda's frame is there, then waits for her session
// (greeting over, mic open). Returns the kiosk room's name.
async function startLinda(kiosk) {
  const from = kiosk.log.length;
  const shown = await until(async () => {
    if (embed(kiosk)) return true;
    const title = await aiButton(kiosk).getAttribute("title");
    if (/Show|Talk/.test(title ?? "")) await aiButton(kiosk).click();
    await sleep(2500);
    return !!embed(kiosk);
  }, 60, 1000);
  check(shown, "AI button: Linda's frame is up");
  const url = embed(kiosk)?.url() ?? "";
  if (!check(url.startsWith(`${SITE}/receptionist-embed`), `her frame is the local embed: ${url}`)) {
    throw new Error("not the local embed: stopping before anything is said");
  }
  check(await waitConsole(kiosk, "mic set -> true", 60, from), "Linda: session up, greeting over, mic open");
  const line = kiosk.log.slice(from).find((l) => l.includes("in room kiosk-"));
  return line?.match(/in room (kiosk-\S+)/)?.[1] ?? null;
}

async function openPhone() {
  const browser = await chromium.launch({ args: MEDIA_ARGS });
  const context = await browser.newContext({ ...devices["iPhone 13"], permissions: ["camera", "microphone"] });
  const page = await context.newPage();
  page.on("console", (m) => /\[join\]/.test(m.text()) && console.log(`  phone console: ${m.text()}`));
  await page.addInitScript(FAKE_MIC);
  await page.addInitScript(RECORDER);
  return { browser, context, page };
}

async function waitConsole(kiosk, text, timeoutS, from = 0) {
  return until(() => kiosk.log.slice(from).some((l) => l.includes(text)), timeoutS, 300);
}

const shot = async (page, name) => {
  await page.screenshot({ path: path.join(DIR, `${name}.png`) });
  note(`screenshot: ${name}.png`);
};

// A remote participant's video is playing in this frame's VideoConference.
const remoteVideoPlaying = (frame, timeoutS = 20) =>
  frame
    .waitForFunction(() => {
      const v = document.querySelector('.lk-participant-tile[data-lk-local-participant="false"] video');
      return v && v.videoWidth > 0;
    }, null, { timeout: timeoutS * 1000 })
    .then(() => true, () => false);

// A visitor line, then her reply (a "said" log line once she has heard it:
// her greeting is logged when it ends, which can fall after the line starts)
// and time for it to play.
async function turn(kiosk, text, expect = /^said /, timeoutS = 25) {
  const since = nowIso();
  await say(embed(kiosk), "VISITOR", text, VISITOR);
  const said = await waitLog(expect, since, timeoutS, /^heard /);
  note(`worker: ${said ?? "(nothing matching " + expect + ")"}`);
  await sleep(4000);
  return said ?? "";
}

// The email call_staff sent, read back from Resend (the sandbox inbox).
async function readEmail(since) {
  const line = await waitLog(/call_staff: sent to .*\(([^)]+)\)/, since, 30);
  if (!check(!!line, `invitation email sent: ${line}`)) return null;
  const id = line.match(/\(([^)]+)\)\s*$/)[1];
  check(/delivered@resend\.dev/.test(line), "to the sandbox inbox (team.json sandboxed)");
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`https://api.resend.com/emails/${id}`, { headers: { Authorization: `Bearer ${ENV.RESEND_API_KEY}` } });
    if (res.ok) {
      const mail = await res.json();
      fs.writeFileSync(path.join(DIR, `${current}_email.html`), mail.html ?? "");
      note(`email ${id}: to ${mail.to}, subject "${mail.subject}"`);
      const href = (mail.html ?? "").match(/href="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
      check(/is at the kiosk — join the call$/.test(mail.subject ?? ""), `subject "{visitor} is at the kiosk — join the call": ${mail.subject}`);
      check(!!href && href.startsWith(`${SITE}/join#t=`), `link to /join with the token in the fragment: ${href?.slice(0, 60)}…`);
      return href;
    }
    note(`Resend GET /emails/${id}: ${res.status} ${(await res.text()).slice(0, 120)}`);
    if (res.status === 401 || res.status === 403) break;
    await sleep(2000);
  }
  return null;
}

// Talk to Linda until she places the call; returns the call room's name.
async function placeCall(kiosk, ask, yes, who) {
  await turn(kiosk, "English, please.");
  const offer = await turn(kiosk, ask);
  check(/call/i.test(offer) && !/calling/i.test(offer), `offers to call: ${offer}`);
  const since = nowIso();
  await say(embed(kiosk), "VISITOR", yes, VISITOR);
  const calling = await waitLog(new RegExp(`^said .*calling ${who}`, "i"), since, 30);
  check(!!calling, `says she's calling: ${calling}`);
  const placed = await waitLog(/call_staff: calling .* in (call-\S+)/, since, 5);
  const room = placed?.match(/in (call-\S+)/)?.[1] ?? null;
  check(!!room, `a call room: ${room}`);
  check(!!(await waitLog(/screen card: .*'type': 'call_open'/, since, 5)), "call_open sent to the screen");
  return { since, room };
}

async function checkRinging(kiosk, who, name) {
  const modal = kiosk.page.locator('[data-call-modal="ringing"]');
  check(await modal.waitFor({ timeout: 15000 }).then(() => true, () => false), "kiosk: the call window opened on the top page");
  check(await kiosk.page.getByText(`Call with ${who}`).isVisible(), `title "Call with ${who}"`);
  check(await kiosk.page.getByText(`Calling ${who}…`).isVisible(), `"Calling ${who}…" while it rings`);
  check(await waitConsole(kiosk, "mic set -> false", 10), "the embed's mic is shut while the window is up");
  await sleep(3000);
  await shot(kiosk.page, name);
}

async function finish(kiosk, phone, recs) {
  const out = {};
  for (const [key, frameOf] of Object.entries(recs)) {
    const frame = frameOf();
    const b64 = frame ? await frame.evaluate((k) => window.__stopAudio(k), key).catch(() => "") : "";
    if (b64) fs.writeFileSync(path.join(DIR, `${current}_${key}.webm`), Buffer.from(b64, "base64"));
    out[key] = await transcribe(b64);
  }
  fs.writeFileSync(path.join(DIR, `${current}_kiosk_console.log`), kiosk.log.join("\n"));
  await kiosk.browser.close().catch(() => {});
  await phone?.browser.close().catch(() => {});
  return out;
}

async function linkSaysGone(link, phone, name) {
  const again = await phone.context.newPage();
  await again.goto(link);
  const ok = await again.getByText("The visitor has left").waitFor({ timeout: 15000 }).then(() => true, () => false);
  check(ok, 'the link now says "The visitor has left"');
  await shot(again, name);
}

// --- scenarios -------------------------------------------------------------------
async function answered() {
  const start = nowIso();
  const kiosk = await openKiosk();
  let phone = null;
  const recs = {};
  try {
    step("0. The kiosk page: the tour, then the AI button starts Linda");
    const kioskRoom = await startLinda(kiosk);
    note(`kiosk room: ${kioskRoom}`);
    await embed(kiosk).evaluate(() => window.__recordAudio("linda_kiosk"));
    // Her frame goes away with her session: keep what was recorded so far.
    let lindaFrame = embed(kiosk);
    recs.linda_kiosk = () => lindaFrame;

    step("1. The visitor asks for Nicolas; she offers the call and calls");
    const { since: callSince, room } = await placeCall(kiosk, "Hi, I'd like to talk to Nicolas, please.", "Yes please. My name is Sophie Martin.", "Nicolas");
    await checkRinging(kiosk, "Nicolas", "answered_1_kiosk_ringing");
    const before = await participants(room);
    check(before?.length === 1 && before[0].startsWith("visitor-"), `call room: only the kiosk so far: ${JSON.stringify(before)}`);

    step("2. The email reaches the sandbox inbox with the join link");
    const link = await readEmail(callSince);
    if (!link) throw new Error("no join link: can't go on");

    step("3. Nicolas opens the link on his phone: PreJoin, Join");
    phone = await openPhone();
    await phone.page.goto(link);
    await phone.page.getByText("Sophie Martin is at the kiosk").waitFor({ timeout: 20000 });
    const join = phone.page.getByRole("button", { name: "Join the call" });
    await join.waitFor();
    check(!(await phone.page.locator("#username").isVisible()), "no name field (his name comes from the link)");
    await sleep(2000);
    const camera = await phone.page.locator(".lk-prejoin .lk-button-group.video").boundingBox();
    const joinBox = await join.boundingBox();
    check(!!camera && !!joinBox && joinBox.y >= camera.y + camera.height - 1 && joinBox.y + joinBox.height <= 844,
      `Join below the camera control, on screen: ${JSON.stringify({ camera, joinBox })}`);
    await shot(phone.page, "answered_3_phone_prejoin");
    // Save her recording now: the frame is unloaded once her session ends.
    const lindaAudio = await lindaFrame.evaluate(() => window.__stopAudio("linda_kiosk")).catch(() => "");
    lindaFrame = null;
    recs.linda_kiosk = () => ({ evaluate: async () => lindaAudio });
    const joinedAt = nowIso();
    await join.click();
    check(await remoteVideoPlaying(phone.page.mainFrame()), "phone: sees the kiosk's camera");
    await phone.page.waitForFunction(() => window.__recordAudio("visitor_on_phone"), null, { timeout: 15000 }).catch(() => {});
    recs.visitor_on_phone = () => phone.page.mainFrame();

    step("4. The kiosk: his video in the call window; Linda's session ends, AIWEB hidden");
    check(await kiosk.page.locator('[data-call-modal="live"]').waitFor({ timeout: 15000 }).then(() => true, () => false), "kiosk: the window is live (he joined)");
    check(await remoteVideoPlaying(kiosk.page.mainFrame()), "kiosk: sees his camera");
    check(!(await kiosk.page.locator("[data-call-ringing]").isVisible()), "kiosk: no more 'Calling…'");
    check(!!(await waitLog(/Nicolas Bastien joined the call in call-\S+: ending her session/, joinedAt, 15)), "worker: he joined, ending her session");
    check(!!(await waitLog(/screen card: .*'type': 'call_answered'/, joinedAt, 10)), "call_answered sent before the room goes");
    check(!!(await waitLog(/ending session in kiosk-\S+: call answered/, joinedAt, 15)), "worker: session ended (call answered)");
    check(await waitConsole(kiosk, "(call answered)", 15), "embed: room ended for the call");
    check(await until(async () => !(await roomOpen(kioskRoom)), 15), `kiosk room ${kioskRoom} deleted`);
    check(await until(async () => (await aiButton(kiosk).getAttribute("title")) === "Show the AI receptionist", 10),
      "AI button: Linda hidden (not resting)");
    check(await until(async () => !embed(kiosk), 10), "AIWEB frame unloaded by the tour");
    const during = await participants(room);
    check(during?.length === 2, `call room: the kiosk and Nicolas: ${JSON.stringify(during)}`);
    check(await kiosk.page.locator('[data-call-modal="live"]').isVisible(), "the call window is still connected");
    await kiosk.page.waitForFunction(() => window.__recordAudio("staff_on_kiosk"), null, { timeout: 10000 }).catch(() => {});
    recs.staff_on_kiosk = () => kiosk.page.mainFrame();
    const chatShown = (p) => p.evaluate(() => [...document.querySelectorAll(".lk-chat-toggle")].some((e) => e.offsetParent !== null));
    check(!(await chatShown(kiosk.page)) && !(await chatShown(phone.page)), "no Chat button on either side");
    await shot(kiosk.page, "answered_4_kiosk_live");
    await shot(phone.page, "answered_4_phone_live");

    step("5. They talk; Linda is gone");
    const quietFrom = nowIso();
    await say(phone.page.mainFrame(), "NICOLAS", "Hi Sophie, it's Nicolas. Thanks for waiting, I'm coming down to meet you.", STAFF);
    await sleep(1500);
    await say(kiosk.page.mainFrame(), "VISITOR", "Great, thank you Nicolas! Can we also talk about the contract on Tuesday?", VISITOR);
    await sleep(1500);
    await say(phone.page.mainFrame(), "NICOLAS", "Sure, Tuesday works. See you in a minute.", STAFF);
    await sleep(2000);
    check(!workerLogs(quietFrom).some((m) => /^said |^heard /.test(m)), "nothing of Linda runs during the call");

    step("6. Nicolas leaves: the window closes, the call room goes, the AI stays hidden");
    // Stop the recordings while both are still in the call.
    const staffAudio = await kiosk.page.evaluate(() => window.__stopAudio("staff_on_kiosk")).catch(() => "");
    recs.staff_on_kiosk = () => ({ evaluate: async () => staffAudio });
    const visitorAudio = await phone.page.evaluate(() => window.__stopAudio("visitor_on_phone")).catch(() => "");
    recs.visitor_on_phone = () => ({ evaluate: async () => visitorAudio });
    await phone.page.locator(".lk-disconnect-button").click();
    check(await phone.page.getByText("You left the call").waitFor({ timeout: 10000 }).then(() => true, () => false), 'phone: "You left the call"');
    await shot(phone.page, "answered_6_phone_left");
    check(await until(async () => !(await kiosk.page.locator("[data-call-modal]").isVisible()), 15), "kiosk: the call window closed");
    check(await until(async () => !(await roomOpen(room)), 15), `call room ${room} deleted`);
    await sleep(3000);
    check((await aiButton(kiosk).getAttribute("title")) === "Show the AI receptionist" && !embed(kiosk), "the AI stays hidden");
    check(!workerLogs(joinedAt).some((m) => /anything else/i.test(m)), "no 'anything else' (her session is over)");
    await shot(kiosk.page, "answered_6_kiosk_after");

    step("7. The AI button starts a fresh session");
    const freshFrom = nowIso();
    const fresh = await startLinda(kiosk);
    check(!!fresh && fresh !== kioskRoom, `a new kiosk room: ${fresh}`);
    check(!!(await waitLog(/^said .*(Bonjour|hello)/i, freshFrom, 30)), "a fresh greeting");
    await shot(kiosk.page, "answered_7_kiosk_fresh");

    step("8. The link now says the visitor has left");
    await linkSaysGone(link, phone, "answered_8_phone_link_after");
  } finally {
    const t = await finish(kiosk, phone, recs);
    step("Transcripts (Deepgram)");
    note(`Linda (kiosk embed, until the call): ${t.linda_kiosk}`);
    note(`Nicolas (heard on the kiosk): ${t.staff_on_kiosk}`);
    note(`Sophie (heard on the phone): ${t.visitor_on_phone}`);
    check(/nich?olas/i.test(t.staff_on_kiosk ?? "") && /tuesday/i.test(t.staff_on_kiosk ?? ""), "his voice reached the kiosk");
    check(/tuesday|contract/i.test(t.visitor_on_phone ?? ""), "the visitor's voice reached the phone");
    check(/calling nich?olas/i.test(t.linda_kiosk ?? ""), "the kiosk played her call line");
    fs.writeFileSync(path.join(DIR, `${current}_worker.log`), workerLogs(start).join("\n"));
  }
}

async function noanswer() {
  const start = nowIso();
  const kiosk = await openKiosk();
  let phone = null;
  const recs = {};
  try {
    step("0. The AI button starts Linda");
    await startLinda(kiosk);
    await embed(kiosk).evaluate(() => window.__recordAudio("linda_kiosk"));
    recs.linda_kiosk = () => embed(kiosk);

    step("1. Call Alexandre");
    const { since, room } = await placeCall(kiosk, "Hi, can I talk to Alexandre? I'm David Chen.", "Yes please.", "Alexandre");
    await checkRinging(kiosk, "Alexandre", "noanswer_1_kiosk_ringing");
    const link = await readEmail(since);

    step("2. Nobody joins within 25 s: the window closes, she offers a message");
    const gaveUp = await waitLog(/did not answer within 25s/, since, 45);
    check(!!gaveUp, `worker: ${gaveUp}`);
    check(!!(await waitLog(/screen card: .*'type': 'call_close'/, since, 5)), "call_close sent");
    check(await until(async () => !(await kiosk.page.locator("[data-call-modal]").isVisible()), 10), "kiosk: the call window closed");
    check(await until(async () => !(await roomOpen(room)), 10), `call room ${room} deleted`);
    const offer = await waitLog(/^said .*message/i, since, 50);
    check(!!offer, `offers a message: ${offer}`);
    const shutAt = kiosk.log.findIndex((l) => l.includes("mic set -> false"));
    check(await waitConsole(kiosk, "mic set -> true", 10, shutAt + 1), "the embed's mic is open again");
    check(!!embed(kiosk), "Linda still there (her session goes on)");
    await sleep(5000);
    await shot(kiosk.page, "noanswer_2_kiosk_offer");

    step("3. She hears the answer: a message instead");
    const heardFrom = nowIso();
    await turn(kiosk, "Yes, please tell him I'll call him tomorrow morning.");
    check(!!(await waitLog(/heard .*tomorrow/i, heardFrom, 5)), "she heard the visitor after the call window closed");

    step("4. Goodbye; the link says the visitor has left");
    await turn(kiosk, "Actually, that's all, thanks. Goodbye!", /ending session/, 30);
    if (link) {
      phone = await openPhone();
      await linkSaysGone(link, phone, "noanswer_4_phone_link_after");
    }
  } finally {
    const t = await finish(kiosk, phone, recs);
    step("Transcript (Deepgram, of what the kiosk played)");
    note(`Linda (kiosk embed): ${t.linda_kiosk}`);
    check(/calling alexand(er|re|ra)/i.test(t.linda_kiosk ?? "") && /message/i.test(t.linda_kiosk ?? ""), "the kiosk played her call line and the message offer");
    fs.writeFileSync(path.join(DIR, `${current}_worker.log`), workerLogs(start).join("\n"));
  }
}

async function cancel() {
  const start = nowIso();
  const kiosk = await openKiosk();
  let phone = null;
  const recs = {};
  try {
    step("0. The AI button starts Linda");
    await startLinda(kiosk);
    await embed(kiosk).evaluate(() => window.__recordAudio("linda_kiosk"));
    recs.linda_kiosk = () => embed(kiosk);

    step("1. Call Nicolas");
    const { since, room } = await placeCall(kiosk, "Hi, I'd like to talk to Nicolas, please.", "Yes please. I'm Emma Leroy.", "Nicolas");
    await checkRinging(kiosk, "Nicolas", "cancel_1_kiosk_ringing");
    const link = await readEmail(since);

    step("2. The visitor taps Cancel");
    const tapped = nowIso();
    await kiosk.page.getByRole("button", { name: "Cancel" }).click();
    check(await until(async () => !(await kiosk.page.locator("[data-call-modal]").isVisible()), 5), "kiosk: the call window closed");
    check(await until(async () => !(await roomOpen(room)), 10), `call room ${room} deleted`);
    check(!!(await waitLog(/the visitor cancelled the call to Nicolas Bastien|call room \S+ is gone: cancelled/, tapped, 10)), "worker: cancelled");
    const offer = await waitLog(/^said .*message/i, tapped, 30);
    check(!!offer, `offers a message: ${offer}`);
    check(!workerLogs(tapped).some((m) => /did not answer/.test(m)), "not reported as unanswered");
    await sleep(5000);
    await shot(kiosk.page, "cancel_2_kiosk_offer");

    step("3. The link says the visitor has left");
    if (link) {
      phone = await openPhone();
      await linkSaysGone(link, phone, "cancel_3_phone_link_after");
    }
    await turn(kiosk, "No thanks, that's all. Goodbye!", /ending session/, 30);
  } finally {
    const t = await finish(kiosk, phone, recs);
    step("Transcript (Deepgram, of what the kiosk played)");
    note(`Linda (kiosk embed): ${t.linda_kiosk}`);
    check(/message/i.test(t.linda_kiosk ?? ""), "the kiosk played the message offer");
    fs.writeFileSync(path.join(DIR, `${current}_worker.log`), workerLogs(start).join("\n"));
  }
}

const RUN = { answered, noanswer, cancel };
const names = opts.names.length ? opts.names : Object.keys(RUN);
process.on("SIGINT", () => { cleanup(); process.exit(130); });
try {
  if (opts.flags.has("build")) execFileSync("docker", ["build", "-q", "-t", opts.image, path.join(REPO, "agent-worker")], { stdio: "inherit" });
  await startSite();
  for (const name of names) {
    current = name;
    report.push(`\n## ${name}`);
    step(`Scenario ${name}`);
    await startWorker(SCENARIOS[name]);
    try {
      await RUN[name]();
    } catch (e) {
      check(false, `crashed: ${e.message}`);
    }
    await sleep(5000);
  }
} finally {
  cleanup();
  fs.writeFileSync(path.join(DIR, "report.md"), `# Video call e2e (${new Date().toISOString()})\n${report.join("\n")}\n\n${failures.length} failure(s)\n${failures.map((f) => `- ${f}`).join("\n")}\n`);
  console.log(`\n${failures.length} failure(s)${failures.map((f) => `\n  ✗ ${f}`).join("")}\nreport: ${path.join(DIR, "report.md")}`);
}
process.exit(failures.length ? 1 : 0);
