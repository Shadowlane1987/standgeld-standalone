"use strict";
/* Einmal-Check: Excel-Fensterabdeckung fuer alle Transporte der Liste. */
const fs = require("fs");
const path = require("path");
const { parseTransportList } = require("../normalize/gwtTransportList");
const { transportNumberToLadenummer } = require("../normalize/ladenummer");
const { windowStartForStop } = require("../normalize/zeitfenster");
const { loadZeitfenster } = require("./readZeitfensterExcel");

const CAP = path.join(__dirname, "..", "..", "data", "captures");
const EXCEL = process.argv[2] || "C:/Users/mscha/Desktop/Zeitfenster.xlsx";

function loadResult(file) {
  let s = fs.readFileSync(path.join(CAP, file), "utf8").replace(/\r?\n/g, "");
  const m = s.match(/^Result:\s*"([\s\S]*)"\s*$/);
  return JSON.parse('"' + (m ? m[1] : s) + '"');
}

const wire = loadResult("list_wire_raw.txt");
const rows = parseTransportList(wire);
console.log("Transporte in Liste:", rows.length);

let index;
try {
  index = loadZeitfenster(EXCEL).index;
  console.log("Excel geladen:", EXCEL, "| Ladenummern:", index.size);
} catch (e) {
  console.error("Excel nicht ladbar:", String(e && e.message));
  process.exit(1);
}

let load = 0,
  unload = 0,
  none = 0;
const misses = [];
for (const r of rows) {
  const lad = transportNumberToLadenummer(r.transportNumber);
  const win = lad ? index.get(lad) : null;
  const lt = windowStartForStop(win, "LOADING");
  const ut = windowStartForStop(win, "UNLOADING");
  if (lt) load++;
  if (ut) unload++;
  if (!lt && !ut) {
    none++;
    misses.push({ tn: r.transportNumber, lad });
  }
}
console.log(`\nMit Ladefenster (Excel): ${load}/${rows.length}`);
console.log(`Mit Entladefenster (Excel): ${unload}/${rows.length}`);
console.log(`OHNE jegliches Excel-Fenster: ${none}`);
for (const m of misses.slice(0, 40))
  console.log("  - ", m.tn, "-> Ladenr", m.lad);
