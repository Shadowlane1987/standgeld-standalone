"use strict";
/* Einmal-Analyse: Positions-Regel der Fenster/Ist-Zeiten im List-Wire finden. */
const fs = require("fs");
const path = require("path");
const { splitListResponse } = require("../normalize/gwtTransportList");
const { decodeLongBE } = require("../normalize/gwtVisibility");

const CAP = path.join(__dirname, "..", "..", "data", "captures");

function loadResult(file) {
  let s = fs.readFileSync(path.join(CAP, file), "utf8");
  s = s.replace(/\r?\n/g, "");
  const m = s.match(/^Result:\s*"([\s\S]*)"\s*$/);
  const inner = m ? m[1] : s;
  return JSON.parse('"' + inner.replace(/^"|"$/g, "") + '"');
}

const wire = loadResult("list_wire_raw.txt");
const gt = JSON.parse(loadResult("grid_ground_truth_raw.txt"));

const { tokens } = splitListResponse(wire);

// Alle Long-Tokens dekodieren (nur 'xxx' quoted).
const longs = tokens
  .map((t, i) => {
    const mm = /^'([^']*)'$/.exec(t);
    if (!mm) return null;
    const v = decodeLongBE(mm[1]);
    return v == null ? null : { i, b64: mm[1], v };
  })
  .filter(Boolean);

// transportId je Nummer via parseTransportList
const { parseTransportList } = require("../normalize/gwtTransportList");
const rows = parseTransportList(wire);
const idByNumber = new Map(
  rows.map((r) => [r.transportNumber, r.transportIdB64]),
);

// tokenIndex der transportId
function idTokenIndex(b64) {
  const tok = `'${b64}'`;
  return tokens.indexOf(tok);
}

function localToEpoch(s) {
  if (!s || s === "-") return null;
  return Date.parse(s.replace(" ", "T") + ":00+02:00");
}

const FIELDS = [
  "loadWin",
  "loadArr",
  "loadDep",
  "unloadWin",
  "unloadArr",
  "unloadDep",
];
const offsetStats = {}; // field -> Map(offset -> count)
for (const f of FIELDS) offsetStats[f] = new Map();

let matchedTransports = 0;
for (const row of gt) {
  const b64 = idByNumber.get(row.number);
  if (!b64) continue;
  const idIdx = idTokenIndex(b64);
  if (idIdx < 0) continue;
  matchedTransports++;
  for (const f of FIELDS) {
    const exp = localToEpoch(row[f]);
    if (exp == null) continue;
    // nächstliegendes Long im Bereich ±10 min
    for (const L of longs) {
      if (Math.abs(L.v - exp) <= 60000) {
        const off = L.i - idIdx;
        offsetStats[f].set(off, (offsetStats[f].get(off) || 0) + 1);
      }
    }
  }
}

console.log("Transporte gematcht:", matchedTransports, "von", gt.length);
console.log(
  "Longs gesamt:",
  longs.length,
  "| Timestamps (>1.5e12):",
  longs.filter((l) => l.v > 1.5e12).length,
);
for (const f of FIELDS) {
  const arr = [...offsetStats[f].entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  console.log(`\n${f}: top offsets (offset x count)`);
  for (const [off, c] of arr) console.log(`   ${off} x${c}`);
}
