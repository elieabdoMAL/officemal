// Shared bits of the voice-test kit: paths, keys, Docker names.
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

export const KIT = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(KIT, "..", "..");
export const OUT = path.join(KIT, "out"); // git-ignored: WAVs, recordings, reports
export const SANDBOX_EMAIL = "delivered@resend.dev";

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// The keys live only in the main checkout's agent-worker/.env. From a git
// worktree (which has no .env), find the main checkout through git.
export function envPath() {
  if (process.env.MIA_ENV) return process.env.MIA_ENV;
  const local = path.join(REPO, "agent-worker", ".env");
  if (fs.existsSync(local)) return local;
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: REPO }).toString().trim();
    const main = path.join(path.dirname(common), "agent-worker", ".env");
    if (fs.existsSync(main)) return main;
  } catch {}
  throw new Error("No agent-worker/.env found: set MIA_ENV to its path");
}

export function readEnv() {
  const env = {};
  for (const line of fs.readFileSync(envPath(), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

export function loadScenarios() {
  const all = JSON.parse(fs.readFileSync(path.join(KIT, "scenarios.json"), "utf8"));
  delete all._about;
  return all;
}

// --id t --port 3106: own agent name, container, image and port per chat, so
// parallel runs don't answer each other's rooms.
export function options(argv) {
  const opts = { id: process.env.MIA_E2E_ID || "e2e", port: Number(process.env.MIA_E2E_PORT || 3100), names: [], flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--id") opts.id = argv[++i];
    else if (a === "--port") opts.port = Number(argv[++i]);
    else if (a.startsWith("--")) opts.flags.add(a.slice(2));
    else opts.names.push(a);
  }
  opts.agent = `mia-${opts.id}`;
  opts.container = `mia-${opts.id}`;
  opts.image = process.env.MIA_IMAGE || `simli-worker:${opts.id}`;
  return opts;
}
