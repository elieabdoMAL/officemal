// Voice end-to-end tests for Mia: plays a scenario's WAV as the kiosk mic,
// records what the kiosk plays back, transcribes it with Deepgram, and checks
// the scenario's expectations against the transcript and the worker logs.
//
//   node tests/voice/run.mjs --id t --port 3106 wave1        # a group
//   node tests/voice/run.mjs --id t --port 3106 phone_en     # one scenario
//   node tests/voice/run.mjs --id t --port 3106 all          # everything
//
// It starts what isn't running (and stops it again at the end, unless --keep):
//   - the worker, container mia-<id> from image simli-worker:<id> (built from
//     agent-worker/ if missing, or with --build), agent name mia-<id>, the
//     sandbox team.json mounted (every email -> delivered@resend.dev);
//   - the site, `next dev -p <port>` dispatching to mia-<id>.
// Scenarios run one at a time; on a Simli 429 it waits and retries.
// Output in tests/voice/out/: <name>_mia.webm, <name>.json, report.md.
import { spawn, spawnSync, execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { chromium } from "@playwright/test";
import { OUT, REPO, envPath, loadScenarios, options, readEnv, sleep } from "./lib.mjs";
import { makeWavs, wavPath } from "./make-wavs.mjs";
import { writeSandboxTeam } from "./sandbox-team.mjs";

const opts = options(process.argv.slice(2));
const ENV = readEnv();
const SCENARIOS = loadScenarios();
const FIRST_MESSAGE = "Bonjour, hello! Français ou English?";
const RETRY_WAITS_S = [60, 120, 240]; // Simli rate limit (shared key)
const COOLDOWN_S = 10; // between scenarios, so the last session is gone

// Worker log lines that show a tool (or a control path) ran.
const TOOL_LOGS = {
  take_message: /^take_message: /,
  notify_member: /^notify_member: /,
  alert_emergency: /^alert_emergency: /,
  end_conversation: /^end_conversation: goodbye said|^ending session in \S+: visitor said goodbye/,
  pause: /^pause requested|^pause_conversation called|^stop request heard while speaking/,
  wake: /^called back by name/,
  switch: /^visitor asked to switch to/,
};
const RATE_LIMITED = /\b429\b|too many requests|rate.?limit/i;

// --- names -----------------------------------------------------------------
function pick(names) {
  if (!names.length || names.includes("all")) return Object.keys(SCENARIOS).filter(n => !SCENARIOS[n].groups?.includes("slow") || names.includes("all"));
  const out = [];
  for (const n of names) {
    const group = Object.keys(SCENARIOS).filter(s => SCENARIOS[s].groups?.includes(n));
    if (SCENARIOS[n]) out.push(n);
    else if (group.length) out.push(...group);
    else throw new Error(`unknown scenario or group: ${n} (have ${Object.keys(SCENARIOS).join(", ")})`);
  }
  return [...new Set(out)];
}

// --- worker and site -------------------------------------------------------
const docker = (...args) => execFileSync("docker", args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
const started = { worker: false, site: null };

function containerRunning() {
  try { return docker("inspect", "-f", "{{.State.Running}}", opts.container).trim() === "true"; } catch { return false; }
}

async function ensureWorker(team) {
  if (containerRunning() && !opts.flags.has("restart")) { console.log(`worker: using running ${opts.container}`); return; }
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
    const logs = dockerLogs();
    if (/registered worker/i.test(logs)) { console.log(`worker: ${opts.container} registered as ${opts.agent}`); return; }
  }
  throw new Error(`worker ${opts.container} did not register:\n${dockerLogs("--tail", "30")}`);
}

const siteUrl = () => `http://localhost:${opts.port}/receptionist-embed`;
async function siteUp() {
  try { return (await fetch(siteUrl(), { signal: AbortSignal.timeout(60000) })).ok; } catch { return false; }
}

async function ensureSite() {
  if (await siteUp()) { console.log(`site: using running server on ${opts.port} (it must dispatch to ${opts.agent})`); return; }
  const nextBin = path.join(REPO, "node_modules", "next", "dist", "bin", "next");
  if (!fs.existsSync(nextBin)) throw new Error("no node_modules: run `npm ci` first");
  const env = {
    ...process.env,
    LIVEKIT_URL: ENV.LIVEKIT_URL, LIVEKIT_API_KEY: ENV.LIVEKIT_API_KEY, LIVEKIT_API_SECRET: ENV.LIVEKIT_API_SECRET,
    LIVEKIT_AGENT_NAME: opts.agent, NEXT_PUBLIC_AVATAR_PROVIDER: "simli-livekit",
  };
  const log = fs.openSync(path.join(OUT, "site.log"), "w");
  // --keep: detached, so it outlives this run and the next one reuses it.
  const keep = opts.flags.has("keep");
  started.site = spawn(process.execPath, [nextBin, "dev", "-p", String(opts.port)], { cwd: REPO, env, stdio: ["ignore", log, log], detached: keep });
  if (keep) {
    started.site.unref();
    console.log(`site: kept after this run (stop it with: taskkill //PID ${started.site.pid} //T //F)`);
  }
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await siteUp()) { console.log(`site: next dev on ${opts.port} (compiled)`); return; }
  }
  throw new Error(`site did not start, see ${path.join(OUT, "site.log")}`);
}

function cleanup() {
  if (opts.flags.has("keep")) return;
  if (started.site) {
    try { execFileSync("taskkill", ["/pid", String(started.site.pid), "/T", "/F"], { stdio: "ignore" }); } catch { started.site.kill(); }
    console.log("site: stopped");
  }
  if (started.worker) { try { docker("rm", "-f", opts.container); console.log(`worker: ${opts.container} removed`); } catch {} }
}

// --- one run in the browser ------------------------------------------------
function wavSeconds(file) {
  return (fs.statSync(file).size - 44) / 2 / 48000;
}

async function play(name) {
  const wav = wavPath(name);
  const wavSec = wavSeconds(wav);
  const since = new Date(Date.now() - 1000).toISOString();
  const t0 = Date.now();
  const ts = () => ((Date.now() - t0) / 1000).toFixed(1);
  const browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`, "--autoplay-policy=no-user-gesture-required"],
  });
  const page = await browser.newPage();
  let micAt = null, endedAt = null;
  const console_ = [];
  page.on("console", m => {
    const t = m.text();
    if (/\[SimliLK\]/.test(t)) console_.push(`${ts()}s ${t.slice(0, 140)}`);
    if (t.includes("mic set -> true") && micAt === null) micAt = Date.now();
    if (t.includes("room ended") && endedAt === null) endedAt = Date.now();
  });
  // Record whatever the kiosk plays: her audio track on the page's <audio>.
  await page.addInitScript(() => {
    window.__chunks = [];
    const tick = setInterval(() => {
      const a = document.querySelector("audio");
      if (a && a.srcObject && !window.__rec) {
        window.__rec = new MediaRecorder(a.srcObject, { mimeType: "audio/webm" });
        window.__rec.ondataavailable = e => e.data.size && window.__chunks.push(e.data);
        window.__rec.start(1000);
        clearInterval(tick);
      }
    }, 200);
  });
  await page.goto(siteUrl());
  for (;;) {
    await sleep(500);
    if (endedAt && Date.now() - endedAt > 1500) break;
    // Chrome loops the fake mic file: stop just before it starts over.
    if (micAt && Date.now() - micAt > (wavSec - 1) * 1000) break;
    if (!micAt && Date.now() - t0 > 60000) break; // never got going
    if (Date.now() - t0 > (wavSec + 60) * 1000) break;
  }
  const ranS = Number(ts());
  let b64 = "";
  try {
    b64 = await page.evaluate(async () => {
      if (!window.__rec) return "";
      if (window.__rec.state !== "inactive") window.__rec.stop();
      await new Promise(r => setTimeout(r, 1200));
      const buf = new Uint8Array(await new Blob(window.__chunks).arrayBuffer());
      let s = "";
      for (const x of buf) s += String.fromCharCode(x);
      return btoa(s);
    });
  } catch {}
  await browser.close();
  await sleep(2500); // let the worker log the session's end
  const recording = b64 ? Buffer.from(b64, "base64") : null;
  if (recording) fs.writeFileSync(path.join(OUT, `${name}_mia.webm`), recording);
  return {
    ranS, wavSec,
    micOpenedS: micAt ? (micAt - t0) / 1000 : null,
    endedS: endedAt ? (endedAt - t0) / 1000 : null,
    console: console_,
    logs: workerLogs(since),
    recording,
  };
}

// docker logs replays the container's stderr (where Python logs) on stderr.
function dockerLogs(...args) {
  const r = spawnSync("docker", ["logs", ...args, opts.container], { maxBuffer: 64 << 20 });
  return `${r.stdout}${r.stderr}`;
}

function workerLogs(since) {
  return dockerLogs("--since", since).split("\n").filter(Boolean).map(l => {
    try { const j = JSON.parse(l); return { time: (j.timestamp || "").slice(11, 23), msg: j.message ?? l }; } catch { return { time: "", msg: l }; }
  });
}

// --- transcription and checks ----------------------------------------------
// In the scenario's language: "multi" misheard her grouped digits in both
// languages ("one. I've gone four", "cinq a quatre") where nova-3 en/fr did not.
async function transcribe(audio, language) {
  if (!audio || audio.length < 2000) return { text: "", utterances: [] };
  const url = `https://api.deepgram.com/v1/listen?model=nova-3&language=${language}&utterances=true&punctuate=true`;
  let res;
  // Connect timeouts to Deepgram killed whole runs twice: retry before giving up.
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(url, { method: "POST", headers: { Authorization: `Token ${ENV.DEEPGRAM_API_KEY}`, "Content-Type": "audio/webm" }, body: audio });
      break;
    } catch (err) {
      if (attempt >= 3) throw err;
      console.log(`   Deepgram listen failed (${err.cause?.code ?? err.message}); retrying in 10s`);
      await sleep(10000);
    }
  }
  if (!res.ok) throw new Error(`Deepgram listen ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return {
    text: j.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "",
    utterances: (j.results?.utterances ?? []).map(u => ({ start: u.start, text: u.transcript })),
  };
}

const fold = s => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const words = s => fold(s).replace(/[^a-z0-9']+/g, " ").trim();
const DIGITS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  un: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, sept: 7, huit: 8, neuf: 9,
};
// "one five one four" and "1514" both become "1 5 1 4".
const digitView = s => words(s).split(" ").map(w => (w in DIGITS ? String(DIGITS[w]) : /^\d+$/.test(w) ? w.split("").join(" ") : w)).join(" ");

function matches(pattern, text) {
  if (pattern.startsWith("/") && pattern.endsWith("/")) {
    const re = new RegExp(pattern.slice(1, -1), "i");
    return re.test(words(text)) || re.test(digitView(text)) || re.test(text);
  }
  return ` ${words(text)} `.includes(` ${words(pattern)} `);
}
const anyMatch = (p, text) => (Array.isArray(p) ? p : [p]).some(x => matches(x, text));
const label = p => (Array.isArray(p) ? p.join(" | ") : p);

const FR = new Set("je vous le la les de des est pour avec une un nous bien suis votre en et a que au du sont c'est j'ai".split(" "));
const EN = new Set("i you the is to and we for with our can a of are your it in how help i'm it's".split(" "));
function languageOf(text) {
  const ws = words(text).split(" ");
  const fr = ws.filter(w => FR.has(w)).length, en = ws.filter(w => EN.has(w)).length;
  return fr > en ? "fr" : en > fr ? "en" : null;
}

function check(sc, run, transcript) {
  const e = sc.expect ?? {};
  const results = [];
  const ok = (pass, what) => results.push({ pass, what });
  const msgs = run.logs.map(l => l.msg);
  const said = msgs.filter(m => m.startsWith("said ")).map(m => m.slice(5).replace(/^'|'$|^"|"$/g, ""));
  const saidText = said.map(s => `| ${s} `).join("");
  const fired = Object.fromEntries(Object.entries(TOOL_LOGS).map(([k, re]) => [k, msgs.some(m => re.test(m))]));

  for (const p of e.say ?? []) ok(anyMatch(p, transcript.text), `she says ${label(p)}`);
  for (const p of e.notSay ?? []) ok(!anyMatch(p, transcript.text), `she doesn't say ${label(p)}`);
  for (const p of e.said ?? []) ok(anyMatch(p, saidText), `worker text has ${label(p)}`);
  for (const p of e.notSaid ?? []) ok(!anyMatch(p, saidText), `worker text has no ${label(p)}`);
  for (const t of e.tools ?? []) ok(fired[t], `${t} fired`);
  for (const t of e.notTools ?? []) ok(!fired[t], `${t} did not fire`);
  const inLogs = p => msgs.some(m => (p.startsWith("/") ? new RegExp(p.slice(1, -1), "i").test(m) : m.toLowerCase().includes(p.toLowerCase())));
  for (const p of e.logs ?? []) ok(inLogs(p), `log ${p}`);
  for (const p of e.notLogs ?? []) ok(!inLogs(p), `no log ${p}`);
  if (e.lang) {
    const off = said.filter(s => s !== FIRST_MESSAGE && words(s).split(" ").length >= 4 && languageOf(s) && languageOf(s) !== e.lang);
    ok(said.length > 1 && !off.length, `every reply in ${e.lang}${off.length ? `: ${off.map(s => JSON.stringify(s)).join(", ")}` : ""}`);
  }
  if (e.goodbyeHeard) {
    // Her last line (the goodbye), every word of it, at the end of the
    // recording: the room must not close before it has played.
    const last = said.at(-1) ?? "";
    const want = words(last).split(" ").filter(Boolean);
    const tail = words(transcript.text).split(" ").slice(-(want.length + 8));
    const missing = want.filter(w => !tail.includes(w));
    ok(want.length > 0 && missing.length <= (want.length >= 5 ? 1 : 0) && tail.includes(want.at(-1)),
      `her whole goodbye is in the recording (${JSON.stringify(last)}${missing.length ? `, missing: ${missing.join(" ")}` : ""})`);
  }
  if (e.ended !== undefined) ok(Boolean(run.endedS) === e.ended, e.ended ? "session ended by itself" : "session still open at the end");
  ok(said.length > 1, "she answered at least once after the greeting");
  return { results, fired, said };
}

// --- main ------------------------------------------------------------------
const INTERESTING = /^(heard|said|rejected|paused|resumed|called back|pause|stop request|language locked|STT language|visitor asked|ending session|holding the room|end_conversation|take_message|notify_member|alert_emergency|screen:|visitor_name|dropped|the visitor went on|deleting the room|goodbye)|error|exception|429/i;

async function runOne(name) {
  const sc = SCENARIOS[name];
  for (let attempt = 0; ; attempt++) {
    console.log(`\n=== ${name}${sc.about ? ` — ${sc.about}` : ""}`);
    const run = await play(name);
    const limited = run.logs.some(l => RATE_LIMITED.test(l.msg)) || run.console.some(l => RATE_LIMITED.test(l));
    if ((limited || !run.micOpenedS) && attempt < RETRY_WAITS_S.length) {
      const why = limited ? "Simli rate limit (429)" : "the session never opened the mic";
      console.log(`   ${why}; retrying in ${RETRY_WAITS_S[attempt]}s`);
      run.logs.filter(l => RATE_LIMITED.test(l.msg) || /error/i.test(l.msg)).slice(0, 5).forEach(l => console.log(`   | ${l.msg.slice(0, 200)}`));
      await sleep(RETRY_WAITS_S[attempt] * 1000);
      continue;
    }
    const transcript = await transcribe(run.recording, /^(en|fr)/.test(sc.voice) ? sc.voice.slice(0, 2) : "multi");
    const { results, fired, said } = check(sc, run, transcript);
    const pass = results.every(r => r.pass);
    console.log(`   ran ${run.ranS}s (wav ${run.wavSec.toFixed(0)}s), mic opened ${run.micOpenedS ?? "never"}s, ended by server: ${run.endedS ? `yes at ${run.endedS}s` : "no"}`);
    run.logs.filter(l => INTERESTING.test(l.msg)).forEach(l => console.log(`   ${l.time}  ${l.msg.slice(0, 220)}`));
    console.log(`   TRANSCRIPT: ${transcript.text || "(nothing recorded)"}`);
    results.forEach(r => console.log(`   ${r.pass ? "✓" : "✗"} ${r.what}`));
    console.log(`   ${pass ? "PASS" : "FAIL"} ${name}`);
    const record = { name, pass, attempts: attempt + 1, about: sc.about, lines: sc.lines, ...run, recording: undefined, transcript, fired, said, results };
    fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(record, null, 2));
    return record;
  }
}

function report(records) {
  const md = [`# Voice test run ${new Date().toISOString()}`, "", `Agent ${opts.agent}, image ${opts.image}, branch ${execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: REPO }).toString().trim()} @ ${execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO }).toString().trim()}`, ""];
  md.push("| scenario | result | failed checks |", "|---|---|---|");
  for (const r of records) md.push(`| ${r.name} | ${r.pass ? "PASS" : "FAIL"} | ${r.results.filter(x => !x.pass).map(x => x.what).join("; ")} |`);
  for (const r of records) {
    md.push("", `## ${r.name} — ${r.pass ? "PASS" : "FAIL"}`, "", r.about ?? "", "", "Visitor: " + r.lines.filter(l => l[0]).map(l => `"${l[0]}"`).join(" → "), "");
    md.push("Worker:", "```", ...r.logs.filter(l => INTERESTING.test(l.msg)).map(l => `${l.time}  ${l.msg.slice(0, 300)}`), "```");
    md.push("", `Transcript of the kiosk audio: ${r.transcript.text || "(nothing)"}`, "", ...r.results.map(x => `- ${x.pass ? "✓" : "✗"} ${x.what}`));
  }
  fs.writeFileSync(path.join(OUT, "report.md"), md.join("\n") + "\n");
}

const names = pick(opts.names);
fs.mkdirSync(OUT, { recursive: true });
const records = [];
let exitCode = 0;
process.on("SIGINT", () => { cleanup(); process.exit(130); });
try {
  const team = writeSandboxTeam();
  await makeWavs(names);
  await ensureWorker(team);
  await ensureSite();
  for (const [i, name] of names.entries()) {
    if (i) await sleep(COOLDOWN_S * 1000);
    records.push(await runOne(name));
  }
  report(records);
  console.log(`\n${records.filter(r => r.pass).length}/${records.length} passed: ${records.map(r => `${r.name} ${r.pass ? "PASS" : "FAIL"}`).join(", ")}`);
  console.log(`report: ${path.relative(REPO, path.join(OUT, "report.md"))}`);
  exitCode = records.every(r => r.pass) ? 0 : 1;
} catch (err) {
  console.error(err);
  if (records.length) report(records);
  exitCode = 2;
} finally {
  cleanup();
}
process.exit(exitCode);
