// Video call to staff (#22), end to end: two browsers through the real
// LiveKit project and a local worker. The kiosk (the embed page) and a team
// member's phone (/join, iPhone viewport), each with a mic we speak into on
// cue (Deepgram TTS clips through a getUserMedia stand-in; the phone's camera
// is Chrome's fake device).
//
//   node tests/voice/call.mjs --id v --port 3108                # both scenarios
//   node tests/voice/call.mjs --id v --port 3108 answered       # one
//   node tests/voice/call.mjs --id v --port 3108 --build        # rebuild the image first
//
// answered: talk to Nicolas → offer → yes + name → call_staff → the email
//   (sent to the sandbox inbox, read back from Resend) → the phone opens its
//   link, preview, Join → his video and voice on the kiosk, she is quiet
//   (handover) while the visitor talks to him, past the idle and max limits
//   (shortened to 30 s / 90 s) → he leaves → "anything else?" → goodbye → the
//   link now says the visitor has left.
// noanswer: CALL_ANSWER_TIMEOUT shortened to 25 s: call Alexandre, nobody
//   joins → she says so and offers a message → message sent → goodbye.
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
import { OUT, REPO, envPath, options, readEnv, sleep } from "./lib.mjs";
import { writeSandboxTeam } from "./sandbox-team.mjs";

const opts = options(process.argv.slice(2));
const ENV = readEnv();
const DIR = path.join(OUT, "call");
fs.mkdirSync(DIR, { recursive: true });
const SITE = `http://localhost:${opts.port}`;
const NAME = "Linda";

const SCENARIOS = {
  // Limits shortened so the call has to outlast them.
  answered: { SESSION_IDLE_TIMEOUT: "30", SESSION_MAX_LENGTH: "90" },
  noanswer: { CALL_ANSWER_TIMEOUT: "25" },
};

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
      await fetch(`${SITE}/join`).catch(() => {}); // compile it now, not mid-call
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

// Waits for a worker log line matching `re` logged since `since` (ISO time).
async function waitLog(re, since, timeoutS = 30) {
  const end = Date.now() + timeoutS * 1000;
  while (Date.now() < end) {
    const hit = workerLogs(since).find((m) => re.test(m));
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

// The page's microphone: an AudioContext stream we play clips into on cue.
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
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    const out = new MediaStream();
    if (c?.video) (await original({ video: c.video })).getVideoTracks().forEach((t) => out.addTrack(t));
    if (c?.audio) ensure().dest.stream.getAudioTracks().forEach((t) => out.addTrack(t.clone()));
    return out;
  };
};

// Records an <audio> element's stream (the n-th on the page) into window.__rec[n].
const RECORDER = () => {
  window.__rec = {};
  window.__recordAudio = (n) => {
    const a = document.querySelectorAll("audio")[n];
    if (!a?.srcObject || window.__rec[n]) return !!window.__rec[n];
    const chunks = [];
    const rec = new MediaRecorder(a.srcObject, { mimeType: "audio/webm" });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.start(1000);
    window.__rec[n] = { rec, chunks };
    return true;
  };
  window.__stopAudio = async (n) => {
    const r = window.__rec[n];
    if (!r) return "";
    if (r.rec.state !== "inactive") r.rec.stop();
    await new Promise((res) => setTimeout(res, 1200));
    const buf = new Uint8Array(await new Blob(r.chunks).arrayBuffer());
    let s = "";
    for (const x of buf) s += String.fromCharCode(x);
    return btoa(s);
  };
};

async function say(page, who, text, voice) {
  const seconds = await page.evaluate((b64) => window.__mic.play(b64), await clip(text, voice));
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
async function openKiosk() {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const log = [];
  page.on("console", (m) => {
    const t = m.text();
    if (/\[SimliLK\]/.test(t)) log.push(`${stamp()} ${t.slice(0, 160)}`);
  });
  await page.addInitScript(FAKE_MIC);
  await page.addInitScript(RECORDER);
  await page.goto(`${SITE}/receptionist-embed`);
  return { browser, page, log };
}

async function openPhone() {
  const browser = await chromium.launch({
    args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
  const context = await browser.newContext({ ...devices["iPhone 13"], permissions: ["camera", "microphone"] });
  const page = await context.newPage();
  page.on("console", (m) => /\[join\]/.test(m.text()) && console.log(`  phone console: ${m.text()}`));
  await page.addInitScript(FAKE_MIC);
  return { browser, context, page };
}

async function waitConsole(kiosk, text, timeoutS) {
  const end = Date.now() + timeoutS * 1000;
  while (Date.now() < end) {
    if (kiosk.log.some((l) => l.includes(text))) return true;
    await sleep(300);
  }
  return false;
}

const shot = async (page, name) => {
  await page.screenshot({ path: path.join(DIR, `${name}.png`) });
  note(`screenshot: ${name}.png`);
};

// A visitor line, then her reply (a "said" log line) and time for it to play.
async function turn(kiosk, text, expect = /^said /, timeoutS = 25) {
  const since = nowIso();
  await say(kiosk.page, "VISITOR", text, VISITOR);
  const said = await waitLog(expect, since, timeoutS);
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

async function finish(kiosk, phone) {
  const mia = await kiosk.page.evaluate(() => window.__stopAudio(0)).catch(() => "");
  const staff = await kiosk.page.evaluate(() => window.__stopAudio(1)).catch(() => "");
  if (mia) fs.writeFileSync(path.join(DIR, `${current}_kiosk_linda.webm`), Buffer.from(mia, "base64"));
  if (staff) fs.writeFileSync(path.join(DIR, `${current}_kiosk_staff.webm`), Buffer.from(staff, "base64"));
  fs.writeFileSync(path.join(DIR, `${current}_kiosk_console.log`), kiosk.log.join("\n"));
  await kiosk.browser.close().catch(() => {});
  await phone?.browser.close().catch(() => {});
  return { mia: await transcribe(mia), staff: await transcribe(staff) };
}

// --- scenarios -------------------------------------------------------------------
async function answered() {
  const start = nowIso();
  const kiosk = await openKiosk();
  let phone = null;
  try {
    check(await waitConsole(kiosk, "mic set -> true", 60), "kiosk: session up, greeting over, mic open");
    await kiosk.page.evaluate(() => window.__recordAudio(0));

    step("1. The visitor asks for Nicolas; she offers the call");
    await turn(kiosk, "English, please.");
    const offer = await turn(kiosk, "Hi, I'd like to talk to Nicolas, please.");
    check(/call/i.test(offer) && !/calling/i.test(offer), `offers to call: ${offer}`);
    let since = nowIso();
    await say(kiosk.page, "VISITOR", "Yes please. My name is Sophie Martin.", VISITOR);
    const calling = await waitLog(/^said .*calling Nicolas/i, since, 30);
    check(!!calling, `says she's calling: ${calling}`);
    check(!!(await waitLog(/screen card: .*'type': 'calling'/, since, 5)), "calling card sent to the screen");
    await sleep(2500);
    await shot(kiosk.page, "answered_1_kiosk_calling");
    check(await kiosk.page.locator('[data-card="calling"]').isVisible(), "kiosk shows the Calling card");

    step("2. The email reaches the sandbox inbox with the join link");
    const link = await readEmail(since);
    if (!link) throw new Error("no join link: can't go on");

    step("3. Nicolas opens the link on his phone: preview, Join");
    phone = await openPhone();
    await phone.page.goto(link);
    await phone.page.getByText("Sophie Martin is at the kiosk").waitFor({ timeout: 20000 });
    await phone.page.getByRole("button", { name: "Join the call" }).waitFor();
    await sleep(1500);
    await shot(phone.page, "answered_3_phone_preview");
    since = nowIso();
    await phone.page.getByRole("button", { name: "Join the call" }).click();
    await phone.page.getByText("Live with Sophie Martin at the kiosk").waitFor({ timeout: 20000 });
    await phone.page.waitForFunction(() => {
      const v = document.querySelector("video:not([data-self-view])");
      return v && v.videoWidth > 0;
    }, null, { timeout: 20000 }).then(() => check(true, "phone sees the kiosk (her video)"), () => check(false, "phone sees the kiosk (her video)"));
    await shot(phone.page, "answered_3_phone_live");

    step("4. The kiosk shows him; she goes quiet (handover)");
    check(!!(await waitLog(/joined the call \(staff-nbastien\): handing over/, since, 15)), "worker: Nicolas joined, handing over");
    check(!!(await waitLog(/screen: .*'mia\.state': 'handover'/, since, 10)), "mia.state = handover");
    const tile = kiosk.page.locator('[data-staff-tile="on"]');
    check(await tile.waitFor({ timeout: 15000 }).then(() => true, () => false), "kiosk: his tile is up");
    const videoOk = await kiosk.page.waitForFunction(() => {
      const v = document.querySelector('[data-staff-tile="on"] video');
      return v && v.videoWidth > 0;
    }, null, { timeout: 15000 }).then(() => true, () => false);
    check(videoOk, "kiosk: his camera is playing");
    check(await kiosk.page.getByText("Nicolas is here").isVisible(), 'kiosk: "Nicolas is here"');
    check(!(await kiosk.page.locator('[data-card="calling"]').isVisible()), "kiosk: calling card gone");
    await kiosk.page.waitForFunction(() => window.__recordAudio(1), null, { timeout: 10000 }).catch(() => {});
    await shot(kiosk.page, "answered_4_kiosk_handover");

    step("5. They talk; she says nothing, even past the idle (30 s) and max (90 s) limits");
    const quietFrom = nowIso();
    await say(phone.page, "NICOLAS", "Hi Sophie, it's Nicolas. Thanks for waiting, I'm coming down to meet you.", STAFF);
    await sleep(2000);
    await say(kiosk.page, "VISITOR", "Great, thank you Nicolas! Can we also talk about the contract on Tuesday?", VISITOR);
    await sleep(2000);
    await say(phone.page, "NICOLAS", "Sure, Tuesday works. See you in a minute.", STAFF);
    note("…both stay silent for 35 s (idle limit 30 s)…");
    await sleep(35000);
    const during = workerLogs(quietFrom);
    const spoke = during.filter((m) => /^said /.test(m));
    check(spoke.length === 0, `she said nothing during the call: ${JSON.stringify(spoke)}`);
    check(!during.some((m) => /ending session/.test(m)), "the session wasn't ended during the call");
    const idleKept = during.find((m) => /during a call: the session stays open/.test(m));
    note(`worker: ${idleKept ?? "(no idle event during the call)"}`);
    const elapsed = (Date.now() - Date.parse(start)) / 1000;
    note(`session age now ${elapsed.toFixed(0)} s (SESSION_MAX_LENGTH 90)`);
    check(elapsed > 90, "the call outlasted the normal max length");

    step("6. Nicolas leaves; she takes the visitor back");
    since = nowIso();
    await phone.page.getByRole("button", { name: "Leave" }).click();
    await phone.page.getByText("You left the call").waitFor({ timeout: 10000 });
    await shot(phone.page, "answered_6_phone_left");
    check(!!(await waitLog(/left the call: back to the visitor/, since, 15)), "worker: back to the visitor");
    const back = await waitLog(/^said .*anything else/i, since, 20);
    check(!!back, `"Is there anything else I can help you with?": ${back}`);
    check(!!(await waitLog(/screen: .*'mia\.state': '(listening|speaking)'/, since, 10)), "mia.state back from handover");
    await sleep(4000);
    check(!(await kiosk.page.locator('[data-staff-tile="on"]').isVisible()), "kiosk: his tile is gone");
    await shot(kiosk.page, "answered_6_kiosk_back");

    step("7. Goodbye; the room ends; the link now says the visitor has left");
    since = nowIso();
    await say(kiosk.page, "VISITOR", "No, that's all. Thank you, goodbye!", VISITOR);
    check(!!(await waitLog(/ending session/, since, 30)), "session ends on goodbye");
    check(await waitConsole(kiosk, "room ended", 20), "kiosk: room ended");
    const again = await phone.context.newPage();
    await again.goto(link);
    check(await again.getByText("The visitor has left").waitFor({ timeout: 15000 }).then(() => true, () => false), 'link reopened: "The visitor has left"');
    await shot(again, "answered_7_phone_link_after");
  } finally {
    const t = await finish(kiosk, phone);
    step("Transcripts (Deepgram, of what the kiosk played)");
    note(`Linda (kiosk): ${t.mia}`);
    note(`Nicolas (kiosk): ${t.staff}`);
    check(/nicolas/i.test(t.staff) && /tuesday/i.test(t.staff), "his voice reached the kiosk");
    check(/calling nicolas/i.test(t.mia) && /anything else/i.test(t.mia), "the kiosk played her call line and her 'anything else'");
    fs.writeFileSync(path.join(DIR, `${current}_worker.log`), workerLogs(start).join("\n"));
  }
}

async function noanswer() {
  const start = nowIso();
  const kiosk = await openKiosk();
  let phone = null;
  try {
    check(await waitConsole(kiosk, "mic set -> true", 60), "kiosk: session up, greeting over, mic open");
    await kiosk.page.evaluate(() => window.__recordAudio(0));

    step("1. Call Alexandre");
    await turn(kiosk, "English, please.");
    await turn(kiosk, "Hi, can I talk to Alexandre? I'm David Chen.");
    let since = nowIso();
    await say(kiosk.page, "VISITOR", "Yes please.", VISITOR);
    const calling = await waitLog(/^said .*calling Alexandre/i, since, 30);
    check(!!calling, `says she's calling: ${calling}`);
    const link = await readEmail(since);
    await sleep(3000);
    await shot(kiosk.page, "noanswer_1_kiosk_calling");

    step("2. Nobody joins within 25 s: she says so and offers a message");
    const gaveUp = await waitLog(/did not answer within 25s/, since, 45);
    check(!!gaveUp, `worker: ${gaveUp}`);
    const offer = await waitLog(/^said .*message/i, since, 50);
    check(!!offer, `offers a message: ${offer}`);
    check(!!(await waitLog(/screen card: .*'type': 'dismiss'/, since, 5)), "calling card dismissed");
    await sleep(5000);
    check(!(await kiosk.page.locator('[data-card="calling"]').isVisible()), "kiosk: calling card gone");
    await shot(kiosk.page, "noanswer_2_kiosk_offer");

    step("3. A message instead");
    await turn(kiosk, "Yes, please tell him I'll call him tomorrow morning.");
    since = nowIso();
    await say(kiosk.page, "VISITOR", "Yes, that's right.", VISITOR);
    const sent = await waitLog(/take_message: sent to/, since, 30);
    check(!!sent, `message sent: ${sent}`);
    const said = await waitLog(/^said .*sent/i, since, 20);
    check(!!said, `says it's sent: ${said}`);
    await sleep(4000);

    step("4. Goodbye; the link then says the visitor has left");
    since = nowIso();
    await say(kiosk.page, "VISITOR", "That's all, thanks. Goodbye!", VISITOR);
    check(!!(await waitLog(/ending session/, since, 30)), "session ends on goodbye");
    check(await waitConsole(kiosk, "room ended", 20), "kiosk: room ended");
    if (link) {
      phone = await openPhone();
      await phone.page.goto(link);
      check(await phone.page.getByText("The visitor has left").waitFor({ timeout: 15000 }).then(() => true, () => false), 'late link: "The visitor has left"');
      await shot(phone.page, "noanswer_4_phone_link_after");
    }
  } finally {
    const t = await finish(kiosk, phone);
    step("Transcript (Deepgram, of what the kiosk played)");
    note(`Linda (kiosk): ${t.mia}`);
    check(/calling alexandre/i.test(t.mia) && /message/i.test(t.mia), "the kiosk played her call line and the message offer");
    fs.writeFileSync(path.join(DIR, `${current}_worker.log`), workerLogs(start).join("\n"));
  }
}

const RUN = { answered, noanswer };
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
