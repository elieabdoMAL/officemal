// Screen checks for #2 (press_button) and #7 (the directions card).
//
//   node tests/screen/run.mjs --id u --port 3123             # parts 1 and 2
//   node tests/screen/run.mjs --id u --port 3123 --livekit   # + part 3
//
// 1. The embed alone (/receptionist-embed, dev build): every press button via
//    miaDev — "contact" draws the contact card in the embed, the others are
//    forwarded to the top page as "receptionist-press"; unknown buttons and
//    bad directions are ignored; the directions card shows the address and a
//    client-side QR, closes on × and on its (shortened) timeout.
// 2. The full kiosk page — the tour, Controls, the modals — with every
//    request to production blocked and the AIWEB frame rewritten to this
//    site: a press injected in the embed frame actually opens each meeting
//    room, recenters the view (spied on blazeIT) and mutes/unmutes the kiosk.
// 3. --livekit: the worker running (simli-worker:<id>, sandbox team mounted),
//    a real session on the full page, and press + directions pushed through
//    the real LiveKit room with scripts/mia-screen-push.py — the same
//    send_text path the worker's press_button uses.
//
// Output: tests/screen/out/report.md (and screenshots of each state). Exit 0
// when every check passes. Needs public/3dvista (copy from the main checkout).
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { chromium } from "@playwright/test";
import {
  OUT, REPO, cleanup, dockerLogs, embedFrame, ensureSite, ensureWorker, envPath, kioskPage, options, sleep, startMia,
} from "./lib.mjs";

const opts = options(process.argv.slice(2));
fs.mkdirSync(OUT, { recursive: true });

const DIRECTIONS = {
  type: "directions",
  address: "74, rue Turgeon, Sainte-Thérèse (Québec)",
  maps_url: "https://www.google.com/maps/search/?api=1&query=74+rue+Turgeon+Sainte-Th%C3%A9r%C3%A8se+QC",
  lang: "fr",
};
const FORWARDED = ["mute", "unmute", "vr", "recenter", "meeting_room", "public_meeting"];

const report = [];
const failures = [];
let section = "";
function step(text) {
  section = text;
  console.log(`\n--- ${text}`);
  report.push(`\n**${text}**`);
}
function check(ok, what) {
  console.log(`   ${ok ? "✓" : "✗"} ${what}`);
  report.push(`- ${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures.push(`${section}: ${what}`);
  return ok;
}
async function shot(page, name) {
  try {
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  } catch {}
}

// --- part 1: the embed alone -------------------------------------------------
async function embedAlone(browser) {
  step("embed alone: presses and the directions card through miaDev");
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  // Collect what the embed forwards to its top page (standalone: itself).
  await page.addInitScript(() => {
    window.__presses = [];
    window.addEventListener("message", (e) => {
      if (e.data?.type === "receptionist-press") window.__presses.push(e.data.button);
    });
  });
  await page.goto(`${opts.site}/receptionist-embed?cardMs=1500`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.miaDev), null, { timeout: 30000 });

  // contact: drawn in the embed, never forwarded.
  await page.evaluate(() => window.miaDev.screen({ type: "press", button: "contact" }));
  const contactCard = page.locator('[role="dialog"][aria-label="Mobile Apps Labs"]');
  check(await contactCard.isVisible().catch(() => false), "press contact draws the contact card in the embed");
  await shot(page, "embed_press_contact");
  await page.evaluate(() => window.miaDev.screen({ type: "dismiss" }));

  // The others: forwarded as receptionist-press, exactly once each.
  for (const button of FORWARDED) {
    await page.evaluate((b) => window.miaDev.screen({ type: "press", button: b }), button);
  }
  await sleep(500);
  const presses = await page.evaluate(() => window.__presses);
  check(
    JSON.stringify(presses) === JSON.stringify(FORWARDED),
    `every other press is forwarded to the top page in order (got: ${presses.join(", ") || "none"})`
  );
  check(!presses.includes("contact"), "contact was not forwarded");

  // Unknown buttons and malformed messages are ignored.
  const refused = await page.evaluate(() => [
    window.miaDev.screen({ type: "press", button: "self_destruct" }),
    window.miaDev.screen({ type: "press" }),
    window.miaDev.screen({ type: "directions", address: "74 Turgeon", maps_url: "http://insecure.example" }),
    window.miaDev.screen({ type: "directions", maps_url: "https://maps.google.com/x" }),
  ]);
  check(refused.every((r) => r === null), "unknown button, missing button, http maps_url and missing address are all refused");

  // The directions card (#7).
  const drew = await page.evaluate((m) => Boolean(window.miaDev.screen(m)), DIRECTIONS);
  check(drew, "directions message accepted");
  const card = page.locator('[data-card="directions"]');
  check(await card.isVisible().catch(() => false), "directions card is up");
  check((await card.textContent() ?? "").includes(DIRECTIONS.address), "it shows the address");
  check((await card.textContent() ?? "").includes("Scannez pour l'itinéraire"), "it says Scannez pour l'itinéraire (lang fr)");
  const qr = card.locator('img[alt^="QR:"]');
  await qr.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  const qrOk = await qr.evaluate((el) => el.complete && el.naturalWidth >= 64 && el.src.startsWith("data:image/")).catch(() => false);
  check(qrOk, "the QR is generated client-side (data: URL, rendered)");
  await shot(page, "embed_directions");
  await card.locator('button[aria-label]').click();
  check(await card.isHidden().catch(() => true), "× closes it");

  // And the (dev-shortened) 45 s timeout.
  await page.evaluate((m) => window.miaDev.screen(m), DIRECTIONS);
  await sleep(2500); // cardMs=1500 from the URL
  check(await card.isHidden().catch(() => true), "it closes by itself (devTimeout cardMs)");

  // English labels.
  await page.evaluate((m) => window.miaDev.screen({ ...m, lang: "en" }), DIRECTIONS);
  check((await card.textContent() ?? "").includes("Scan for directions"), 'lang en says "Scan for directions"');
  await page.evaluate(() => window.miaDev.screen({ type: "dismiss" }));

  // The recording card (#5, round 2): on shows it, off removes it (and only it).
  const recDrew = await page.evaluate(() => [
    Boolean(window.miaDev.screen({ type: "recording", status: "on", lang: "en" })),
    window.miaDev.screen({ type: "recording", status: "paused" }),
  ]);
  check(recDrew[0] && recDrew[1] === null, "recording on accepted, unknown status refused");
  const rec = page.locator('[data-card="recording"]');
  check(await rec.isVisible().catch(() => false), "recording card is up");
  check((await rec.textContent() ?? "").includes("Say “done” when you're finished"), "it says how to finish (lang en)");
  check((await rec.locator("button").count()) === 0, "no × on it: it is a state, not content");
  await shot(page, "embed_recording");
  await page.evaluate(() => window.miaDev.screen({ type: "recording", status: "off" }));
  check(await rec.isHidden().catch(() => true), "recording off removes it");
  await page.evaluate((m) => window.miaDev.screen(m), DIRECTIONS);
  await page.evaluate(() => window.miaDev.screen({ type: "recording", status: "off" }));
  check(await card.isVisible().catch(() => false), "a stray off never closes another card");
  await page.evaluate(() => window.miaDev.screen({ type: "dismiss" }));

  await context.close();
}

// --- part 2: the full kiosk page ---------------------------------------------
async function fullPage(browser) {
  step("full kiosk page: a press triggers the real action (production blocked)");
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  // The private meeting room is an external Jitsi iframe: keep the test off
  // the network (and off anyone's real meeting).
  await context.route("https://meet.jit.si/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<title>jitsi blocked in test</title>" })
  );
  const { page, prodHits } = await kioskPage(context, opts, (m) => console.log(`   [route] ${m}`));
  await page.goto(opts.site, { waitUntil: "domcontentloaded" });
  const frame = await startMia(page, opts);
  check(frame.url().startsWith(`${opts.site}/receptionist-embed`), `AIWEB frame is the local embed (${frame.url()})`);
  await frame.waitForFunction(() => Boolean(window.miaDev), null, { timeout: 30000 });

  // Spy on the tour's blazeIT, where Controls lands its recenter/VR/mute taps.
  const tour = page.frames().find((f) => f.url().includes("/3dvista/"));
  const spied = tour
    ? await tour.evaluate(() => {
        if (!window.blazeIT?.triggerComponentByName) return false;
        const orig = window.blazeIT.triggerComponentByName.bind(window.blazeIT);
        window.__trig = [];
        window.blazeIT.triggerComponentByName = (name, ev) => {
          window.__trig.push(name);
          return orig(name, ev);
        };
        return true;
      }).catch(() => false)
    : false;

  const press = (b) => frame.evaluate((btn) => window.miaDev.screen({ type: "press", button: btn }), b);

  // meeting_room: the same pop-up as the tour's hotspot.
  await press("meeting_room");
  const meeting = page.locator('h2:has-text("Meeting Room")').first();
  await meeting.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  check(await meeting.isVisible().catch(() => false), "press meeting_room opens the Meeting Room pop-up");
  await shot(page, "page_press_meeting_room");
  await page.getByTitle("Close meeting room").click().catch(() => {});
  await sleep(300);

  // public_meeting.
  await press("public_meeting");
  const publicMeeting = page.locator('h2:has-text("Public Meeting Room")');
  await publicMeeting.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  check(await publicMeeting.isVisible().catch(() => false), "press public_meeting opens the Public Meeting Room pop-up");
  await shot(page, "page_press_public_meeting");
  await page.getByTitle("Leave and close").click().catch(() => {});
  await sleep(300);

  // recenter: lands on the tour's RecenterHotspot.
  await press("recenter");
  await sleep(300);
  if (spied) {
    const trig = await tour.evaluate(() => window.__trig);
    check(trig.includes("RecenterHotspot"), `press recenter triggers RecenterHotspot (blazeIT saw: ${trig.join(", ") || "nothing"})`);
  } else {
    check(false, "recenter: could not spy on the tour's blazeIT");
  }

  // mute / unmute: Controls' own state follows, and the embed is told.
  await press("mute");
  await sleep(300);
  check(await page.getByTitle("Unmute Audio").isVisible().catch(() => false), "press mute mutes the kiosk (Controls shows Unmute)");
  await press("unmute");
  await sleep(300);
  check(await page.getByTitle("Mute Audio").isVisible().catch(() => false), "press unmute unmutes it again");

  // vr: Controls flips to VR mode and taps the tour's VRHotspot. The tour may
  // refuse VR in a headless browser; the press path is what's under test.
  await press("vr");
  await sleep(300);
  check(await page.getByTitle("Exit VR Mode").isVisible().catch(() => false), "press vr enters VR mode (Controls shows Exit VR)");
  if (spied) {
    const trig = await tour.evaluate(() => window.__trig);
    check(trig.includes("VRHotspot"), "the tour's VRHotspot was triggered");
  }

  check(prodHits.length === 0, `no request reached production (blocked: ${prodHits.length})`);
  await context.close();
}

// --- part 3: through a real LiveKit room --------------------------------------
async function throughLiveKit(browser) {
  step("through LiveKit: worker session, press + directions pushed into the room");
  await ensureWorker(opts);
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const { page, prodHits } = await kioskPage(context, opts);
  let room = null;
  let micOpen = false;
  page.on("console", (m) => {
    const t = m.text();
    const match = t.match(/\[SimliLK\] in room (kiosk-\S+)/);
    if (match) room = match[1];
    if (t.includes("mic set -> true")) micOpen = true;
  });
  await page.goto(opts.site, { waitUntil: "domcontentloaded" });
  await startMia(page, opts);
  const t0 = Date.now();
  while ((!room || !micOpen) && Date.now() - t0 < 60000) await sleep(500);
  check(Boolean(room), `a session is in a room (${room ?? "none"})`);
  check(micOpen, "her greeting played and the mic opened (the worker answered)");

  if (room) {
    // Push through the real LiveKit room, as the worker's press_button does.
    const script = path.join(REPO, "scripts", "mia-screen-push.py");
    const args = [
      "run", "--rm", "--env-file", envPath(),
      "-v", `${path.dirname(script)}:/s`, "--entrypoint", "python", opts.image,
      "/s/mia-screen-push.py", room,
      JSON.stringify({ type: "press", button: "public_meeting" }),
      JSON.stringify(DIRECTIONS),
    ];
    const out = execFileSync("docker", args, { env: { ...process.env, MSYS_NO_PATHCONV: "1" } }).toString();
    console.log(out.trim().split("\n").map((l) => `   | ${l}`).join("\n"));

    const publicMeeting = page.locator('h2:has-text("Public Meeting Room")');
    await publicMeeting.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    check(await publicMeeting.isVisible().catch(() => false), "the press opened the Public Meeting Room on the kiosk");
    await shot(page, "livekit_press_public_meeting");
    await page.getByTitle("Leave and close").click().catch(() => {});

    const frame = await embedFrame(page, opts);
    const card = frame.locator('[data-card="directions"]');
    await card.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    check(await card.isVisible().catch(() => false), "the directions card arrived through the room");
    check((await card.textContent().catch(() => "")).includes(DIRECTIONS.address), "with the address");
    await shot(page, "livekit_directions");
  }
  check(prodHits.length === 0, "no request reached production");
  await context.close();
  await sleep(5000); // the worker sees the session end
  const logs = dockerLogs(opts.container, "--tail", "200");
  check(/screen control|registered worker/.test(logs), "worker logs reachable (for the record)");
}

// --- main ---------------------------------------------------------------------
async function main() {
  await ensureSite(opts);
  const browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  try {
    await embedAlone(browser);
    await fullPage(browser);
    if (opts.flags.has("livekit")) await throughLiveKit(browser);
  } finally {
    await browser.close();
    cleanup(opts);
  }
  const md = [`# Screen test run ${new Date().toISOString()}`, "", ...report, "", failures.length ? `## FAILURES\n${failures.map((f) => `- ${f}`).join("\n")}` : "All checks passed."];
  fs.writeFileSync(path.join(OUT, "report.md"), md.join("\n"));
  console.log(`\n${failures.length ? `FAIL (${failures.length})` : "PASS"} — report: ${path.join(OUT, "report.md")}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  cleanup(opts);
  process.exit(1);
});
