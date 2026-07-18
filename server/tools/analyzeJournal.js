"use strict";
// Einmaliges Analyse-Werkzeug: liest die rohe LoadJournalEntriesAction-Antwort
// (aus der Chat-Ergebnisdatei content.txt) und zerlegt den GWT-RPC-Stream, um
// die Struktur zu verstehen. Kein Produktivcode.
const fs = require("fs");
const path = require("path");

const SRC = process.argv[2];
if (!SRC) {
  console.error("Usage: node analyzeJournal.js <content.txt>");
  process.exit(1);
}
const raw = fs.readFileSync(SRC, "utf8");
// Die Chat-Ergebnisdatei hat Praefix "Result: " und Anhang ("Page Title: ...").
// respBody (GWT-RPC) nutzt einfache Anfuehrungszeichen -> keine escapten " darin.
function extractField(name) {
  const marker = '"' + name + '":"';
  const i = raw.indexOf(marker);
  if (i < 0) return "";
  const startPos = i + marker.length;
  // Ende = naechstes '"' das von ',"' oder '"}' gefolgt wird
  let j = startPos;
  while (j < raw.length) {
    if (
      raw[j] === '"' &&
      (raw.slice(j, j + 3) === '","' || raw.slice(j, j + 2) === '"}')
    )
      break;
    if (raw[j] === "\\") {
      j += 2;
      continue;
    }
    j++;
  }
  return raw.slice(startPos, j).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
const resp = extractField("respBody");
const req = extractField("reqBody");
if (!resp) {
  console.error("respBody nicht gefunden");
  process.exit(1);
}

// Rohantwort separat sichern
const outDir = path.join(__dirname, "..", "..", "data", "captures");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "journal_response.txt"), resp, "utf8");
fs.writeFileSync(path.join(outDir, "journal_request.txt"), req, "utf8");

// //OK[ ... ] -> inneres Array als Tokenliste
const start = resp.indexOf("[");
const end = resp.lastIndexOf("]");
const inner = resp.slice(start + 1, end);

// Tokenizer: Zahlen, 'strings', kommagetrennt
const tokens = [];
let i = 0;
while (i < inner.length) {
  const c = inner[i];
  if (c === " " || c === ",") {
    i++;
    continue;
  }
  if (c === "'") {
    let j = i + 1,
      s = "";
    while (j < inner.length && inner[j] !== "'") {
      if (inner[j] === "\\") {
        s += inner[j + 1];
        j += 2;
      } else {
        s += inner[j];
        j++;
      }
    }
    tokens.push({ t: "s", v: s });
    i = j + 1;
  } else {
    let j = i;
    while (j < inner.length && inner[j] !== ",") j++;
    const num = inner.slice(i, j).trim();
    tokens.push({ t: "n", v: num });
    i = j;
  }
}

console.log("Tokens gesamt:", tokens.length);
console.log("Erste 30:", JSON.stringify(tokens.slice(0, 30)));
console.log("Letzte 30:", JSON.stringify(tokens.slice(-30)));

// In GWT-RPC steht die String-Tabelle als eines der letzten Array-Elemente.
// Finde alle String-Token und liste die eindeutigen (das ist quasi die Tabelle).
const stringTokens = tokens.filter((t) => t.t === "s").map((t) => t.v);
const uniqStrings = [...new Set(stringTokens)];
console.log(
  "String-Token gesamt:",
  stringTokens.length,
  "eindeutig:",
  uniqStrings.length,
);

// Transportnummern und ihre Position im Token-Strom
const TN_RE = /^[0-9A-Z]{2}_\d{8}_\d{10}$/;
const tnPositions = [];
tokens.forEach((t, idx) => {
  if (t.t === "s" && TN_RE.test(t.v)) tnPositions.push({ idx, v: t.v });
});
console.log(
  "Transportnr-Token:",
  tnPositions.length,
  "erste 3:",
  JSON.stringify(tnPositions.slice(0, 3)),
);

// Umgebung der ERSTEN Transportnummer ausgeben (Kontext fuer Struktur)
if (tnPositions.length) {
  const p = tnPositions[0].idx;
  console.log("Kontext um erste TN (idx " + p + "):");
  console.log(JSON.stringify(tokens.slice(Math.max(0, p - 8), p + 40)));
}

// Interessante Modell-Strings (Klassennamen / Quellen / Qualifier)
const interesting = uniqStrings.filter((s) =>
  /DTO|Action|status\.|Visibility|TP |XP|arrival|departure|loading|unloading|Timestamp|GeoCoord|ProcessCategory|Etc\/|Europe\//.test(
    s,
  ),
);
console.log("Modell-/Signal-Strings (" + interesting.length + "):");
console.log(JSON.stringify(interesting.slice(0, 60), null, 0));
