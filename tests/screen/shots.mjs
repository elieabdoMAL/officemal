// Layout screenshots of the full kiosk page (#3): captions, the Contact
// button and the cards, at the kiosk's landscape and portrait resolutions,
// with Mia's real face rendered by the worker. Run it before and after a
// layout change (the tunables live in src/lib/screenLayout.ts) and let the
// boss pick:
//
//   node tests/screen/shots.mjs --id u --port 3123 before
//   node tests/screen/shots.mjs --id u --port 3123 after
//
// Starts the worker (simli-worker:<id>, sandbox team mounted) and the site
// like tests/voice/run.mjs, opens the kiosk page with the tour's AIWEB frame
// rewritten to this site (every request to production blocked), waits for her
// session, and drives captions and cards through the embed's miaDev hook
// (dev builds only). Output: tests/screen/out/shots/<label>/<WxH>_<state>.png
//
// Needs the tour in public/3dvista (git-ignored; copy it from the main
// checkout) and Docker for the worker.
import fs from "fs";
import path from "path";
import { chromium } from "@playwright/test";
import { OUT, cleanup, ensureSite, ensureWorker, kioskPage, options, sleep, startMia } from "./lib.mjs";

const opts = options(process.argv.slice(2));
const label = opts.names[0] || "before";
const DIR = path.join(OUT, "shots", label);
fs.mkdirSync(DIR, { recursive: true });

const VIEWPORTS = [
  { width: 1920, height: 1080 }, // the kiosk, landscape
  { width: 1080, height: 1920 }, // in case the kiosk is vertical
];

// Realistic two-line captions (FR: it's a Québec lobby), long enough to show
// the clamped caption boxes at full size.
const VISITOR_LINE = "Où se trouve votre bureau exactement ? Est-ce que je peux passer vous voir aujourd'hui ?";
const MIA_LINE =
  "Nous sommes au soixante-quatorze, rue Turgeon à Sainte-Thérèse. Je peux aussi vous afficher l'itinéraire sur l'écran si vous voulez.";

const DIRECTIONS = {
  type: "directions",
  address: "74, rue Turgeon, Sainte-Thérèse (Québec)",
  maps_url: "https://www.google.com/maps/search/?api=1&query=74+rue+Turgeon+Sainte-Th%C3%A9r%C3%A8se+QC",
  lang: "fr",
};

async function captureViewport(browser, viewport) {
  const tag = `${viewport.width}x${viewport.height}`;
  console.log(`\n--- ${tag} ---`);
  const context = await browser.newContext({ viewport });
  const { page, prodHits } = await kioskPage(context, opts, (m) => console.log(`   [route] ${m}`));
  let micOpen = false;
  page.on("console", (m) => {
    if (m.text().includes("mic set -> true")) micOpen = true;
  });
  await page.goto(opts.site, { waitUntil: "domcontentloaded" });

  const frame = await startMia(page, opts);
  console.log(`   embed frame is local: ${frame.url()}`);
  await frame.waitForFunction(() => Boolean(window.miaDev), null, { timeout: 30000 });

  // Wait for the session: mic open means her greeting is over (up to the
  // greeting fallback), so her own captions are gone before we inject ours.
  const t0 = Date.now();
  while (!micOpen && Date.now() - t0 < 45000) await sleep(500);
  console.log(micOpen ? "   session ready (greeting over)" : "   mic never opened — screenshots may show 'Connecting…'");
  await sleep(4500); // her greeting caption fades

  const dev = (expr) => frame.evaluate(expr);
  const captions = async () => {
    await dev(`miaDev.caption("visitor", ${JSON.stringify(VISITOR_LINE)})`);
    await dev(`miaDev.caption("mia", ${JSON.stringify(MIA_LINE)})`);
  };
  const shot = async (state) => {
    const file = path.join(DIR, `${tag}_${state}.png`);
    await page.screenshot({ path: file });
    console.log(`   ${path.relative(process.cwd(), file)}`);
  };

  // 1. Both captions, no card: the spacing the boss commented on.
  await captions();
  await sleep(300);
  await shot("captions");

  // 2. The contact card (what the Contact button opens), captions still up.
  await dev(`miaDev.screen({ type: "contact_card" })`);
  await captions();
  await sleep(600); // QR image
  await shot("contact");

  // 3. The directions card (#7) — skipped while the screen can't draw it yet
  //    (parseScreenMessage returns null on unknown types: the "before" run).
  const drawn = await dev(`Boolean(miaDev.screen(${JSON.stringify(DIRECTIONS)}))`);
  if (drawn) {
    await captions();
    await sleep(600); // QR render
    await shot("directions");
  } else {
    console.log("   directions card not drawn by this build — skipped");
  }

  // 4. The project request draft, the biggest card.
  await dev(`miaDev.screen({ type: "project_request", status: "draft", lang: "fr", fields: {
    name: "Ana Silva", company: "Pain Doré", email: "ana@paindore.ca", phone: "",
    description: "Une application de fidélité pour ma boulangerie", timeline: "D'ici trois mois", budget: "" } })`);
  await captions();
  await sleep(300);
  await shot("project");

  await dev(`miaDev.screen({ type: "dismiss" })`);
  await context.close();

  if (prodHits.length) throw new Error(`requests reached for production (blocked): ${prodHits.join(", ")}`);
}

async function main() {
  await ensureWorker(opts);
  await ensureSite(opts);
  const browser = await chromium.launch({
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream", // silent fake mic: she hears nobody
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  try {
    for (const viewport of VIEWPORTS) {
      await captureViewport(browser, viewport);
      await sleep(8000); // let the worker see the last session end
    }
  } finally {
    await browser.close();
    cleanup(opts);
  }
  console.log(`\ndone: ${DIR}`);
}

main().catch((e) => {
  console.error(e);
  cleanup(opts);
  process.exit(1);
});
