"use strict";
// Analyse 4: Wert-Strom in JournalEntryDTO-Saetze (Typ-Marker 6) splitten und
// pro Satz (Transportnr, Status-Code, Event-Zeit) heuristisch extrahieren.
const fs = require("fs");
const path = require("path");

const resp = fs.readFileSync(
  path.join(__dirname, "..", "..", "data", "captures", "journal_response.txt"),
  "utf8",
);
const s = resp.slice(resp.indexOf("[") + 1, resp.lastIndexOf("]"));
const tblStart = s.indexOf('["');
const tblEnd = s.lastIndexOf('"]');
const valuePart = s.slice(0, tblStart).replace(/,\s*$/, "");
const stringTable = JSON.parse(s.slice(tblStart, tblEnd + 2));

const tokens = [];
let i = 0;
while (i < valuePart.length) {
  const c = valuePart[i];
  if (c === " " || c === ",") {
    i++;
    continue;
  }
  if (c === "'") {
    let j = i + 1,
      str = "";
    while (j < valuePart.length && valuePart[j] !== "'") {
      str += valuePart[j];
      j++;
    }
    tokens.push({ t: "L", v: str });
    i = j + 1;
  } else {
    let j = i;
    while (j < valuePart.length && valuePart[j] !== ",") j++;
    tokens.push({ t: "n", v: parseInt(valuePart.slice(i, j), 10) });
    i = j;
  }
}

const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789$_";
function longBE(str) {
  let r = 0n;
  for (const ch of str) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) return null;
    r = (r << 6n) | BigInt(idx);
  }
  return r;
}
const TN_RE = /^[0-9A-Z]{2}_\d{8}_\d{10}$/;
const strAt = (n) =>
  n >= 1 && n <= stringTable.length ? stringTable[n - 1] : null;

// Saetze splitten: neuer Satz beginnt bei Token-Wert 6 (JournalEntryDTO-Typmarker).
// Wir nehmen die Positionen aller n==6 als Grenzen.
const boundaries = [];
tokens.forEach((t, k) => {
  if (t.t === "n" && t.v === 6) boundaries.push(k);
});
const records = [];
for (let b = 0; b < boundaries.length; b++) {
  const start = boundaries[b] + 1;
  const end = b + 1 < boundaries.length ? boundaries[b + 1] : tokens.length;
  records.push(tokens.slice(start, end));
}

const statusCount = {};
let withTn = 0;
const perTransport = {};
for (const rec of records) {
  let tn = null;
  const statuses = [];
  const dates = [];
  for (const tok of rec) {
    if (tok.t === "n") {
      const str = strAt(tok.v);
      if (str) {
        if (TN_RE.test(str)) tn = str;
        else if (
          /^status|loadingDeparture|booking|tour\.|attachment|price\./.test(str)
        )
          statuses.push(str);
      }
    } else if (tok.t === "L") {
      const v = longBE(tok.v);
      if (v != null) {
        const ms = Number(v);
        if (ms > 1.7e12 && ms < 1.8e12) dates.push(new Date(ms).toISOString());
      }
    }
  }
  for (const st of statuses) statusCount[st] = (statusCount[st] || 0) + 1;
  if (tn) {
    withTn++;
    (perTransport[tn] = perTransport[tn] || []).push({ statuses, dates });
  }
}

console.log(
  "Saetze gesamt:",
  records.length,
  "| mit Transportnr:",
  withTn,
  "| distinct Transporte:",
  Object.keys(perTransport).length,
);
console.log("\n=== Status-Code Haeufigkeit ===");
Object.entries(statusCount)
  .sort((a, b) => b[1] - a[1])
  .forEach(([k, n]) => console.log("  " + n + "\t" + k));

// Ein Transport mit Lade-/Entlade-Status als Beispiel
const example = Object.entries(perTransport).find(([tn, recs]) =>
  recs.some((r) =>
    r.statuses.some((st) => /loading_arrival|loading_departure/.test(st)),
  ),
);
if (example) {
  console.log("\n=== Beispiel-Transport " + example[0] + " ===");
  example[1].forEach((r) => console.log("  " + JSON.stringify(r)));
}
