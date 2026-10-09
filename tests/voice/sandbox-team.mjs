// Writes out/team.sandbox.json: agent-worker/team.json with every email
// (members, general inbox) replaced by Resend's test inbox, so a test worker
// can never email a real person. Mount it over /app/team.json.
//
//   node tests/voice/sandbox-team.mjs        -> prints the file's path
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { OUT, REPO, SANDBOX_EMAIL } from "./lib.mjs";

export function writeSandboxTeam() {
  const team = JSON.parse(fs.readFileSync(path.join(REPO, "agent-worker", "team.json"), "utf8"));
  const swap = node => {
    if (Array.isArray(node)) return node.map(swap);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, /email/i.test(k) && typeof v === "string" ? SANDBOX_EMAIL : swap(v)]));
    }
    return node;
  };
  const sandbox = swap(team);
  const left = JSON.stringify(sandbox).match(/[\w.+-]+@[\w-]+\.[\w.]+/g)?.filter(e => e !== SANDBOX_EMAIL) ?? [];
  if (left.length) throw new Error(`sandbox team.json still has real addresses: ${left.join(", ")}`);
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, "team.sandbox.json");
  fs.writeFileSync(file, JSON.stringify(sandbox, null, 2));
  return file;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(writeSandboxTeam());
}
