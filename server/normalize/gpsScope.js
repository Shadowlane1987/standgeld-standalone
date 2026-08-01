"use strict";

/**
 * Aufteilung eines Abrechnungs-Ergebnisses nach GPS-Nachweisbarkeit (§7/§10).
 *
 * Zweck (Nutzer-Vorgabe 2026-08-01): Der Sixfold-Lauf liefert ALLE Transporte.
 * Sie werden auf zwei Seiten getrennt:
 *   - Seite 1 ("verified"): Transporte, bei denen JEDER Stopp Ankunft UND
 *     Abfahrt per GPS belegt hat.
 *   - Seite 2 ("gaps"): alle uebrigen -> hier gleicht der Nutzer mit der
 *     Transporeon-Excel (XP-Service-Account-Zeiten) ab.
 *
 * Regel (Nutzer): "sobald eine Zeit fehlt" -> der gesamte Transport ist eine
 * GPS-Luecke. Ein Transport gilt nur dann als GPS-belegt, wenn ALLE seine
 * Stopps arrival_source==="GPS" UND departure_source==="GPS" haben.
 *
 * Reine Funktion ohne Seiteneffekte -> voll unit-testbar. Die Geldsumme der
 * Teilmenge wird IMMER frisch aus den gefilterten Stopps berechnet, damit die
 * angezeigte Summe je Seite korrekt ist (Prueffaelle zaehlen nicht mit).
 */

const VALID_SCOPES = Object.freeze(["all", "verified", "gaps"]);

function normalizeScope(scope) {
  const value = String(scope || "all")
    .trim()
    .toLowerCase();
  return VALID_SCOPES.includes(value) ? value : "all";
}

function transportKey(stop) {
  return String(stop?.transport_number || "").trim();
}

/**
 * Ein Stopp ist GPS-belegt, wenn Ankunft UND Abfahrt aus der GPS-Quelle stammen.
 */
function isStopGpsBacked(stop) {
  return stop?.arrival_source === "GPS" && stop?.departure_source === "GPS";
}

/**
 * Ermittelt je Transportnummer, ob der gesamte Transport GPS-belegt ist.
 * Transporte ohne verwertbare Transportnummer werden als GPS-Luecke behandelt
 * (kein sicherer Nachweis -> Abgleich auf Seite 2).
 *
 * @param {Array<object>} stops
 * @returns {Map<string, boolean>} key -> true (verified) / false (gap)
 */
function classifyTransportsByGps(stops) {
  const status = new Map();
  for (const stop of Array.isArray(stops) ? stops : []) {
    const key = transportKey(stop);
    if (!key) continue;
    const prev = status.has(key) ? status.get(key) : true;
    status.set(key, prev && isStopGpsBacked(stop));
  }
  return status;
}

/**
 * Baut die Standard-Kennzahlen einer Stopp-Teilmenge neu auf (dieselben Regeln
 * wie in enforceUnloadingGpsGate). Nur Aggregation, keine Geschaeftslogik.
 *
 * @param {Array<object>} stops
 * @returns {object}
 */
function summarizeStops(stops) {
  const list = Array.isArray(stops) ? stops : [];
  const gpsUsed = list.filter(
    (s) => s?.arrival_source === "GPS" || s?.departure_source === "GPS",
  );
  const transportNumbers = new Set(list.map(transportKey).filter(Boolean));
  return {
    transport_count: transportNumbers.size,
    stop_count: list.length,
    chargeable_count: list.filter((s) => Number(s?.fee_eur || 0) > 0).length,
    review_count: list.filter((s) => Boolean(s?.needs_review)).length,
    gps_used_count: gpsUsed.length,
    gps_used_transport_count: new Set(gpsUsed.map(transportKey).filter(Boolean))
      .size,
    gps_missing_count: list.filter((s) => Boolean(s?.gps_missing)).length,
    mixed_source_count: list.filter(
      (s) => s?.arrival_source !== s?.departure_source,
    ).length,
    total_fee_eur: list.reduce(
      (sum, s) => sum + (s?.needs_review ? 0 : Number(s?.fee_eur || 0)),
      0,
    ),
  };
}

/**
 * Filtert ein Abrechnungs-Ergebnis auf die gewaehlte GPS-Sicht und rechnet die
 * Kennzahlen der Teilmenge neu. scope "all" gibt das Ergebnis unveraendert
 * zurueck (Rueckwaertskompatibilitaet).
 *
 * @param {{stops: Array<object>, summary: object}} result
 * @param {"all"|"verified"|"gaps"} scope
 * @returns {{stops: Array<object>, summary: object}}
 */
function filterBillingByGpsScope(result, scope) {
  const normalized = normalizeScope(scope);
  if (!result || !Array.isArray(result.stops) || normalized === "all") {
    return result;
  }

  const status = classifyTransportsByGps(result.stops);
  const wantVerified = normalized === "verified";
  const keptStops = result.stops.filter((stop) => {
    const key = transportKey(stop);
    // Ohne Transportnummer: nie "verified" (kein sicherer Nachweis).
    const isVerified = key ? status.get(key) === true : false;
    return wantVerified ? isVerified : !isVerified;
  });

  return {
    ...result,
    stops: keptStops,
    summary: {
      ...(result.summary || {}),
      ...summarizeStops(keptStops),
      gps_scope: normalized,
    },
  };
}

module.exports = {
  VALID_SCOPES,
  normalizeScope,
  isStopGpsBacked,
  classifyTransportsByGps,
  summarizeStops,
  filterBillingByGpsScope,
};
