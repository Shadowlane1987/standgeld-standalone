"use strict";

/**
 * Aufteilung eines Abrechnungs-Ergebnisses in zwei getrennte Abrechnungen
 * (Nutzer-Vorgabe 2026-08-02):
 *
 *   - "sixfold" (Batch, Abrechnung 1): NUR Transporte, die an Sixfold
 *     angebunden sind = es liegt ein KENNZEICHEN vor (nur eigene/angebundene
 *     LKW haben in Sixfold eins). Diese werden ueber die Sixfold-/GPS-Zeiten
 *     abgerechnet. Transporte OHNE Kennzeichen erscheinen hier NICHT.
 *
 *   - "spot" (Spotmarkt, Abrechnung 2): NUR Transporte OHNE Kennzeichen
 *     (nicht an Sixfold angebunden) UND NUR, wenn XP-Service-Zeiten aus der
 *     Transporeon-Excel vorhanden sind (Ankunft UND Abfahrt). Touren ohne
 *     Excel-Zeiten kommen gar nicht mit hinein. Abrechnung mit den Excel-Zeiten.
 *
 *   - "all": keine Filterung (Gesamtsicht).
 *
 * Reine Funktion ohne Seiteneffekte -> voll unit-testbar. Die Geldsumme der
 * Teilmenge wird IMMER frisch aus den gefilterten Stopps berechnet, damit die
 * angezeigte Summe je Seite korrekt ist (Prueffaelle zaehlen nicht mit).
 */

const VALID_SCOPES = Object.freeze(["all", "sixfold", "spot"]);

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
 * An Sixfold angebunden = es liegt ein KENNZEICHEN vor. Nur eigene/angebundene
 * LKW haben in Sixfold ein Kennzeichen (aus der Fleet-Plate-Map); Spot-Carrier
 * haben keins. Dieses Signal spiegelt exakt die KFZ-Spalte der Oberflaeche:
 *
 *   - Reine Sixfold-Touren (origin "sixfold_only"): angebunden, wenn ein
 *     Sixfold- oder Excel-Kennzeichen hinterlegt ist.
 *   - Excel-/GPS-Overlay-Touren: angebunden, wenn das Kennzeichen geprueft
 *     wurde UND passt (gps_plate_match).
 *
 * Ohne Kennzeichen -> NICHT angebunden -> Spotmarkt (Excel-/XP-Zeiten).
 */
function stopIsSixfoldConnected(stop) {
  if (stop?.origin === "sixfold_only") {
    return Boolean(stop?.gps_license_plate || stop?.excel_license_plate);
  }
  return Boolean(stop?.gps_checked && stop?.gps_plate_match);
}

/**
 * XP-Service-Zeiten aus der Transporeon-Excel vorhanden (Ankunft UND Abfahrt).
 * Nur dann kann eine Tour ohne Kennzeichen auf dem Spotmarkt abgerechnet werden.
 */
function stopHasExcelTimes(stop) {
  return Boolean(stop?.xp_arrival_time) && Boolean(stop?.xp_departure_time);
}

/**
 * Ermittelt je Transportnummer, ob der Transport an Sixfold angebunden ist
 * (mind. ein Stopp mit Kennzeichen/GPS-Verknuepfung). Transporte ohne
 * verwertbare Transportnummer gelten als NICHT angebunden (-> Spotmarkt).
 *
 * @param {Array<object>} stops
 * @returns {Map<string, boolean>} key -> true (Sixfold) / false (kein Kennzeichen)
 */
function classifyTransportsByGps(stops) {
  const connected = new Map();
  for (const stop of Array.isArray(stops) ? stops : []) {
    const key = transportKey(stop);
    if (!key) continue;
    const prev = connected.get(key) === true;
    connected.set(key, prev || stopIsSixfoldConnected(stop));
  }
  return connected;
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
 * Filtert ein Abrechnungs-Ergebnis auf die gewaehlte Abrechnung und rechnet die
 * Kennzahlen der Teilmenge neu. scope "all" gibt das Ergebnis unveraendert
 * zurueck.
 *
 * @param {{stops: Array<object>, summary: object}} result
 * @param {"all"|"sixfold"|"spot"} scope
 * @returns {{stops: Array<object>, summary: object}}
 */
function filterBillingByGpsScope(result, scope) {
  const normalized = normalizeScope(scope);
  if (!result || !Array.isArray(result.stops) || normalized === "all") {
    return result;
  }

  const connected = classifyTransportsByGps(result.stops);
  const wantSixfold = normalized === "sixfold";
  const keptStops = [];
  for (const stop of result.stops) {
    const key = transportKey(stop);
    const isSixfold = key ? connected.get(key) === true : false;
    if (wantSixfold) {
      // Batch: nur an Sixfold angebundene Transporte.
      if (!isSixfold) continue;
    } else {
      // Spotmarkt: nur Touren OHNE Kennzeichen UND mit Excel-Zeiten.
      if (isSixfold) continue;
      if (!stopHasExcelTimes(stop)) continue;
    }
    keptStops.push(stop);
  }

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
  stopIsSixfoldConnected,
  stopHasExcelTimes,
  classifyTransportsByGps,
  summarizeStops,
  filterBillingByGpsScope,
};
