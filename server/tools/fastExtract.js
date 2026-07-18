"use strict";

/**
 * Schneller Batch-Extraktor (Weg 2): liest ALLE Transporte eines Zeitfensters
 * ueber die Transporeon-Wire-API aus -- ohne jede Zeile einzeln anzuklicken.
 *
 * Ablauf:
 *   1. node server/tools/fastExtract.js [--excel=Pfad] [--limit=N] [--concurrency=8]
 *   2. Im Browser einloggen, in "Zugewiesene Transporte" den gewuenschten
 *      Datumsbereich filtern (z.B. gestern) und die Liste laden.
 *   3. Enter druecken -> das Tool:
 *        a) faengt Strong-Name/Endpoint/Account aus echten Requests ab,
 *        b) liest die komplette Transportliste (LoadPagedTransportListItemsAction),
 *        c) ruft LoadTransportVisibilityAction fuer JEDEN Transport PARALLEL ab,
 *        d) parst die Wire-Antworten und rechnet das Standgeld.
 *
 * Robustheit: Strong-Name, Endpoint, Account und die Request-Templates werden
 * LIVE aus echten Requests uebernommen (aendern sich pro App-Version). Es werden
 * keine Zugangsdaten gespeichert. Profil + Ausgaben liegen in gitignore-Pfaden.
 */

const path = require("node:path");
const fs = require("node:fs");
const readline = require("node:readline");
const { chromium } = require("playwright");

const { parseVisibilityResponse } = require("../normalize/gwtVisibility");
const { parseTransportList } = require("../normalize/gwtTransportList");
const { computeStandgeldFromEvents } = require("../normalize/pipeline");
const { parseBookingsResponse } = require("../normalize/bookings");
const { bookingsToWindowMap } = require("../normalize/transporeonWindows");
const {
  parseTransporeonExport,
  exportToWindowMap,
} = require("../normalize/transporeonExport");
const { loadZeitfenster } = require("./readZeitfensterExcel");

const PROFILE_DIR = path.join(process.cwd(), ".pw-profile");
const OUT_DIR = path.join(process.cwd(), "data", "captures");
const START_URL =
  "https://login.transporeon.com/?locale=de&return=AssignedTransportsCarrier";

const DISPATCH_RE = /\/taweb\/ta\/dispatch(\?|$)/;
const REFRESH_BUTTON = ".toolbarButton_refresh";
const EXPORT_BUTTON = "#exportToExcel, .toolbarButton_exportToExcel";
const EXPORTER_RE = /\/taweb\/exporter(\?|$)/;
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
 * Setzt in einem Visibility-Request-Template die transportId (Base64-Long) neu.
 *
 * Muster im Payload: ...|7|<BASE64-ID>|8|<ACCOUNT>|0|9|...
 *
 * @param {string} template - echter LoadTransportVisibilityAction-reqBody
 * @param {string} b64Id
 * @returns {string}
 */
function withTransportId(template, b64Id) {
  return template.replace(
    /(\|7\|)[A-Za-z0-9$_]+(\|8\|\d+\|)/,
    (_, a, b) => a + b64Id + b,
  );
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

/**
 * Loest den Transporeon-EIGENEN Excel-Export aus ("Nach Excel exportieren") und
 * liefert die geparsten Transporte. Weil der Button-Submit als Datei-Download in
 * ein iframe geht (bricht in Playwright ab), wird die abgefangene Export-Anfrage
 * per fetch im Seitenkontext (mit Session-Cookies) erneut gesendet und die
 * XLSX-Bytes werden als Base64 zurueckgeholt.
 *
 * Der Export ist die ZUVERLAESSIGE Fensterquelle fuer ALLE Transporte (volles
 * Datum, Lade- und Entladefenster). Ist-Ankunft/Abfahrt im Export sind TP-XP;
 * die beweisbaren GPS-Zeiten kommen weiterhin aus der Visibility-Abfrage.
 *
 * @param {import('playwright').Page} page
 * @param {import('playwright').Frame} frame
 * @returns {Promise<Array<object>|null>} parseTransporeonExport()-Ergebnis
 */
async function downloadExport(page, frame) {
  let postData = null;
  const handler = (req) => {
    if (EXPORTER_RE.test(req.url())) postData = req.postData();
  };
  page.on("request", handler);
  await frame
    .evaluate((sel) => {
      const b = document.querySelector(sel);
      if (b)
        for (const type of ["mousedown", "mouseup", "click"])
          b.dispatchEvent(
            new MouseEvent(type, { bubbles: true, cancelable: true }),
          );
    }, EXPORT_BUTTON)
    .catch(() => {});
  for (let i = 0; i < 25 && !postData; i++) await sleep(300);
  page.off("request", handler);
  if (!postData) return null;

  const out = await frame.evaluate(async (pd) => {
    const res = await fetch("/taweb/exporter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: pd,
      credentials: "include",
    });
    if (!res.ok) return { ok: false, status: res.status };
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return { ok: true, b64: btoa(bin) };
  }, postData);
  if (!out || !out.ok) return null;

  const XLSX = require("xlsx");
  const wb = XLSX.read(Buffer.from(out.b64, "base64"), { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    raw: false,
    defval: "",
  });
  return parseTransporeonExport(rows);
}

/**
 * Fuehrt alle Visibility-Requests im Seitenkontext PARALLEL aus (Cookies +
 * Strong-Name automatisch). Gibt je transportId den rohen Antworttext zurueck.
 *
 * @param {import('playwright').Page} page
 * @param {{ endpoint:string, moduleBase:string, strongName:string,
 *   template:string }} api
 * @param {Array<{transportNumber:string, transportIdB64:string}>} rows
 * @param {number} concurrency
 * @returns {Promise<Array<{transportNumber:string, ok:boolean, text?:string, error?:string}>>}
 */
async function fetchVisibilities(page, api, rows, concurrency) {
  const jobs = rows.map((r) => ({
    transportNumber: r.transportNumber,
    body: withTransportId(api.template, r.transportIdB64),
  }));

  return page.evaluate(
    async ({ endpoint, moduleBase, strongName, jobs, concurrency }) => {
      const results = new Array(jobs.length);
      let next = 0;
      async function worker() {
        for (;;) {
          const i = next++;
          if (i >= jobs.length) return;
          const job = jobs[i];
          try {
            const resp = await fetch(endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "text/x-gwt-rpc; charset=UTF-8",
                "X-GWT-Permutation": strongName,
                "X-GWT-Module-Base": moduleBase,
              },
              body: job.body,
              credentials: "include",
            });
            const text = await resp.text();
            results[i] = {
              transportNumber: job.transportNumber,
              ok: resp.ok && text.startsWith("//OK"),
              text,
            };
          } catch (e) {
            results[i] = {
              transportNumber: job.transportNumber,
              ok: false,
              error: String(e && e.message),
            };
          }
        }
      }
      const n = Math.max(1, Math.min(concurrency, jobs.length));
      await Promise.all(Array.from({ length: n }, worker));
      return results;
    },
    {
      endpoint: api.endpoint,
      moduleBase: api.moduleBase,
      strongName: api.strongName,
      jobs,
      concurrency,
    },
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const concurrency = args.concurrency ? Number(args.concurrency) : 8;

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

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1600, height: 950 },
    locale: "de-DE",
  });

  // Live-Erfassung der Wire-Templates (Strong-Name/Endpoint/Account) + Fenster.
  const captured = { list: null, visibility: null };
  const transporeonWindows = new Map();

  context.on("response", async (response) => {
    const url = response.url();
    if (/GetBookingsWithoutOccupied/i.test(url)) {
      try {
        const json = await response.json();
        const { bookings } = parseBookingsResponse(json);
        const map = bookingsToWindowMap(bookings);
        for (const [key, value] of map) transporeonWindows.set(key, value);
      } catch {
        /* Excel bleibt Fallback. */
      }
      return;
    }
    if (!DISPATCH_RE.test(url)) return;
    try {
      const req = response.request();
      const reqBody = req.postData() || "";
      if (reqBody.includes("LoadPagedTransportListItemsAction")) {
        captured.list = { url, reqBody, text: await response.text() };
      } else if (reqBody.includes("LoadTransportVisibilityAction")) {
        if (!captured.visibility) {
          captured.visibility = { url, reqBody, text: await response.text() };
        }
      }
    } catch {
      /* ignore */
    }
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(START_URL, { waitUntil: "domcontentloaded" }).catch(() => {});

  console.log("\n--- Schneller Extraktor (Weg 2) bereit ---");
  console.log(
    "1) Einloggen und in 'Zugewiesene Transporte' den Datumsbereich filtern.",
  );
  console.log("2) Enter = alle Transporte auslesen | 'q' + Enter = beenden\n");

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

    // 1) Frische Listen-Antwort erzwingen (Refresh) -> captured.list.
    captured.list = null;
    await frame
      .evaluate((sel) => {
        const b = document.querySelector(sel);
        if (b)
          for (const type of ["mousedown", "mouseup", "click"])
            b.dispatchEvent(
              new MouseEvent(type, { bubbles: true, cancelable: true }),
            );
      }, REFRESH_BUTTON)
      .catch(() => {});
    for (let i = 0; i < 30 && !captured.list; i++) await sleep(300);
    if (!captured.list) {
      console.log("Konnte die Transportliste nicht abrufen (Refresh).");
      continue;
    }

    // 2) Transportnummer -> transportId aus der Listen-Antwort.
    //    WICHTIG (Nutzerregel): KEIN Transport darf untergehen. Transporte ohne
    //    transportId werden NICHT verworfen, sondern als Prueffall gefuehrt.
    let allRows;
    try {
      allRows = parseTransportList(captured.list.text);
    } catch (err) {
      console.log("Listen-Antwort nicht lesbar:", String(err && err.message));
      continue;
    }
    if (!allRows.length) {
      console.log("Keine Transporte in der Liste gefunden.");
      continue;
    }
    const rowsNoId = allRows.filter((r) => !r.transportIdB64);
    let rows = allRows.filter((r) => r.transportIdB64);
    const limit = args.limit ? Number(args.limit) : 0;
    if (limit > 0 && rows.length > limit) rows = rows.slice(0, limit);
    console.log(
      `\n${allRows.length} Transporte in der Liste` +
        (rowsNoId.length
          ? ` (davon ${rowsNoId.length} ohne transportId -> Prueffall)`
          : "") +
        `. Rufe ${rows.length} per Sichtbarkeit ab.`,
    );

    // 2b) Zeitfenster fuer ALLE Transporte aus dem Transporeon-Export holen
    //     (zuverlaessige Quelle, volles Datum, Lade- UND Entladefenster).
    try {
      const exported = await downloadExport(listPage, frame);
      if (exported && exported.length) {
        const winMap = exportToWindowMap(exported);
        for (const [key, value] of winMap) transporeonWindows.set(key, value);
        console.log(
          `Export-Fenster geladen: ${exported.length} Transporte, ${winMap.size} Fenster.`,
        );
      } else {
        console.log(
          "Export-Fenster nicht verfuegbar (nutze Booking/Excel-Fallback).",
        );
      }
    } catch (err) {
      console.log("Export fehlgeschlagen:", String(err && err.message));
    }

    // 3) Visibility-Template sicherstellen: einen Transport oeffnen.
    if (!captured.visibility) {
      console.log("Ermittle Visibility-Template (oeffne einen Transport) ...");
      await frame
        .evaluate(
          async ({ cellSel, tabSel }) => {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const cell = document.querySelector(cellSel);
            if (cell) {
              const td = cell.closest("td");
              for (const type of ["mousedown", "mouseup", "click"])
                td.dispatchEvent(
                  new MouseEvent(type, { bubbles: true, cancelable: true }),
                );
              await sleep(400);
              const tab = document.querySelector(tabSel);
              if (tab)
                for (const type of ["mousedown", "mouseup", "click"])
                  tab.dispatchEvent(
                    new MouseEvent(type, { bubbles: true, cancelable: true }),
                  );
            }
          },
          { cellSel: NUMBER_CELL, tabSel: VISIBILITY_TAB },
        )
        .catch(() => {});
      for (let i = 0; i < 20 && !captured.visibility; i++) await sleep(300);
    }
    if (!captured.visibility) {
      console.log(
        "Kein Visibility-Template erhalten. Bitte einen Transport manuell oeffnen und erneut Enter.",
      );
      continue;
    }

    // 4) API-Parameter aus dem echten Request ableiten.
    const parts = captured.visibility.reqBody.split("|");
    const api = {
      endpoint: captured.visibility.url,
      moduleBase: parts[3],
      strongName: parts[4],
      template: captured.visibility.reqBody,
    };

    // 5) Alle Visibility-Antworten PARALLEL abrufen.
    console.log(
      `Rufe Sichtbarkeitsdaten ab (Parallelitaet ${concurrency}) ...`,
    );
    const t0 = Date.now();
    const responses = await fetchVisibilities(listPage, api, rows, concurrency);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    // 6) Parsen -> Events.
    const allEvents = [];
    const failures = [];
    for (const res of responses) {
      if (!res.ok) {
        failures.push({ tn: res.transportNumber, error: res.error || "HTTP" });
        continue;
      }
      try {
        const events = parseVisibilityResponse(res.text, {
          transportNumber: res.transportNumber,
        });
        for (const e of events) allEvents.push(e);
      } catch (err) {
        failures.push({
          tn: res.transportNumber,
          error: String(err && err.message).slice(0, 60),
        });
      }
    }
    console.log(
      `${rows.length} Transporte in ${secs}s abgerufen, ${allEvents.length} Events, ${failures.length} Fehler.`,
    );

    // 7) Standgeld rechnen.
    const result = computeStandgeldFromEvents(allEvents, {
      excelIndex,
      transporeonWindows,
    });

    // 7b) Lueckenlose Abdeckung: JEDER Transport der Liste muss auftauchen.
    //     Transporte ohne verwertbare Events werden als Prueffall gefuehrt.
    const seenTns = new Set(allEvents.map((e) => e.transport_number));
    const failedTns = new Set(failures.map((f) => f.tn));
    const uncovered = allRows
      .filter((r) => !seenTns.has(r.transportNumber))
      .map((r) => ({
        transport_number: r.transportNumber,
        reason: !r.transportIdB64
          ? "keine transportId in Liste"
          : failedTns.has(r.transportNumber)
            ? "Sichtbarkeit nicht abrufbar/lesbar"
            : "keine Sichtbarkeits-Events",
        needs_review: true,
      }));
    const totalReview = result.summary.review_count + uncovered.length;

    const outFile = path.join(OUT_DIR, "fast_billing.json");
    fs.writeFileSync(
      outFile,
      JSON.stringify(
        {
          transports_in_list: allRows.length,
          transports_fetched: rows.length,
          transports_without_id: rowsNoId.length,
          transports_uncovered: uncovered.length,
          review_total: totalReview,
          duration_seconds: Number(secs),
          failures,
          uncovered_transports: uncovered,
          mapping: allRows,
          ...result,
        },
        null,
        2,
      ),
      "utf8",
    );

    console.log(
      `\n=== Ergebnis (${allRows.length} Transporte in der Liste) ===`,
    );
    console.log(
      `Abgerufen: ${rows.length} | Events: ${allEvents.length} | ` +
        `Stopps: ${result.summary.stop_count} | im Zeitraum: ${result.summary.selected_count} | ` +
        `Prueffaelle gesamt: ${totalReview} (davon ${uncovered.length} ohne Daten) | ` +
        `Summe: ${result.summary.total_fee_eur} EUR`,
    );
    for (const item of result.selected) {
      console.log(
        `  - ${item.transport_number} ${item.stop_type} ${item.local_date ?? "?"}: ` +
          `${item.counted_standing_minutes ?? "?"} min -> ${item.fee_eur} EUR ` +
          `(${item.reason}, Fenster ${item.window_source}${item.needs_review ? ", PRUEFEN" : ""})`,
      );
    }
    if (uncovered.length) {
      console.log(
        `\nOhne verwertbare Daten (${uncovered.length}) -> PRUEFEN, nicht verloren:`,
      );
      for (const u of uncovered.slice(0, 30))
        console.log(`  - ${u.transport_number}: ${u.reason}`);
      if (uncovered.length > 30)
        console.log(`  ... und ${uncovered.length - 30} weitere (siehe JSON).`);
    }
    if (failures.length) {
      console.log(`\nHTTP/Parse-Fehler (${failures.length}):`);
      for (const f of failures.slice(0, 20))
        console.log(`  - ${f.tn}: ${f.error}`);
    }
    console.log(`\nDetails: ${outFile}`);
  }

  await context.close();
}

main().catch((err) => {
  console.error("Fehler:", err);
  process.exit(1);
});
