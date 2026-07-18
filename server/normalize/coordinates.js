"use strict";

/**
 * GPS-Koordinaten-Bewertung fuer Standgeld (Arbeitsanweisung §10).
 *
 * Aufgabe: Fuer jedes einzelne VisibilityHubUser-Ereignis pruefen, ob echte,
 * plausible GPS-Koordinaten vorliegen (verifiziert) oder ob es sich um eine
 * nicht verifizierte / manuell erzeugte Visibility handelt (z.B. Zekju/Fake).
 *
 * Wichtig:
 * - Die Bewertung erfolgt IMMER auf Ebene des einzelnen Ereignisses, niemals
 *   pauschal fuer eine ganze Tour.
 * - 0/0, leer, null, ungueltig oder nicht parsebar => NICHT verifiziert.
 * - Dieses Modul enthaelt reine Funktionen ohne Seiteneffekte und ist damit
 *   vollstaendig unit-testbar.
 */

// Alles unterhalb dieser Schwelle (in Grad) gilt als "praktisch 0".
// 1e-6 Grad entsprechen ca. 0,11 m -- fuer die 0/0-Erkennung ausreichend eng.
const ZERO_EPSILON_DEGREES = 1e-6;

/**
 * Wandelt einen einzelnen Koordinatenwert (lat oder lon) in eine Zahl um.
 * Beruecksichtigt deutsche Dezimalkommata und uebliche Fremdformate.
 *
 * @param {unknown} value
 * @returns {number|null} finite Zahl oder null, wenn nicht parsebar
 */
function parseCoordinateValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  let text = String(value).trim();
  if (!text) return null;

  // Nur Ziffern, Vorzeichen, Punkt/Komma zulassen (z.B. "53.603035" oder "10,697").
  // Grad-/Himmelsrichtungszeichen und sonstiges verwerfen wir hier bewusst nicht
  // per Konvertierung, sondern schlagen fehl, um keine falschen Werte zu erzeugen.
  text = text.replace(/\s+/g, "");

  // Wenn sowohl Punkt als auch Komma vorkommen, gehen wir vom Format
  // "1.234,56" (Tausenderpunkt + Dezimalkomma) NICHT aus -- Koordinaten haben
  // keine Tausenderpunkte. Wir entfernen daher nur ein Dezimalkomma.
  if (text.includes(",") && !text.includes(".")) {
    text = text.replace(",", ".");
  }

  if (!/^[+-]?\d+(\.\d+)?$/.test(text)) return null;

  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Zerlegt einen kombinierten Rohwert wie "53.603035 10.697445",
 * "0 0", "0,0" oder "0.000000 / 0.000000" in [latRaw, lonRaw].
 *
 * @param {string} raw
 * @returns {[string, string]|null}
 */
function splitCombinedRaw(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  // Erlaubte Trenner: Leerzeichen, Slash, Semikolon, Pipe.
  // Ein Komma ist mehrdeutig (Dezimalkomma vs. Trenner), daher separat behandelt.
  const bySeparator = text.split(/\s*[/;|]\s*|\s+/).filter(Boolean);
  if (bySeparator.length === 2) {
    return [bySeparator[0], bySeparator[1]];
  }

  // Genau ein Komma und keine anderen Trenner => "lat,lon".
  const commaParts = text.split(",");
  if (commaParts.length === 2) {
    return [commaParts[0].trim(), commaParts[1].trim()];
  }

  return null;
}

/**
 * Bewertet ein Koordinatenpaar.
 *
 * @param {unknown} latInput
 * @param {unknown} lonInput
 * @returns {{
 *   verified: boolean,
 *   lat: number|null,
 *   lon: number|null,
 *   reason: string,
 *   raw: string
 * }}
 */
function classifyCoordinatePair(latInput, lonInput) {
  const raw = `${latInput ?? ""} ${lonInput ?? ""}`.trim();
  const lat = parseCoordinateValue(latInput);
  const lon = parseCoordinateValue(lonInput);

  if (lat === null || lon === null) {
    return {
      verified: false,
      lat,
      lon,
      reason: "unparseable_or_empty",
      raw,
    };
  }

  const bothZero =
    Math.abs(lat) < ZERO_EPSILON_DEGREES &&
    Math.abs(lon) < ZERO_EPSILON_DEGREES;
  if (bothZero) {
    return { verified: false, lat, lon, reason: "zero_zero", raw };
  }

  const inRange = lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
  if (!inRange) {
    return { verified: false, lat, lon, reason: "out_of_range", raw };
  }

  return { verified: true, lat, lon, reason: "valid_gps", raw };
}

/**
 * Bewertet einen kombinierten Rohwert (eine Zelle wie "0 0" oder
 * "53.603035 10.697445").
 *
 * @param {unknown} rawValue
 * @returns {{
 *   verified: boolean,
 *   lat: number|null,
 *   lon: number|null,
 *   reason: string,
 *   raw: string
 * }}
 */
function classifyCoordinates(rawValue) {
  const raw = String(rawValue ?? "").trim();
  if (!raw) {
    return { verified: false, lat: null, lon: null, reason: "empty", raw };
  }

  const parts = splitCombinedRaw(raw);
  if (!parts) {
    return {
      verified: false,
      lat: null,
      lon: null,
      reason: "unparseable_or_empty",
      raw,
    };
  }

  return classifyCoordinatePair(parts[0], parts[1]);
}

module.exports = {
  ZERO_EPSILON_DEGREES,
  parseCoordinateValue,
  splitCombinedRaw,
  classifyCoordinatePair,
  classifyCoordinates,
};
