!/usr/bin/env node
"use strict";

/**
 * Echter Live-Abgleich: Wie viele Sixfold-Transportnummern matchen die
 * Transportnummern aus den Transporeon-Excel-Dateien?
 *
 * Das ist die Schluesselfrage vor der Sixfold-first-Umstellung: nur wenn die
 * Nummern zuverlaessig matchen, kann Sixfold die Basis sein, ohne Touren doppelt
 * zu zaehlen (sonst wird jede Sixfold-Tour faelschlich als "nur in Sixfold"
 * behandelt -> Summe explodiert).
 *
 * SICHERHEIT: Der Token wird NUR aus der Umgebungsvariable SIXFOLD_SESSION_TOKEN
 * gelesen. NIEMALS im Code hinterlegen. Setzen (PowerShell):
 *   $env:SIXFOLD_SESSION_TOKEN = "<dein token>"
 *   node compare-excel-sixfold.js
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const {
  loadTransporeonExport,
} = require("./server/tools/readTransporeonExport");
const {
  transportNumberToLadenummer,
} = require("./server/normalize/ladenummer");
const {
  normalizeTransportNumber,
} = require("./server/normalize/exportBilling");

const COMPANY_ID = "799";
const CAPTURES_DIR = path.join(__dirname, "data", "captures");

// --- Excel-Transportnummern aus allen vorhandenen Export-Dateien laden --------
function loadExcelTransportNumbers() {
  const files = fs
    .readdirSync(CAPTURES_DIR)
    .filter((f) => f.toLowerCase().endsWith(".xlsx"))
    .filter((f) => /transporte|export|standgeld/i.test(f));
  const tns = new Set();
  for (const f of files) {
    try {
      const transports = loadTransporeonExport(path.join(CAPTURES_DIR, f));
      for (const t of transports) {
        const tn = String(t?.transport_number || "").trim();
        if (tn) tns.add(tn);
      }
      console.log(`  ${f}: ${transports.length} Transporte`);
    } catch (err) {
      console.log(`  ${f}: uebersprungen (${err.message})`);
    }
  }
  return { files, tns: [...tns] };
}

// --- Sixfold-Transportnummern live abrufen (paginiert) ------------------------
async function fetchSixfoldTransportNumbers(sessionCookie) {
  const query = `
    query FleetTnsViaCompanyTours($companyId: String!, $after: String) {
      viewer {
        company(company_id: $companyId) {
          tours(role: CARRIER) {
            tours(first: 500, after: $after) {
              edges { node { shipper_transport_number } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }
    }
  `;
  const headers = { "Content-Type": "application/json", Cookie: sessionCookie };
  const tns = new Set();
  let after = null;
  let page = 0;

  while (true) {
    page += 1;
    const response = await axios.post(
      "https://app.sixfold.com/graphql",
      { query, variables: { companyId: COMPANY_ID, after } },
      { timeout: 45000, headers },
    );
    if (response?.data?.errors) {
      throw new Error(response.data.errors[0]?.message || "GraphQL Error");
    }
    const conn = response?.data?.data?.viewer?.company?.tours?.tours;
    const edges = conn?.edges || [];
    for (const edge of edges) {
      const tn = String(edge?.node?.shipper_transport_number || "").trim();
      if (tn) tns.add(tn);
    }
    console.log(
      `  [Seite ${page}] ${edges.length} Touren (gesamt ${tns.size})`,
    );
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return [...tns];
}

// --- Match-Strategien vergleichen ---------------------------------------------
function last7(tn) {
  return transportNumberToLadenummer(tn) || null;
}
function last10(tn) {
  return normalizeTransportNumber(tn) || null;
}

// Zaehlt aus SICHT DER EXCEL: findet jede meiner Excel-Touren genau eine
// Sixfold-Tour (eindeutig=sicher), mehrere (Kollision=riskant) oder keine?
function matchReport(name, excelTns, sixfoldTns, keyFn) {
  // Wie oft kommt jeder Schluessel in Sixfold vor?
  const sixfoldKeyCount = new Map();
  for (const stn of sixfoldTns) {
    const k = keyFn(stn);
    if (!k) continue;
    sixfoldKeyCount.set(k, (sixfoldKeyCount.get(k) || 0) + 1);
  }

  let unique = 0; // genau 1 Sixfold-Treffer
  let collision = 0; // mehrere Sixfold-Treffer (mehrdeutig)
  let none = 0; // kein Sixfold-Treffer
  const collisionExamples = [];
  const noneExamples = [];
  for (const tn of excelTns) {
    const k = keyFn(tn);
    const count = k ? sixfoldKeyCount.get(k) || 0 : 0;
    if (count === 1) unique += 1;
    else if (count > 1) {
      collision += 1;
      if (collisionExamples.length < 6)
        collisionExamples.push(`${tn} (${count}x)`);
    } else {
      none += 1;
      if (noneExamples.length < 6) noneExamples.push(tn);
    }
  }
  const total = excelTns.length;
  const pct = (n) => (total ? ((n / total) * 100).toFixed(1) : "0.0");
  console.log(`\n[${name}]`);
  console.log(
    `  Excel-Touren mit GENAU 1 Sixfold-Treffer (sicher): ${unique}/${total} (${pct(unique)} %)`,
  );
  console.log(
    `  Excel-Touren mit MEHREREN Treffern (mehrdeutig):   ${collision}/${total} (${pct(collision)} %)`,
  );
  console.log(
    `  Excel-Touren OHNE Sixfold-Treffer (kein GPS):      ${none}/${total} (${pct(none)} %)`,
  );
  if (collisionExamples.length)
    console.log(
      `  Mehrdeutig (Beispiele): ${collisionExamples.map((t) => `"${t}"`).join(", ")}`,
    );
  if (noneExamples.length)
    console.log(
      `  Ohne Treffer (Beispiele): ${noneExamples.map((t) => `"${t}"`).join(", ")}`,
    );
}

async function main() {
  console.log("=== Excel-Transportnummern laden ===");
  const { files, tns: excelTns } = loadExcelTransportNumbers();
  if (!files.length) {
    console.log(
      `\nKeine Excel-Dateien in ${CAPTURES_DIR} gefunden. Bitte Export dort ablegen.`,
    );
    return;
  }
  console.log(
    `\nExcel-Transportnummern gesamt (eindeutig): ${excelTns.length}`,
  );
  console.log(
    `Beispiele: ${excelTns
      .slice(0, 3)
      .map((t) => `"${t}"`)
      .join(", ")}`,
  );

  const token = String(process.env.SIXFOLD_SESSION_TOKEN || "").trim();
  if (!token) {
    console.log(
      "\nSIXFOLD_SESSION_TOKEN ist nicht gesetzt -> nur Excel-Seite ausgegeben.",
    );
    console.log(
      'Fuer den Live-Abgleich: $env:SIXFOLD_SESSION_TOKEN = "<token>"; node compare-excel-sixfold.js',
    );
    return;
  }

  console.log("\n=== Sixfold-Transportnummern live abrufen ===");
  const cookie = `sessionToken=${token}; sixfold_lng=de`;
  let sixfoldTns;
  try {
    sixfoldTns = await fetchSixfoldTransportNumbers(cookie);
  } catch (err) {
    console.error(`\nSixfold-Abruf fehlgeschlagen: ${err.message}`);
    return;
  }
  console.log(
    `\nSixfold-Transportnummern gesamt (eindeutig): ${sixfoldTns.length}`,
  );
  console.log(
    `Beispiele: ${sixfoldTns
      .slice(0, 5)
      .map((t) => `"${t}"`)
      .join(", ")}`,
  );

  console.log("\n=== MATCH-VERGLEICH (welche Strategie trifft am besten?) ===");
  matchReport("Voller String (exakt)", excelTns, sixfoldTns, (tn) => tn);
  matchReport("Letzte 10 Ziffern", excelTns, sixfoldTns, last10);
  matchReport("Letzte 7 Ziffern (Ladenummer)", excelTns, sixfoldTns, last7);

  console.log(
    "\nHINWEIS: Beste Strategie = viele 'GENAU 1' und moeglichst 0 'MEHRERE'.",
  );
  console.log(
    "'MEHRERE' bedeutet: mehrdeutig -> GPS koennte der falschen Tour zugeordnet werden.",
  );
}

main();
