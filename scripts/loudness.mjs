// Loudness over time for a recording of Mia (or any voice), to check whether
// her level drops during a session (boss notes #4, #19).
//
//   node scripts/loudness.mjs <file.wav> [--json]
//
// Input: 16-bit PCM WAV, any sample rate (stereo is averaged to mono). For the
// voice kit's <name>_mia.webm recordings, decode first with the worker image's
// ffmpeg (Python and ffmpeg aren't installed on the dev PC):
//   MSYS_NO_PATHCONV=1 docker run --rm -v "<dir>":/d simli-worker:<x> \
//     ffmpeg -loglevel error -y -i /d/<name>_mia.webm -ac 1 -ar 48000 /d/<name>_mia.wav
//
// Prints:
//   - RMS per second (dBFS) as a strip: '.' silence, then 1-9 by level
//   - every utterance (speech separated by >= 0.6 s of silence) with its
//     active-speech level, i.e. the RMS of its 10 ms frames above the silence
//     gate, so pauses inside a reply don't pull its level down
//   - the trend of utterance levels (dB per minute, least squares) and the
//     first third vs the last third of the session
//   - utterances 3 dB or more below the session median ("dips")
// With --json, the same as JSON (seconds, dBFS) for further analysis.

import fs from "fs";

const GATE_DB = -45; // 10 ms frames quieter than this are silence
const GAP_S = 0.6; // silence that separates two utterances
const MIN_UTTERANCE_S = 0.3;
const DIP_DB = 3;

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error("usage: node scripts/loudness.mjs <file.wav> [--json]");
  process.exit(1);
}

function readWav(path) {
  const b = fs.readFileSync(path);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let off = 12, fmt = null;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4), size = b.readUInt32LE(off + 4), body = off + 8;
    if (id === "fmt ") fmt = { channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    if (id === "data") {
      if (!fmt || fmt.bits !== 16) throw new Error("only 16-bit PCM WAV is supported");
      // ffmpeg writing to a pipe leaves the data size at 0 or -1: take the rest.
      const end = size && size !== 0xffffffff ? Math.min(body + size, b.length) : b.length;
      const pcm = new Int16Array(b.buffer.slice(b.byteOffset + body, b.byteOffset + end - ((end - body) % 2)));
      const n = Math.floor(pcm.length / fmt.channels), mono = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let c = 0; c < fmt.channels; c++) s += pcm[i * fmt.channels + c];
        mono[i] = s / fmt.channels / 32768;
      }
      return { rate: fmt.rate, samples: mono };
    }
    off = body + size + (size % 2);
  }
  throw new Error("no data chunk");
}

const db = meanSquare => 10 * Math.log10(meanSquare + 1e-12);

const { rate, samples } = readWav(file);
const frame = Math.round(rate / 100);
const frames = []; // mean square per 10 ms
for (let i = 0; i + frame <= samples.length; i += frame) {
  let s = 0;
  for (let k = 0; k < frame; k++) s += samples[i + k] ** 2;
  frames.push(s / frame);
}
const duration = frames.length / 100;

// Per second: plain RMS (silence included) and active-speech RMS.
const perSecond = [];
for (let s = 0; s * 100 < frames.length; s++) {
  const f = frames.slice(s * 100, s * 100 + 100), on = f.filter(x => db(x) > GATE_DB);
  perSecond.push({
    t: s,
    rms: +db(f.reduce((a, x) => a + x, 0) / f.length).toFixed(1),
    active: on.length ? +db(on.reduce((a, x) => a + x, 0) / on.length).toFixed(1) : null,
  });
}

// Utterances: runs of active frames, merged across gaps shorter than GAP_S.
const utterances = [];
let start = -1, lastOn = -1;
const close = () => {
  if (start < 0 || (lastOn + 1 - start) / 100 < MIN_UTTERANCE_S) return;
  const on = frames.slice(start, lastOn + 1).filter(x => db(x) > GATE_DB);
  const peak = samples.subarray(start * frame, (lastOn + 1) * frame).reduce((a, x) => Math.max(a, Math.abs(x)), 0);
  utterances.push({
    start: +(start / 100).toFixed(2),
    end: +((lastOn + 1) / 100).toFixed(2),
    level: +db(on.reduce((a, x) => a + x, 0) / on.length).toFixed(1),
    peak: +(20 * Math.log10(peak + 1e-9)).toFixed(1),
  });
};
frames.forEach((x, i) => {
  if (db(x) <= GATE_DB) return;
  if (start >= 0 && (i - lastOn) / 100 >= GAP_S) { close(); start = -1; }
  if (start < 0) start = i;
  lastOn = i;
});
close();

const levels = utterances.map(u => u.level);
const median = levels.length ? [...levels].sort((a, b) => a - b)[Math.floor(levels.length / 2)] : null;
let slope = null;
if (utterances.length >= 3) {
  const xs = utterances.map(u => (u.start + u.end) / 2 / 60), mx = xs.reduce((a, x) => a + x, 0) / xs.length;
  const my = levels.reduce((a, y) => a + y, 0) / levels.length;
  slope = xs.reduce((a, x, i) => a + (x - mx) * (levels[i] - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0);
}
const third = duration / 3;
const avgIn = (from, to) => {
  const u = utterances.filter(x => x.start >= from && x.start < to);
  return u.length ? +(u.reduce((a, x) => a + x.level, 0) / u.length).toFixed(1) : null;
};
const summary = {
  file, duration: +duration.toFixed(1), utterances: utterances.length, medianLevel: median,
  trendDbPerMin: slope === null ? null : +slope.toFixed(2),
  firstThird: avgIn(0, third), lastThird: avgIn(2 * third, Infinity),
  dips: utterances.filter(u => median !== null && u.level <= median - DIP_DB),
};

if (flags.includes("--json")) {
  console.log(JSON.stringify({ summary, perSecond, utterances }, null, 1));
  process.exit(0);
}

const strip = perSecond.map(p => (p.active === null ? "." : String(Math.min(9, Math.max(1, Math.round((p.active + 45) / 4)))))).join("");
console.log(`${file}: ${summary.duration}s, ${utterances.length} utterances`);
console.log("\nActive level per second ('.' silence, 1 = -41 dBFS ... 9 = -9 dBFS, 4 dB per step), 60 s per row:");
for (let i = 0; i < strip.length; i += 60) console.log(`  ${String(i).padStart(4)}s ${strip.slice(i, i + 60)}`);
console.log("\nUtterances (start-end s, active-speech level, peak, dBFS):");
for (const u of utterances) {
  const mark = median !== null && u.level <= median - DIP_DB ? "  <- dip" : "";
  console.log(`  ${u.start.toFixed(1).padStart(6)}-${u.end.toFixed(1).padEnd(6)} ${u.level.toFixed(1).padStart(6)}  peak ${u.peak.toFixed(1)}${mark}`);
}
console.log(`\nMedian ${median} dBFS · trend ${summary.trendDbPerMin} dB/min · first third ${summary.firstThird} · last third ${summary.lastThird} · dips ${summary.dips.length}`);
