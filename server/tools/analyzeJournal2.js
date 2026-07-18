"use strict";
// Analyse 2: GWT-RPC-Antwort korrekt in Wert-Strom + String-Tabelle trennen,
// String-Tabelle indiziert ausgeben, Typ-Marker aufloesen.
const fs = require("fs");
const path = require("path");

const resp = fs.readFileSync(
  path.join(__dirname, "..", "..", "data", "captures", "journal_response.txt"),
  "utf8",
);

// //OK[ ... ] -> inneres
const s = resp.slice(resp.indexOf("[") + 1, resp.lastIndexOf("]"));

// Struktur: <valueStream>, [ "strTable" ], 0, 7
// Finde den Beginn der String-Tabelle: das letzte ",[" auf oberster Ebene.
// String-Tabelle beginnt mit '["' und endet mit '"]'.
const tblStart = s.indexOf('["');
const tblEnd = s.lastIndexOf('"]');
const valuePart = s.slice(0, tblStart).replace(/,\s*$/, "");
const tablePart = s.slice(tblStart, tblEnd + 2); // inkl. [ ... ]
// nach der Tabelle: ,0,7
const trailer = s.slice(tblEnd + 2);

// String-Tabelle parsen (JSON-Array von Strings)
const stringTable = JSON.parse(tablePart);
console.log("String-Tabelle Eintraege:", stringTable.length);
console.log("Trailer (flags,version):", trailer);

// Erste 40 Tabelleneintraege mit 1-basiertem Index (GWT referenziert 1-basiert)
console.log("\n=== String-Tabelle [1..45] ===");
for (let k = 0; k < Math.min(45, stringTable.length); k++) {
  console.log(k + 1 + ": " + JSON.stringify(stringTable[k]));
}

// Wert-Strom tokenisieren
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
    tokens.push({ t: "L", v: str }); // base64 long
    i = j + 1;
  } else {
    let j = i;
    while (j < valuePart.length && valuePart[j] !== ",") j++;
    tokens.push({ t: "n", v: parseInt(valuePart.slice(i, j), 10) });
    i = j;
  }
}
console.log("\nWert-Strom Tokens:", tokens.length);

// Haeufigkeit der Typ-Indizes (Zahl direkt nach einem Long)
const afterLong = {};
for (let k = 0; k < tokens.length - 1; k++) {
  if (tokens[k].t === "L" && tokens[k + 1].t === "n") {
    const idx = tokens[k + 1].v;
    afterLong[idx] = (afterLong[idx] || 0) + 1;
  }
}
console.log("\nTyp-Index direkt nach Long (Index->Anzahl, aufgeloest):");
Object.entries(afterLong)
  .sort((a, b) => b[1] - a[1])
  .forEach(([idx, n]) => {
    const name = stringTable[Number(idx) - 1];
    console.log("  " + idx + " x" + n + " -> " + JSON.stringify(name));
  });
