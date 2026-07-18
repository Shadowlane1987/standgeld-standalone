"use strict";

/**
 * Transporeon Session-Launcher (lokal, interaktiv).
 *
 * Zweck: Einmaliger Login in einem automatisierten Chromium mit PERSISTENTEM
 * Profil. Die Session (Cookies) bleibt im Profilordner erhalten, sodass spaetere
 * Automatisierung ohne erneuten Login laeuft.
 *
 * Ablauf:
 *   1. node server/tools/pwSession.js
 *   2. Im geoeffneten Browser einloggen UND zu einem Transport mit
 *      "Event Management"/Sichtbarkeits-Grid navigieren.
 *   3. Im Terminal Enter druecken -> Skript speichert DOM-Snapshot + Screenshot
 *      aller offenen Seiten/Frames nach data/captures/ zur Analyse.
 *
 * Es werden KEINE Zugangsdaten im Code gespeichert. Profil + Snapshots liegen in
 * gitignore-Pfaden (.pw-profile/, data/).
 */

const path = require("node:path");
const fs = require("node:fs");
const readline = require("node:readline");
const { chromium } = require("playwright");

const PROFILE_DIR = path.join(process.cwd(), ".pw-profile");
const OUT_DIR = path.join(process.cwd(), "data", "captures");
const LOGIN_URL = "https://login.transporeon.com/";

function waitForEnter(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(message, (answer) => {
      rl.close();
      resolve(String(answer || "").trim());
    });
  });
}

async function dumpFrame(frame, tag) {
  try {
    const html = await frame.content();
    const file = path.join(OUT_DIR, `grid-${tag}.html`);
    fs.writeFileSync(file, html, "utf8");
    return { url: frame.url(), file, bytes: html.length };
  } catch (err) {
    return { url: frame.url(), error: String(err && err.message) };
  }
}

async function snapshot(context) {
  const report = [];
  const pages = context.pages();
  for (let p = 0; p < pages.length; p += 1) {
    const pg = pages[p];
    try {
      const shot = path.join(OUT_DIR, `page-${p}.png`);
      await pg.screenshot({ path: shot, fullPage: true });
      report.push({ page: p, screenshot: shot, url: pg.url() });
    } catch (err) {
      report.push({ page: p, screenshotError: String(err && err.message) });
    }
    // Haupt-Frame + alle Sub-Frames dumpen (GWT rendert oft in iframes)
    const frames = pg.frames();
    for (let f = 0; f < frames.length; f += 1) {
      const res = await dumpFrame(frames[f], `p${p}-f${f}`);
      report.push({ page: p, frame: f, ...res });
    }
  }

  fs.writeFileSync(
    path.join(OUT_DIR, "grid-report.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );

  console.log("\nSnapshot gespeichert:");
  for (const r of report) console.log(" ", JSON.stringify(r));
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1600, height: 950 },
    locale: "de-DE",
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" }).catch(() => {});

  console.log("\n--- Transporeon-Browser geoeffnet ---");
  console.log("1) Einloggen (falls noetig).");
  console.log(
    "2) Einen Transport oeffnen und das Event/Sichtbarkeits-Grid anzeigen.",
  );
  console.log("3) Danach hier im Terminal Enter druecken.\n");

  // Schleife: bei jedem Enter ein Snapshot, "q" beendet.
  for (;;) {
    const answer = await waitForEnter(
      "\nEnter = Snapshot | 'q' + Enter = beenden ... ",
    );
    if (answer.toLowerCase() === "q") break;
    await snapshot(context);
  }

  await context.close();
}

main().catch((err) => {
  console.error("Fehler:", err);
  process.exit(1);
});
