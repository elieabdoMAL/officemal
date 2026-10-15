// Generates one WAV per scenario with Deepgram TTS: the visitor's lines, each
// followed by its pause, as the kiosk mic will hear them. 48 kHz mono 16-bit,
// which Chrome's fake audio capture plays as the microphone.
//
//   node tests/voice/make-wavs.mjs [scenario ...] [--force]
//
// A WAV is regenerated only when its scenario's lines changed (or --force).
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { OUT, loadScenarios, readEnv } from "./lib.mjs";

const RATE = 48000;
// Visitor voices, not Mia's (andromeda / agathe), so the logs are easy to read.
export const VOICES = { en: "aura-2-thalia-en", fr: "aura-2-hector-fr", en2: "aura-2-apollo-en", fr2: "aura-2-agathe-fr" };
// Silence before the first line. The file starts playing when the kiosk opens
// the mic, i.e. once her greeting is over.
const LEAD_S = 2;

const silence = s => Buffer.alloc(Math.round(s * RATE) * 2);

function wavHeader(dataBytes) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + dataBytes, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}

async function speak(key, text, voice) {
  const model = VOICES[voice] ?? voice;
  const url = `https://api.deepgram.com/v1/speak?model=${model}&encoding=linear16&sample_rate=${RATE}&container=none`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { method: "POST", headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (res.status === 429 && attempt < 4) { await new Promise(r => setTimeout(r, 5000 * attempt)); continue; }
    throw new Error(`Deepgram TTS ${res.status} for ${model}: ${await res.text()}`);
  }
}

export const wavPath = name => path.join(OUT, `${name}.wav`);

export async function makeWavs(names, { force = false } = {}) {
  const scenarios = loadScenarios();
  const key = readEnv().DEEPGRAM_API_KEY;
  if (!key) throw new Error("DEEPGRAM_API_KEY missing from agent-worker/.env");
  fs.mkdirSync(OUT, { recursive: true });
  for (const name of names) {
    const sc = scenarios[name];
    if (!sc) throw new Error(`no scenario ${name}`);
    const lead = sc.lead ?? LEAD_S;
    const hash = crypto.createHash("sha1").update(JSON.stringify([VOICES, lead, sc.voice, sc.lines])).digest("hex");
    const stamp = `${wavPath(name)}.key`;
    if (!force && fs.existsSync(wavPath(name)) && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === hash) continue;
    const parts = [silence(lead)];
    for (const [text, pause, voice] of sc.lines) {
      if (text) parts.push(await speak(key, text, voice ?? sc.voice));
      parts.push(silence(pause));
    }
    const pcm = Buffer.concat(parts);
    fs.writeFileSync(wavPath(name), Buffer.concat([wavHeader(pcm.length), pcm]));
    fs.writeFileSync(stamp, hash);
    console.log(`wav ${name}: ${(pcm.length / 2 / RATE).toFixed(1)}s`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const names = args.filter(a => !a.startsWith("--"));
  await makeWavs(names.length ? names : Object.keys(loadScenarios()), { force: args.includes("--force") });
}
