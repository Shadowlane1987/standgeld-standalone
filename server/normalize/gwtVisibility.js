"use strict";

/**
 * Parser fuer die GWT-RPC-Antwort von LoadTransportVisibilityAction
 * (Endpoint /taweb/ta/dispatch). Liefert dieselben normalisierten Rohevents
 * wie parseEventGrid() -- nur direkt aus der Wire-Antwort statt aus dem
 * gerenderten Grid. Damit koennen alle Transporte eines Zeitraums per
 * paralleler HTTP-Wiedergabe (Weg 2) ausgelesen werden.
 *
 * WICHTIG (Fachlogik, §7/§8/§10):
 * - Es wird NICHTS berechnet und KEINE Quelle bevorzugt. Nur normalisiert.
 * - VisibilityHubUser (GPS) vs. "TP XP Service Account" bleibt als source_raw
 *   erhalten; die GPS-Bewertung uebernimmt normalizeEventRow().
 *
 * Wire-Format (verifiziert gegen echte Antwort, siehe
 * data/captures/visibility_sample.txt):
 * - Antwort: //OK[<value-stream>,["string-table"],0,7]
 * - Der value-stream wird in GWT-RPC RUECKWAERTS gelesen; die String-Tabelle
 *   ist 1-basiert. Fuer die Extraktion nutzen wir stabile, positionsbasierte
 *   Anker statt einer vollstaendigen Deserialisierung:
 *   Jedes Event enthaelt die Quell-IdWithName als Vorwaerts-Muster
 *     <name-ref>,<id>,8,7,<status-ref>,<delivery-ref>
 *   wobei 8 = java.lang.Integer-Typ, 7 = IdWithName-Typ. Der Zeitstempel ist
 *   ein Base64-Long (java.sql.Timestamp, Marker 17), Koordinaten sind das
 *   Float-Paar vor dem GeoCoordinateDTO-Marker (10).
 */

const { normalizeEventRow } = require("./events");

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789$_";

/**
 * Dekodiert einen GWT-Long (Big-Endian, GWT-Base64-Alphabet) zu einer Zahl.
 * Verwendet fuer java.sql.Timestamp/Date (epoch-millis).
 *
 * @param {string} str
 * @returns {number|null} epoch-millis oder null
 */
function decodeLongBE(str) {
  const s = String(str || "");
  if (!s) return null;
  let result = 0n;
  for (const ch of s) {
    const idx = B64_ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    result = (result << 6n) | BigInt(idx);
  }
  const n = Number(result);
  return Number.isFinite(n) ? n : null;
}

/**
 * ProcessKind-Namen (TP-XP-Meldungen) auf status.*-Qualifier abbilden.
 */
const PROCESS_KIND_TO_QUALIFIER = Object.freeze({
  loadingarrival: "status.loading.arrival",
  loadingdeparture: "status.loading.departure",
  unloadingarrival: "status.unloading.arrival",
  unloadingdeparture: "status.unloading.departure",
  locatingbegin: "status.locating.begin",
  locatingend: "status.locating.end",
});

/**
 * Trennt //OK-Antwort in value-stream-Tokens und String-Tabelle.
 *
 * @param {string} text
 * @returns {{ tokens: string[], table: string[] }}
 */
function splitGwtResponse(text) {
  const raw = String(text || "").trim();
  if (!raw.startsWith("//OK")) {
    throw new Error("Keine gueltige GWT-RPC //OK-Antwort");
  }
  // Inhalt zwischen dem aeussersten [ ... ]
  const open = raw.indexOf("[");
  const inner = raw.slice(open + 1, raw.lastIndexOf("]"));

  // String-Tabelle = das eingebettete JSON-Array (beginnt mit ["...).
  const tblStart = inner.indexOf('["');
  const tblEnd = inner.lastIndexOf('"]');
  if (tblStart < 0 || tblEnd < 0) {
    throw new Error("String-Tabelle nicht gefunden");
  }
  const table = JSON.parse(inner.slice(tblStart, tblEnd + 2));

  // Value-Stream = alles vor der Tabelle (ohne abschliessendes Komma).
  const valuePart = inner.slice(0, tblStart).replace(/,+\s*$/, "");
  const tokens = valuePart
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  return { tokens, table };
}

/**
 * Loest einen positiven String-Tabellen-Verweis auf (1-basiert).
 *
 * @param {string} token
 * @param {string[]} table
 * @returns {string|null}
 */
function resolveRef(token, table) {
  if (!/^\d+$/.test(token)) return null;
  const idx = Number(token);
  if (idx < 1 || idx > table.length) return null;
  return table[idx - 1];
}

/**
 * Ist der aufgeloeste String eine verwertbare Quelle (nicht System/Partner)?
 */
function isSourceName(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  return n.includes("visibilityhubuser") || n.includes("xp service account");
}

/**
 * Extrahiert Rohdatensaetze (ohne Normalisierung) aus dem Token-Strom.
 *
 * @param {string[]} tokens
 * @param {string[]} table
 * @returns {Array<{ statusQualifier: string|null, deliveryNumber: string|null,
 *   sourceRaw: string|null, eventMillis: number|null, lat: number|null,
 *   lon: number|null }>}
 */
function extractRecords(tokens, table) {
  // 1) Zeitstempel + Koordinaten in Stromreihenfolge sammeln.
  const timestamps = []; // { index, millis }
  const coords = []; // { index, lat, lon }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // Base64-Long-Timestamp: 'xxxx' gefolgt von Typ-Marker 17.
    if (/^'[^']*'$/.test(t) && tokens[i + 1] === "17") {
      timestamps.push({ index: i, millis: decodeLongBE(t.slice(1, -1)) });
    }
    // GeoCoordinateDTO (Marker 10) mit zwei vorangehenden Float-Tokens.
    if (
      t === "10" &&
      /^-?\d+\.\d+$/.test(tokens[i - 1] || "") &&
      /^-?\d+\.\d+$/.test(tokens[i - 2] || "")
    ) {
      coords.push({
        index: i,
        lat: Number(tokens[i - 2]),
        lon: Number(tokens[i - 1]),
      });
    }
  }

  // 2) Quell-Anker finden: <name-ref>,<id>,8,7,<status-ref>,<delivery-ref>
  const records = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i + 2] !== "8" || tokens[i + 3] !== "7") continue;
    const name = resolveRef(tokens[i], table);
    if (!isSourceName(name)) continue;
    if (!/^\d{4,}$/.test(tokens[i + 1] || "")) continue; // id plausibel

    const statusRaw = resolveRef(tokens[i + 4], table);
    const deliveryRaw = resolveRef(tokens[i + 5], table);

    // Zugehoerigen Zeitstempel (naechster nach dem Anker) und Koordinaten.
    const ts = timestamps.find((x) => x.index > i);
    const co = coords.find((x) => x.index > i);

    records.push({
      anchorIndex: i,
      statusQualifier: mapStatus(statusRaw),
      deliveryNumber:
        deliveryRaw && /\d/.test(deliveryRaw) ? deliveryRaw : null,
      sourceRaw: name,
      eventMillis: ts ? ts.millis : null,
      lat: co ? co.lat : null,
      lon: co ? co.lon : null,
    });
  }

  return records;
}

/**
 * Bildet einen Status-Rohwert (status.* ODER ProcessKind-Name) auf einen
 * status.*-Qualifier ab.
 *
 * @param {string|null} raw
 * @returns {string|null}
 */
function mapStatus(raw) {
  if (!raw) return null;
  if (/^status\./.test(raw)) return raw;
  const key = raw.toLowerCase().replace(/[^a-z]/g, "");
  return PROCESS_KIND_TO_QUALIFIER[key] || null;
}

/**
 * Hauptfunktion: parst eine LoadTransportVisibilityAction-Antwort zu
 * normalisierten Rohevents (identisches Format wie parseEventGrid()).
 *
 * @param {string} text - roher //OK-Response-Body
 * @param {{ transportNumber?: string|null, transportId?: string|number|null,
 *   importRunId?: string, importedAt?: string }} [ctx]
 * @returns {Array<object>} normalisierte, unveraenderliche Rohevents
 */
function parseVisibilityResponse(text, ctx = {}) {
  const { tokens, table } = splitGwtResponse(text);
  const records = extractRecords(tokens, table);

  return records.map((rec, index) => {
    const hasCoords = rec.lat != null && rec.lon != null;
    const input = {
      transport_number: ctx.transportNumber ?? null,
      transport_id: ctx.transportId ?? null,
      delivery_number: rec.deliveryNumber,
      event_name: rec.statusQualifier,
      status_qualifier: rec.statusQualifier,
      // §9: Timestamp ist bereits ein UTC-Zeitpunkt (epoch-millis).
      event_time: rec.eventMillis,
      timezone: null,
      source: rec.sourceRaw,
      coordinates: hasCoords ? `${rec.lat} ${rec.lon}` : "",
      lat: hasCoords ? rec.lat : null,
      lon: hasCoords ? rec.lon : null,
    };
    return normalizeEventRow(input, {
      importRunId: ctx.importRunId,
      importedAt: ctx.importedAt,
      orderIndex: index,
    });
  });
}

module.exports = {
  decodeLongBE,
  splitGwtResponse,
  resolveRef,
  isSourceName,
  mapStatus,
  extractRecords,
  parseVisibilityResponse,
};
