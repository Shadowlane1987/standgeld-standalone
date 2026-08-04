"use strict";

/**
 * Verknuepfung Transporeon <-> Excel-Fensterliste (§ Fenster-Quelle).
 *
 * Fachregel (Nutzer 2026-07-17):
 *   Die "Ladenummer" in der Excel-Fensterliste sind IMMER die letzten 7 Ziffern
 *   der Cola-Transportnummer.
 *
 *   Beispiel: Transportnr. "4B_20260726_0006622395" -> Ladenummer "6622395".
 *
 * Rein funktional und ohne I/O -- vollstaendig unit-testbar.
 */

/**
 * Leitet die Ladenummer (Excel-Schluessel) aus einer Transportnummer ab.
 *
 * Es wird der letzte durch "_" getrennte Abschnitt genommen (dort steht die
 * eigentliche Cola-Nummer, z.B. "0006622395"), daraus die zusammenhaengende
 * Ziffernfolge am Ende gelesen und deren letzte 7 Ziffern zurueckgegeben.
 *
 * @param {string} transportNumber z.B. "4B_20260726_0006622395"
 * @returns {string|null} 7-stellige Ladenummer oder null, wenn nicht ableitbar
 */
function transportNumberToLadenummer(transportNumber) {
  const raw = String(transportNumber || "").trim();
  if (!raw) return null;

  const lastSegment = raw.split("_").pop();
  const digits = (lastSegment.match(/\d+/g) || []).pop();
  if (!digits) return null;

  return digits.slice(-7);
}

/**
 * Prueft, ob eine Transportnummer und eine Excel-Ladenummer denselben
 * Transport bezeichnen (Vergleich ueber die letzten 7 Ziffern).
 *
 * @param {string} transportNumber
 * @param {string|number} ladenummer
 * @returns {boolean}
 */
function matchesLadenummer(transportNumber, ladenummer) {
  const fromTransport = transportNumberToLadenummer(transportNumber);
  if (!fromTransport) return false;

  const target = String(ladenummer ?? "").trim();
  const targetDigits = (target.match(/\d+/g) || []).pop();
  if (!targetDigits) return false;

  return fromTransport === targetDigits.slice(-7);
}

/**
 * Prueft, ob eine Transportnummer eine echte Cola-Nummer ist.
 *
 * Cola-Format: <Praefix>_<8-stelliges Datum>_<Cola-Nummer>, z.B.
 * "4B_20260726_0006622395". Fremdtouren aus der Sixfold-Flotte (reine
 * Ziffernbloecke ohne diese Struktur, z.B. "261112499238") werden so
 * ausgeschlossen (Nutzer 2026-08-04: nur Cola-Transportnummern anzeigen).
 *
 * @param {string} transportNumber
 * @returns {boolean}
 */
function looksLikeColaTransportNumber(transportNumber) {
  const raw = String(transportNumber || "").trim();
  return /^[0-9A-Za-z]{1,4}_\d{8}_\d{4,}$/.test(raw);
}

module.exports = {
  transportNumberToLadenummer,
  matchesLadenummer,
  looksLikeColaTransportNumber,
};
