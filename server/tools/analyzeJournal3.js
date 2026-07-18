"use strict";
// Analyse 3: Wert-Strom mit aufgeloesten String-Referenzen rendern, um die
// JournalEntryDTO-Satzstruktur zu erkennen.
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
function render(tok) {
  if (tok.t === "L") {
    const v = longBE(tok.v);
    const asDate = v != null ? new Date(Number(v)).toISOString() : "?";
    return `L(${tok.v}=${asDate})`;
  }
  const n = tok.v;
  if (n >= 13 && n <= stringTable.length)
    return `#${n}->${JSON.stringify(stringTable[n - 1])}`;
  return String(n);
}

// Erste 120 Token gerendert
console.log("=== Token 0..120 ===");
console.log(
  tokens
    .slice(0, 120)
    .map((t, k) => `[${k}]${render(t)}`)
    .join("  "),
);

// Finde alle Positionen, wo ein Token auf eine Transportnummer zeigt
const TN_RE = /^[0-9A-Z]{2}_\d{8}_\d{10}$/;
const tnIdxInTable = new Set();
stringTable.forEach((v, k) => {
  if (TN_RE.test(v)) tnIdxInTable.add(k + 1);
});
const tnPositions = [];
tokens.forEach((t, k) => {
  if (t.t === "n" && tnIdxInTable.has(t.v)) tnPositions.push(k);
});
console.log("\nTransportnr-Referenzen im Strom:", tnPositions.length);

// Dump Fenster um die ersten 2 Transport-Referenzen
for (const p of tnPositions.slice(0, 2)) {
  console.log(`\n--- Fenster um Token ${p} (${render(tokens[p])}) ---`);
  console.log(
    tokens
      .slice(Math.max(0, p - 20), p + 20)
      .map((t, k) => `[${Math.max(0, p - 20) + k}]${render(t)}`)
      .join("  "),
  );
}
