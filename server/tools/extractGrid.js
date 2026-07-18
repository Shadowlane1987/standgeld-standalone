"use strict";

/**
 * Live-Extraktor: liest das Transporeon Event-Grid aus dem laufenden Browser
 * (persistentes Profil .pw-profile) und rechnet direkt das Standgeld.
 *
 * Ablauf:
 *   1. node server/tools/extractGrid.js [--excel=Pfad] [--from=13.07.] [--to=16.07.] [--year=2026]
 *   2. Im geoeffneten Browser einloggen und das Event-/Sichtbarkeits-Grid eines
 *      Transports anzeigen.
 *   3. Enter druecken -> Grid aller Frames wird geparst, Standgeld berechnet und
 *      nach data/captures/billing.json geschrieben. 'q' + Enter beendet.
 *
 * Keine Zugangsdaten im Code. Profil + Ausgaben liegen in gitignore-Pfaden.
 */

const path = require("node:path");
const fs = require("node:fs");
const readline = require("node:readline");
const { chromium } = require("playwright");

const { parseEventGrid } = require("../normalize/eventGrid");
const { computeStandgeldFromEvents } = require("../normalize/pipeline");
const { parseBookingsResponse } = require("../normalize/bookings");
const { bookingsToWindowMap } = require("../normalize/transporeonWindows");
const { loadZeitfenster } = require("./readZeitfensterExcel");

const PROFILE_DIR = path.join(process.cwd(), ".pw-profile");
const OUT_DIR = path.join(process.cwd(), "data", "captures");
const START_URL =
  "https://login.transporeon.com/?locale=de&return=AssignedTransportsCarrier";

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

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

/**
 * Sammelt Events aus allen Frames aller Seiten. Der Frame mit den meisten
 * Events (Transportnr. im Kopf) gewinnt.
 */
async function collectEvents(context) {
  let best = { events: [], url: null };
  for (const pg of context.pages()) {
    for (const frame of pg.frames()) {
      let html = "";
      try {
        html = await frame.content();
      } catch {
        continue;
      }
      const events = parseEventGrid(html);
      if (events.length > best.events.length) {
        best = { events, url: frame.url() };
      }
    }
  }
  return best;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let excelIndex;
  if (args.excel) {
    try {
      excelIndex = loadZeitfenster(args.excel).index;
      console.log(
        `Excel-Fensterliste geladen: ${excelIndex.size} Ladenummern.`,
      );
    } catch (err) {
      console.error(
        "Excel konnte nicht geladen werden:",
        String(err && err.message),
      );
    }
  }

  const range =
    args.from || args.to
      ? {
          from: args.from || null,
          to: args.to || null,
          year: args.year ? Number(args.year) : undefined,
        }
      : undefined;

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1600, height: 950 },
    locale: "de-DE",
  });

  // Transporeon-Ladefenster (primaer) live aus der Buchungslisten-Antwort
  // abgreifen. Nichts wird gespeichert ausser dem abgeleiteten Fenster.
  const transporeonWindows = new Map();
  context.on("response", async (response) => {
    if (!/GetBookingsWithoutOccupied/i.test(response.url())) return;
    try {
      const json = await response.json();
      const { bookings } = parseBookingsResponse(json);
      const map = bookingsToWindowMap(bookings);
      for (const [key, value] of map) transporeonWindows.set(key, value);
      console.log(
        `Transporeon-Ladefenster erkannt: ${map.size} (gesamt ${transporeonWindows.size}).`,
      );
    } catch {
      /* Antwort nicht lesbar -> ignorieren, Excel bleibt Fallback. */
    }
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(START_URL, { waitUntil: "domcontentloaded" }).catch(() => {});

  console.log("\n--- Live-Extraktor bereit ---");
  console.log(
    "1) Einloggen (falls noetig) und das Event-Grid eines Transports oeffnen.",
  );
  console.log("2) Enter = auslesen + abrechnen | 'q' + Enter = beenden\n");

  for (;;) {
    const answer = await waitForEnter(
      "\nEnter = auslesen | 'q' = beenden ... ",
    );
    if (answer.toLowerCase() === "q") break;

    const { events, url } = await collectEvents(context);
    if (!events.length) {
      console.log("Keine Events gefunden. Ist das Grid sichtbar/geladen?");
      continue;
    }

    const result = computeStandgeldFromEvents(events, {
      excelIndex,
      transporeonWindows,
      range,
    });
    const outFile = path.join(OUT_DIR, "billing.json");
    fs.writeFileSync(
      outFile,
      JSON.stringify({ source_url: url, ...result }, null, 2),
      "utf8",
    );

    console.log(`\nGrid-Frame: ${url}`);
    console.log(
      `Events: ${result.event_count} | Stopps: ${result.stops.length}`,
    );
    console.log(
      `Abgerechnet: ${result.summary.selected_count}/${result.summary.stop_count} | ` +
        `Prueffaelle: ${result.summary.review_count} | ` +
        `Summe: ${result.summary.total_fee_eur} EUR`,
    );
    for (const item of result.selected) {
      console.log(
        `  - ${item.transport_number} ${item.stop_type} ${item.local_date ?? "?"}: ` +
          `${item.fee_eur} EUR (${item.reason}, Fenster ${item.window_source}` +
          `${item.needs_review ? ", PRUEFEN" : ""})`,
      );
    }
    console.log(`\nDetails: ${outFile}`);
  }

  await context.close();
}

main().catch((err) => {
  console.error("Fehler:", err);
  process.exit(1);
});
