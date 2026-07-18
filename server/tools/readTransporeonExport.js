"use strict";

/**
 * Duenne I/O-Schicht: liest den Transporeon-Excel-Export (.xlsx) und liefert
 * die geparsten Transporte fuer die Abrechnung.
 *
 * Getrennt von der Fachlogik (transporeonExport.js), damit der Parser ohne
 * Dateizugriff unit-testbar bleibt.
 */

const XLSX = require("xlsx");
const { parseTransporeonExport } = require("../normalize/transporeonExport");

/**
 * @param {string} filePath Pfad zur exportierten .xlsx-Datei
 * @returns {Array<Array<string>>}
 */
function readExportRows(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });
}

/**
 * @param {string} filePath
 * @returns {Array<object>} geparste Transporte (parseTransporeonExport)
 */
function loadTransporeonExport(filePath) {
  return parseTransporeonExport(readExportRows(filePath));
}

module.exports = { readExportRows, loadTransporeonExport };
