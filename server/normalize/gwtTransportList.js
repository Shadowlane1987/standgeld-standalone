"use strict";

/**
 * Parser fuer die GWT-RPC-Antwort von LoadPagedTransportListItemsAction
 * (Endpoint /taweb/ta/dispatch). Liefert das Mapping
 *   Transportnummer -> transportId (als GWT-Base64-Long, direkt verwendbar)
 * fuer ALLE Transporte eines Zeitfensters in EINEM Request.
 *
 * Dieses Mapping ist die Voraussetzung fuer Weg 2: die per-Transport
 * LoadTransportVisibilityAction-Aufrufe brauchen die transportId (Long).
 *
 * Vorgehen (verifiziert gegen echte Antwort mit 147 Transporten):
 * - String-Tabelle enthaelt die Transportnummern als Strings (GWT-escaped:
 *   \xNN und \/ werden entschaerft).
 * - Der value-stream (GWT-RPC, rueckwaerts gelesen) enthaelt die transportId je
 *   Zeile als Base64-Long (java.lang.Long). Die transportId einer Zeile ist der
 *   Long mit dem hoechsten Token-Index UNTERHALB des Token-Index ihrer
 *   Transportnummer (d.h. direkt "nach" der Nummer in Lesereihenfolge).
 *   Verifiziert per echtem Client-Klick: B2..7418->928662188 (3WkKs),
 *   B2..7419->928662186 (3WkKq), M1..7188->928606006 (3WWc2).
 */

const { decodeLongBE } = require("./gwtVisibility");

const TRANSPORT_NUMBER_RE = /^[0-9A-Z]{2}_\d{8}_\d{10}$/;

/**
 * Entschaerft GWT-String-Escapes (\xNN, \uNNNN, \/) zu Klartext.
 *
 * @param {string} s
 * @returns {string}
 */
function unescapeGwtString(s) {
  return String(s)
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    )
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    )
    .replace(/\\\//g, "/");
}

/**
 * Trennt eine //OK-Antwort in value-stream-Tokens und String-Tabelle (roh).
 *
 * @param {string} text
 * @returns {{ tokens: string[], entries: string[] }}
 */
function splitListResponse(text) {
  const raw = String(text || "").trim();
  if (!raw.startsWith("//OK")) {
    throw new Error("Keine gueltige GWT-RPC //OK-Antwort");
  }
  const open = raw.indexOf("[");
  const tblStart = raw.indexOf('["', open);
  const tblEnd = raw.lastIndexOf('"]');
  if (tblStart < 0 || tblEnd < 0) {
    throw new Error("String-Tabelle nicht gefunden");
  }

  const valuePart = raw.slice(open + 1, tblStart).replace(/,+\s*$/, "");
  const tokens = valuePart.split(",").map((t) => t.trim());

  const tablePart = raw.slice(tblStart + 1, tblEnd + 1);
  const entries = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(tablePart))) entries.push(unescapeGwtString(m[1]));

  return { tokens, entries };
}

/**
 * Hauptfunktion: extrahiert das Transportnummer->transportId-Mapping.
 *
 * @param {string} text - roher //OK-Response-Body
 * @returns {Array<{ transportNumber: string, transportIdB64: string,
 *   transportId: string|null }>}
 */
function parseTransportList(text) {
  const { tokens, entries } = splitListResponse(text);

  // 1) Base64-Long-Kandidaten (transportIds < 1e10) mit Token-Index.
  const longs = [];
  for (let i = 0; i < tokens.length; i++) {
    const mm = /^'([^']*)'$/.exec(tokens[i]);
    if (!mm) continue;
    const v = decodeLongBE(mm[1]);
    if (v != null && v < 10000000000)
      longs.push({ index: i, b64: mm[1], value: v });
  }

  // 2) Transportnummern -> ihr (erster) Token-Index im value-stream.
  const tnRefToNumber = new Map(); // token-string (ref) -> transportNumber
  entries.forEach((e, idx) => {
    if (TRANSPORT_NUMBER_RE.test(e)) tnRefToNumber.set(String(idx + 1), e);
  });

  const tnPositions = []; // { transportNumber, tokenIndex }
  const seen = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const tn = tnRefToNumber.get(tokens[i]);
    if (tn && !seen.has(tn)) {
      seen.add(tn);
      tnPositions.push({ transportNumber: tn, tokenIndex: i });
    }
  }

  // 3) Absteigend nach Token-Index (GWT-Rueckwaerts-Lesereihenfolge) und
  //    je Zeile die transportId = Long mit hoechstem Index in der Luecke
  //    zwischen dieser und der naechsten (niedrigeren) Transportnummer.
  tnPositions.sort((a, b) => b.tokenIndex - a.tokenIndex);

  const result = [];
  for (let k = 0; k < tnPositions.length; k++) {
    const hi = tnPositions[k].tokenIndex;
    const lo = k + 1 < tnPositions.length ? tnPositions[k + 1].tokenIndex : -1;
    let pick = null;
    for (const L of longs) {
      if (L.index < hi && L.index > lo) {
        if (pick === null || L.index > pick.index) pick = L;
      }
    }
    result.push({
      transportNumber: tnPositions[k].transportNumber,
      transportIdB64: pick ? pick.b64 : null,
      transportId: pick ? String(pick.value) : null,
    });
  }

  return result;
}

module.exports = {
  unescapeGwtString,
  splitListResponse,
  parseTransportList,
};
