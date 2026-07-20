"use strict";

/**
 * Normalisierung von Transporeon-Eventzeilen fuer Standgeld (§7, §8, §9, §10).
 *
 * Ziel: Eine roh ausgelesene Eventzeile (z.B. aus dem Event-Management-Grid oder
 * aus dem dispatch-Response) in ein einheitliches, unveraenderliches Rohevent
 * ueberfuehren -- OHNE zu berechnen und OHNE eine Quelle zu bevorzugen.
 *
 * Reine Funktionen, vollstaendig unit-testbar.
 */

const { classifyCoordinates } = require("./coordinates");
const { toUtcIso } = require("./datetime");

/**
 * Datenquelle eines Events (§8).
 * - TP_XP:      Standortmeldung ueber "TP XP Service Account".
 * - VISIBILITY: Sixfold/GPS ueber "VisibilityHubUser".
 * - SYSTEM:     Transporeon-System / Service Account Support.
 * - OTHER:      alles andere / unbekannt.
 */
const SOURCE_TYPE = Object.freeze({
  TP_XP: "TP_XP",
  VISIBILITY: "VISIBILITY",
  SYSTEM: "SYSTEM",
  OTHER: "OTHER",
});

/**
 * Fachliche Event-Kategorie fuer die spaetere Standgeld-Logik.
 */
const EVENT_CATEGORY = Object.freeze({
  LOCATING: "LOCATING", // Ortung Beginn/Ende (reine Sichtbarkeit)
  TRANSIT: "TRANSIT", // Fahrt Richtung Belade-/Entladestelle
  LOAD_ARRIVAL: "LOAD_ARRIVAL",
  LOAD: "LOAD", // Beladen Beginn/Ende
  LOAD_DEPARTURE: "LOAD_DEPARTURE",
  UNLOAD_ARRIVAL: "UNLOAD_ARRIVAL",
  UNLOAD: "UNLOAD",
  UNLOAD_DEPARTURE: "UNLOAD_DEPARTURE",
  WARNING: "WARNING",
  DELAY: "DELAY",
  OTHER: "OTHER",
});

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Bestimmt die Datenquelle anhand des "Abgegeben von / Disponent"-Textes (§8).
 *
 * @param {unknown} sourceText
 * @returns {string} SOURCE_TYPE
 */
function classifySource(sourceText) {
  const text = normalizeText(sourceText);
  if (!text) return SOURCE_TYPE.OTHER;

  if (text.includes("visibilityhubuser")) return SOURCE_TYPE.VISIBILITY;
  if (text.includes("xp service account")) return SOURCE_TYPE.TP_XP;
  // Reine System-/Support-Konten liefern keine verwertbaren Stand-Zeiten.
  if (text.includes("service account support")) return SOURCE_TYPE.SYSTEM;
  if (text.includes("transporeon")) return SOURCE_TYPE.SYSTEM;
  return SOURCE_TYPE.OTHER;
}

/**
 * Abbildung eines Transporeon-Status-Qualifiers auf eine fachliche Kategorie.
 * Deckt sowohl die "status.*" (Visibility/Prozess) als auch die
 * "dispatch.status.*" (TP XP Standortmeldung) Qualifier ab.
 *
 * @param {unknown} qualifierInput
 * @returns {string} EVENT_CATEGORY
 */
function categorizeStatusQualifier(qualifierInput) {
  const q = normalizeText(qualifierInput);
  if (!q) return EVENT_CATEGORY.OTHER;

  if (q.includes("locating")) return EVENT_CATEGORY.LOCATING;
  if (q.includes("headingtowards")) return EVENT_CATEGORY.TRANSIT;

  // WICHTIG: "unloading" enthaelt "loading" als Substring, daher zuerst
  // die Entlade-Faelle pruefen.
  if (q.includes("unloading.arrival")) return EVENT_CATEGORY.UNLOAD_ARRIVAL;
  if (q.includes("unloading.departure")) return EVENT_CATEGORY.UNLOAD_DEPARTURE;
  if (q.includes("unloading.begin") || q.includes("unloading.end")) {
    return EVENT_CATEGORY.UNLOAD;
  }

  if (q.includes("loading.arrival")) return EVENT_CATEGORY.LOAD_ARRIVAL;
  if (q.includes("loading.departure")) return EVENT_CATEGORY.LOAD_DEPARTURE;
  if (q.includes("loading.begin") || q.includes("loading.end")) {
    return EVENT_CATEGORY.LOAD;
  }

  if (q.includes("delay")) return EVENT_CATEGORY.DELAY;
  if (q.includes("warning")) return EVENT_CATEGORY.WARNING;

  // Generische dispatch.status.* Faelle (TP XP Standortmeldung ohne Suffix).
  if (q === "dispatch.status.arrival") return EVENT_CATEGORY.LOAD_ARRIVAL;
  if (q === "dispatch.status.departure") return EVENT_CATEGORY.LOAD_DEPARTURE;

  return EVENT_CATEGORY.OTHER;
}

/**
 * Wandelt einen beliebigen Zeitwert (ISO-String, epoch-millis, Date) in einen
 * ISO-String um. Gibt null zurueck, wenn nicht interpretierbar.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function toIsoTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const text = String(value).trim();
  if (!text) return null;
  // Rein numerische Strings als epoch-millis behandeln.
  if (/^\d{10,}$/.test(text)) {
    const d = new Date(Number(text));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Normalisiert eine rohe Eventzeile in ein Rohevent gemaess §7.
 *
 * Erwartete (lose) Eingabefelder -- alle optional, es wird nichts erfunden:
 *   transport_number, transport_id, delivery_number,
 *   event_name, status_qualifier, event_category,
 *   timestamp (system) , event_time, timezone,
 *   source (Abgegeben von), comment,
 *   coordinates (kombiniert) ODER lat/lon,
 *   order_index, raw (urspruengliche Zeile)
 *
 * @param {Record<string, unknown>} row
 * @param {{ importRunId?: string, importedAt?: string, orderIndex?: number }} [ctx]
 * @returns {object} normalisiertes, unveraenderliches Rohevent
 */
function normalizeEventRow(row, ctx = {}) {
  const input = row || {};

  const sourceText = input.source ?? input.abgegeben_von ?? null;
  const sourceType = classifySource(sourceText);

  const statusQualifier =
    input.status_qualifier ?? input.qualifier ?? input.event_name ?? null;
  const category =
    input.event_category ?? categorizeStatusQualifier(statusQualifier);

  const combinedCoords =
    input.coordinates ??
    input.geo ??
    (input.lat != null || input.lon != null
      ? `${input.lat ?? ""} ${input.lon ?? ""}`
      : null);
  const coordinates = classifyCoordinates(combinedCoords);

  // §10: Nur VisibilityHubUser-Events koennen ueberhaupt "verifiziertes GPS"
  // sein. Fuer alle anderen Quellen ist die GPS-Verifikation nicht anwendbar.
  const gpsVerified =
    sourceType === SOURCE_TYPE.VISIBILITY ? coordinates.verified : false;

  return Object.freeze({
    transport_number: input.transport_number ?? null,
    transport_id: input.transport_id ?? null,
    delivery_number: input.delivery_number ?? input.shipment_number ?? null,

    event_name: input.event_name ?? input.status ?? null,
    status_qualifier: statusQualifier ?? null,
    event_category: category,

    // §9: Wanduhrzeit + Zeitzone der Zeile -> korrekter UTC-Zeitpunkt.
    // Die lokale Rohzeit bleibt zur Nachvollziehbarkeit erhalten.
    event_time_local: input.event_time ?? input.status_date ?? null,
    event_time: toUtcIso(
      input.event_time ?? input.status_date ?? null,
      input.timezone ?? null,
    ),
    system_timestamp: toUtcIso(
      input.timestamp ?? input.system_timestamp ?? null,
      input.timezone ?? null,
    ),
    timezone: input.timezone ?? null,

    source_raw: sourceText ?? null,
    source_type: sourceType,

    comment: input.comment ?? null,

    coordinates_raw: coordinates.raw || null,
    lat: coordinates.lat,
    lon: coordinates.lon,
    gps_reason: coordinates.reason,
    gps_verified: gpsVerified,

    order_index:
      input.order_index ?? (ctx.orderIndex != null ? ctx.orderIndex : null),

    // Herkunft der Zeile (z.B. "EXPORT" fuer die saubere Transporeon-Export-
    // Ist-Zeit). Erlaubt es, bei mehreren TP-XP-Events die verlaessliche
    // Export-Zeit zu bevorzugen statt widerspruechliche Wire-Zeiten zu mischen.
    origin: input.origin ?? null,

    import_run_id: ctx.importRunId ?? null,
    imported_at: ctx.importedAt ?? null,

    // Urspruenglicher Rohwert bleibt zur Nachvollziehbarkeit erhalten (§7).
    raw: input.raw ?? null,
  });
}

module.exports = {
  SOURCE_TYPE,
  EVENT_CATEGORY,
  classifySource,
  categorizeStatusQualifier,
  toIsoTimestamp,
  normalizeEventRow,
};
