"use strict";

/**
 * Extraktion der TP-XP-Service-Account-Zeiten aus dem Transporeon
 * dispatch-Response (§8.1).
 *
 * Der GWT-RPC-Response enthaelt ein eingebettetes, sauberes JSON-Objekt
 * (TislotDataDTO) mit den standortgemeldeten Statuszeiten als epoch-millis.
 * Dieses Objekt ist -- anders als der restliche GWT-Index-Stream -- stabil und
 * verlaesslich parsebar. Wir lesen NUR dieses JSON aus und erfinden nichts.
 *
 * Beispielausschnitt (im Response als String mit \"-escapes):
 *   {"transportId":928019721,"bookings":[{
 *     "bookingStatusQualifiers":{
 *       "dispatch.status.arrival":1784028000000,
 *       "dispatch.status.loading.begin":1784033640000,
 *       "dispatch.status.loading.end":1784035860000,
 *       "dispatch.status.departure":1784037780000, ...},
 *     "arrivalDate":1784028000000,"departureDate":1784037780000,
 *     "driver":{"licensePlateNumber":"DI-RL5251"}, ...}]}
 */

const { normalizeEventRow, SOURCE_TYPE } = require("./events");

// Transporeon verwendet einen Platzhalter-Zeitstempel (~01.01.2000) fuer
// "nicht gesetzt". Alles vor 2005 werten wir als unbestimmt und verwerfen es.
const UNSET_BEFORE_MS = Date.UTC(2005, 0, 1);

// Abbildung der dispatch.status.*-Qualifier auf sprechende Eventnamen.
const DISPATCH_QUALIFIER_NAME = Object.freeze({
  "dispatch.status.arrival": "Ankunft",
  "dispatch.status.loading.begin": "Beladen Beginn",
  "dispatch.status.loading.end": "Beladen Ende",
  "dispatch.status.departure": "Abfahrt",
  "dispatch.status.custom.entrance": "Einfahrt",
});

/**
 * Findet ein JSON-Objekt ab einem gegebenen Startindex durch Klammerzaehlung.
 * Es wird davon ausgegangen, dass in den String-Werten keine geschweiften
 * Klammern vorkommen (fuer TislotDataDTO zutreffend: nur Zahlen/kurze Strings).
 *
 * @param {string} text
 * @param {number} openBraceIndex Index des oeffnenden '{'
 * @returns {string|null} Teilstring inkl. schliessender Klammer oder null
 */
function sliceBalancedObject(text, openBraceIndex) {
  let depth = 0;
  for (let i = openBraceIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(openBraceIndex, i + 1);
    }
  }
  return null;
}

/**
 * Extrahiert das TislotDataDTO-JSON aus einem rohen dispatch-Response.
 *
 * @param {string} rawResponseText
 * @returns {object|null} geparstes TislotDataDTO oder null, wenn nicht vorhanden
 */
function extractTislotData(rawResponseText) {
  const text = String(rawResponseText || "");
  if (!text) return null;

  // Der Marker ist im Response escaped: {\"transportId\":
  const escapedMarker = '{\\"transportId\\"';
  const plainMarker = '{"transportId"';

  let startBrace = text.indexOf(escapedMarker);
  let escaped = true;
  if (startBrace === -1) {
    startBrace = text.indexOf(plainMarker);
    escaped = false;
  }
  if (startBrace === -1) return null;

  const rawSlice = sliceBalancedObject(text, startBrace);
  if (!rawSlice) return null;

  try {
    if (!escaped) return JSON.parse(rawSlice);
    // Escaped: Die einzige vorkommende Maskierung ist \" -> ". Direktes
    // Ersetzen liefert gueltiges JSON (TislotDataDTO enthaelt keine \\ Werte).
    return JSON.parse(rawSlice.replace(/\\"/g, '"'));
  } catch (_error) {
    return null;
  }
}

/**
 * Wandelt ein TislotDataDTO in normalisierte TP-XP-Rohevents (§7, §8.1).
 * Jeder gesetzte Status-Qualifier einer Buchung wird zu einem Event.
 *
 * @param {object|null} tislot Ergebnis von extractTislotData
 * @param {{
 *   importRunId?: string,
 *   importedAt?: string,
 *   transportNumber?: string,
 *   timezone?: string
 * }} [ctx]
 * @returns {object[]} Liste normalisierter Rohevents (source_type = TP_XP)
 */
function tislotToEvents(tislot, ctx = {}) {
  if (!tislot || !Array.isArray(tislot.bookings)) return [];

  const transportId =
    tislot.transportId != null ? String(tislot.transportId) : null;
  const events = [];
  let orderIndex = 0;

  for (const booking of tislot.bookings) {
    const qualifiers = booking?.bookingStatusQualifiers || {};
    const deliveryNumber =
      Array.isArray(booking?.deliveryInfos) && booking.deliveryInfos.length
        ? (booking.deliveryInfos[0]?.number ?? null)
        : null;
    const plate = booking?.driver?.licensePlateNumber ?? null;

    for (const [qualifier, epochValue] of Object.entries(qualifiers)) {
      const epoch = Number(epochValue);
      if (!Number.isFinite(epoch) || epoch <= 0) continue;
      if (epoch < UNSET_BEFORE_MS) continue; // Platzhalter verwerfen.
      if (!DISPATCH_QUALIFIER_NAME[qualifier]) continue; // nur relevante Zeiten.

      events.push(
        normalizeEventRow(
          {
            transport_number: ctx.transportNumber ?? null,
            transport_id: transportId,
            delivery_number: deliveryNumber,
            event_name: DISPATCH_QUALIFIER_NAME[qualifier],
            status_qualifier: qualifier,
            event_time: epoch,
            timezone: ctx.timezone ?? null,
            source: "TP XP Service Account",
            comment: plate ? `Kfz-Kennz.: ${plate}` : null,
            // TP XP liefert keine GPS-Koordinaten -> bewusst leer.
            coordinates: null,
            raw: {
              qualifier,
              epoch: epochValue,
              bookingId: booking?.bookingId,
            },
          },
          {
            importRunId: ctx.importRunId,
            importedAt: ctx.importedAt,
            orderIndex: orderIndex++,
          },
        ),
      );
    }
  }

  return events;
}

module.exports = {
  UNSET_BEFORE_MS,
  DISPATCH_QUALIFIER_NAME,
  sliceBalancedObject,
  extractTislotData,
  tislotToEvents,
  // Re-Export zur Bequemlichkeit fuer aufrufende Module.
  SOURCE_TYPE,
};
