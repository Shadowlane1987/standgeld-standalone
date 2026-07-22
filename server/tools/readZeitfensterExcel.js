"use strict";

/**
 * Duenne I/O-Schicht: liest eine .xlsx-Zeitfensterliste und liefert die
 * Roh-Zeilen (Array-of-Arrays) fuer den reinen Parser server/normalize/zeitfenster.js.
 *
 * Bewusst getrennt von der Fachlogik, damit der Parser ohne Dateizugriff
 * unit-testbar bleibt.
 */

const XLSX = require("xlsx");
const {
  parseWindowRows,
  buildWindowIndex,
} = require("../normalize/zeitfenster");

/**
 * Liest die erste Tabelle als Array-of-Arrays (formatierte Textwerte).
 *
 * @param {string} filePath Pfad zur .xlsx-Datei
 * @returns {Array<Array<string>>}
 */
function readWindowRows(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: "",
  });
}

/**
 * Liest die erste Tabelle aus einem Buffer als Array-of-Arrays.
 *
 * @param {Buffer} buffer Inhalt der .xlsx-Datei
 * @returns {Array<Array<string>>}
 */
function readWindowRowsFromBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: "",
  });
}

/**
 * Liest die Datei und liefert Parser-Ergebnis + Lookup-Index.
 *
 * @param {string} filePath
 * @returns {{ windows: Array<object>, index: Map<string, object> }}
 */
function loadZeitfenster(filePath) {
  const rows = readWindowRows(filePath);
  const windows = parseWindowRows(rows);
  return { windows, index: buildWindowIndex(windows) };
}

/**
 * Liest Zeitfenster aus einem Upload-Buffer und liefert Parser-Ergebnis + Index.
 *
 * @param {Buffer} buffer
 * @returns {{ windows: Array<object>, index: Map<string, object> }}
 */
function loadZeitfensterFromBuffer(buffer) {
  const rows = readWindowRowsFromBuffer(buffer);
  const windows = parseWindowRows(rows);
  return { windows, index: buildWindowIndex(windows) };
}

module.exports = {
  readWindowRows,
  readWindowRowsFromBuffer,
  loadZeitfenster,
  loadZeitfensterFromBuffer,
};
