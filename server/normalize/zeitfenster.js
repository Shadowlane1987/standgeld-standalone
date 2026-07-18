"use strict";

/**
 * Parser fuer die hochgeladene Excel-Zeitfensterliste (§ Fenster-Quelle).
 *
 * Fachregeln (Nutzer 2026-07-17):
 * - Verknuepfung ueber die Ladenummer = letzte 7 Ziffern der Cola-Transportnr.
 *   (siehe ./ladenummer.js).
 * - Es gilt immer die ERSTE Zeit eines Fensters:
 *     "06:00-06:15" -> 06:00,  "08-14 Uhr" -> 08:00,  "20-20:30" -> 20:00.
 * - Die Ladestelle hat in Transporeon immer ein Fenster; bei der Entladestelle
 *   fehlt es teils -> dann kommt der Wert aus dieser Excel.
 *
 * Diese Datei ist REIN funktional (kein Datei-I/O). Das Einlesen der .xlsx
 * uebernimmt server/tools/readZeitfensterExcel.js und uebergibt Roh-Zeilen.
 */

const HEADER_ALIASES = Object.freeze({
  ladenummer: "ladenummer",
  ladestelle: "ladestelle",
  entladestelle: "entladestelle",
  ladezeit: "ladezeit",
  entladezeit: "entladezeit",
  entladenummer: "entladenummer",
});

/**
 * Extrahiert die erste Uhrzeit aus einer sehr uneinheitlichen Textzelle und
 * gibt sie normalisiert als "HH:MM" zurueck.
 *
 * Unterstuetzt u.a.: "11:00", "6:00", "12.00", "06;30", "04:00:00 Fr.",
 * "08-14 Uhr", "20-20:30", "11:45-12:15", "5 Uhr Mo LALI", "03.07. um 18:00".
 * Reine Labels ohne Zeit ("Netto", "Aldi", "Ohne ZF") ergeben null.
 *
 * Regel: Es zaehlt die erste im Text genannte Zeit. Ist die fuehrende Zahl
 * direkt von ":"/"."/";" + Minuten gefolgt, wird HH:MM uebernommen, sonst
 * gilt sie als volle Stunde (HH:00).
 *
 * @param {string} raw
 * @returns {string|null}
 */
function extractFirstTime(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  // Datumsangaben (z.B. "03.07.", "08.07.") entfernen, damit sie nicht als
  // Uhrzeit missverstanden werden. Zeit-mit-Punkt ("12.00") bleibt erhalten,
  // weil dort der zweite Punkt fehlt.
  const cleaned = text.replace(/\b\d{1,2}\.\d{1,2}\.(?=\D|$)/g, " ");

  const match = cleaned.match(/(\d{1,2})(?:[:.;](\d{2}))?/);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = match[2] == null ? 0 : Number(match[2]);
  if (hour > 23 || minute > 59) return null;

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Ermittelt die Spaltenpositionen anhand der Kopfzeile.
 *
 * @param {Array<Array<string>>} rows
 * @returns {{ headerIndex: number, columns: Record<string, number> }|null}
 */
function locateHeader(rows) {
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] || [];
    const columns = {};
    for (let c = 0; c < row.length; c += 1) {
      const key = String(row[c] || "")
        .trim()
        .toLowerCase();
      if (HEADER_ALIASES[key] != null && columns[key] == null) {
        columns[key] = c;
      }
    }
    if (columns.ladenummer != null) {
      return { headerIndex: i, columns };
    }
  }
  return null;
}

function cellText(row, index) {
  if (index == null) return "";
  return String(row[index] ?? "").trim();
}

/**
 * Normalisiert die Excel-Ladenummer auf die letzten 7 Ziffern (Vergleichsbasis
 * mit der Transportnummer). Gibt null zurueck, wenn die Zelle keine reine
 * Nummer ist (z.B. Datums-Banner "06.07." oder Leerzeilen).
 *
 * @param {string} cell
 * @returns {string|null}
 */
function normalizeLadenummer(cell) {
  const value = String(cell || "").trim();
  if (!/^\d{4,}$/.test(value)) return null;
  return value.slice(-7);
}

/**
 * Parst die Roh-Zeilen (Array-of-Arrays inkl. Kopfzeile) in Fensterobjekte.
 *
 * @param {Array<Array<string>>} rows
 * @returns {Array<Readonly<object>>}
 */
function parseWindowRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const header = locateHeader(list);
  if (!header) return [];

  const { headerIndex, columns } = header;
  const out = [];

  for (let i = headerIndex + 1; i < list.length; i += 1) {
    const row = list[i] || [];
    const ladenummer = normalizeLadenummer(cellText(row, columns.ladenummer));
    if (!ladenummer) continue;

    const ladezeitRaw = cellText(row, columns.ladezeit);
    const entladezeitRaw = cellText(row, columns.entladezeit);

    out.push(
      Object.freeze({
        ladenummer,
        ladestelle: cellText(row, columns.ladestelle) || null,
        entladestelle: cellText(row, columns.entladestelle) || null,
        ladezeit_raw: ladezeitRaw || null,
        ladezeit_start: extractFirstTime(ladezeitRaw),
        entladezeit_raw: entladezeitRaw || null,
        entladezeit_start: extractFirstTime(entladezeitRaw),
        entladenummer: cellText(row, columns.entladenummer) || null,
        row_index: i,
      }),
    );
  }

  return out;
}

/**
 * Baut einen Index Ladenummer -> Fensterobjekt (erste Zeile gewinnt).
 *
 * @param {Array<object>} windows
 * @returns {Map<string, object>}
 */
function buildWindowIndex(windows) {
  const index = new Map();
  for (const win of windows || []) {
    if (win && win.ladenummer && !index.has(win.ladenummer)) {
      index.set(win.ladenummer, win);
    }
  }
  return index;
}

/**
 * Liefert die passende Fenster-Startzeit ("HH:MM") fuer einen Stopp-Typ.
 *
 * @param {object} window Fensterobjekt aus parseWindowRows
 * @param {string} stopType "LOADING" | "UNLOADING"
 * @returns {string|null}
 */
function windowStartForStop(window, stopType) {
  if (!window) return null;
  if (stopType === "LOADING") return window.ladezeit_start ?? null;
  if (stopType === "UNLOADING") return window.entladezeit_start ?? null;
  return null;
}

module.exports = {
  extractFirstTime,
  parseWindowRows,
  buildWindowIndex,
  windowStartForStop,
  normalizeLadenummer,
};
