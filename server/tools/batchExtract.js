"use strict";

/**
 * Batch-Extraktor: liest AUTOMATISCH alle Transporte der aktuell geladenen
 * Transporeon-Liste aus (kein Einzelklick durch den Nutzer) und rechnet fuer
 * jeden das Standgeld.
 *
 * Ablauf:
 *   1. node server/tools/batchExtract.js [--excel=Pfad] [--from=13.07.] [--to=16.07.] [--year=2026]
 *   2. Im Browser einloggen, in "Zugewiesene Transporte" den gewuenschten
 *      Datumsbereich filtern (z.B. gestern) und die Liste laden.
 *   3. Enter druecken -> das Tool geht JEDEN Transport der Liste durch:
 *      Zeile waehlen -> Tab "Event Management" -> Grid parsen -> naechster.
 *      Ergebnis: data/captures/batch_billing.json + Tabelle in der Konsole.
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

const TN_RE = /^[0-9A-Z]{2}_\d{8}_\d{10}$/;
const NUMBER_CELL = 'td[class*="gxColumn-number"] div.taMJE';
const VISIBILITY_TAB = "li.transportTransportVisibilityTab";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Liefert die aktuell im Grid-Header angezeigte Transportnummer (offenes Detail).
 */
async function currentHeader(frame) {
  try {
    return await frame.evaluate(() => {
      const m =
        document.body &&
        document.body.innerText.match(/Transportnr\.?:\s*([0-9A-Z_]+)/);
      return m ? m[1] : null;
    });
  } catch {
    return null;
  }
}

/**
 * Sammelt alle eindeutigen, echten Transportnummern der geladenen Liste.
 */
async function collectTransportNumbers(frame) {
  return frame.evaluate((patSource) => {
    const re = new RegExp(patSource);
    const seen = [];
    document
      .querySelectorAll('td[class*="gxColumn-number"] div.taMJE')
      .forEach((el) => {
        const t = (el.textContent || "").trim();
        if (re.test(t) && !seen.includes(t)) seen.push(t);
      });
    return seen;
  }, TN_RE.source);
}

/**
 * Oeffnet das Event-Management-Grid fuer eine Transportnummer und gibt die
 * geparsten Events zurueck. Wirft bei Timeout.
 */
async function openAndParse(page, frame, tn) {
  const cell = frame
    .locator(NUMBER_CELL, { hasText: new RegExp("^" + tn + "$") })
    .first();
  await cell.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await cell.click({ timeout: 5000, force: true });
  await sleep(300);

  // Detail ggf. erst oeffnen (Doppelklick), falls Tab noch nicht existiert.
  if ((await frame.locator(VISIBILITY_TAB).count()) === 0) {
    await cell.dblclick({ timeout: 5000, force: true }).catch(() => {});
    await sleep(500);
  }
  await frame
    .locator(VISIBILITY_TAB)
    .first()
    .click({ timeout: 5000, force: true })
    .catch(() => {});

  // Warten bis der Header auf diese Transportnummer umgestellt hat.
  let header = null;
  for (let i = 0; i < 25; i++) {
    header = await currentHeader(frame);
    if (header === tn) break;
    await sleep(300);
  }
  if (header !== tn) {
    throw new Error(`Header-Timeout (gelesen: ${header})`);
  }

  const html = await frame.content();
  return parseEventGrid(html);
}

/**
 * Findet den Frame mit der Transportliste (gxColumn-number vorhanden).
 */
async function findListFrame(context) {
  for (const pg of context.pages()) {
    for (const frame of pg.frames()) {
      try {
        const has = await frame.evaluate(
          () => !!document.querySelector('td[class*="gxColumn-number"]'),
        );
        if (has) return { page: pg, frame };
      } catch {
        /* ignore */
      }
    }
  }
  return null;
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
      /* Antwort nicht lesbar -> Excel bleibt Fallback. */
    }
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(START_URL, { waitUntil: "domcontentloaded" }).catch(() => {});

  console.log("\n--- Batch-Extraktor bereit ---");
  console.log(
    "1) Einloggen und in 'Zugewiesene Transporte' den Datumsbereich filtern.",
  );
  console.log(
    "2) Enter = ALLE Transporte der Liste auslesen | 'q' + Enter = beenden\n",
  );

  for (;;) {
    const answer = await waitForEnter(
      "\nEnter = alle auslesen | 'q' = beenden ... ",
    );
    if (answer.toLowerCase() === "q") break;

    const found = await findListFrame(context);
    if (!found) {
      console.log(
        "Keine Transportliste gefunden. Ist 'Zugewiesene Transporte' geladen?",
      );
      continue;
    }
    const { page: listPage, frame } = found;

    let tns = await collectTransportNumbers(frame);
    if (!tns.length) {
      console.log("Keine Transportnummern in der Liste gefunden.");
      continue;
    }
    const limit = args.limit ? Number(args.limit) : 0;
    if (limit > 0 && tns.length > limit) {
      console.log(
        `\n${tns.length} Transporte gefunden -> auf ${limit} begrenzt (--limit).`,
      );
      tns = tns.slice(0, limit);
    } else {
      console.log(`\n${tns.length} Transporte gefunden. Lese aus ...`);
    }

    const allEvents = [];
    const failures = [];
    let done = 0;
    for (const tn of tns) {
      try {
        const events = await openAndParse(listPage, frame, tn);
        for (const e of events) allEvents.push(e);
        done++;
        process.stdout.write(`\r  ${done}/${tns.length} (${tn}) `);
      } catch (err) {
        failures.push({ tn, error: String(err && err.message).slice(0, 60) });
      }
    }
    process.stdout.write("\n");

    const result = computeStandgeldFromEvents(allEvents, {
      excelIndex,
      transporeonWindows,
      range,
    });

    const outFile = path.join(OUT_DIR, "batch_billing.json");
    fs.writeFileSync(
      outFile,
      JSON.stringify(
        { transports_scanned: tns.length, failures, ...result },
        null,
        2,
      ),
      "utf8",
    );

    console.log(
      `\n=== Ergebnis (${tns.length} Transporte, ${failures.length} Fehler) ===`,
    );
    console.log(
      `Stopps: ${result.summary.stop_count} | im Zeitraum: ${result.summary.selected_count} | ` +
        `Prueffaelle: ${result.summary.review_count} | Summe: ${result.summary.total_fee_eur} EUR`,
    );
    for (const item of result.selected) {
      console.log(
        `  - ${item.transport_number} ${item.stop_type} ${item.local_date ?? "?"}: ` +
          `${item.counted_standing_minutes ?? "?"} min -> ${item.fee_eur} EUR ` +
          `(${item.reason}, Fenster ${item.window_source}${item.needs_review ? ", PRUEFEN" : ""})`,
      );
    }
    if (failures.length) {
      console.log(`\nNicht lesbar (${failures.length}):`);
      for (const f of failures) console.log(`  - ${f.tn}: ${f.error}`);
    }
    console.log(`\nDetails: ${outFile}`);
  }

  await context.close();
}

main().catch((err) => {
  console.error("Fehler:", err);
  process.exit(1);
});
