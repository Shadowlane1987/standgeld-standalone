"use strict";

/**
 * Automatische lokale Backups des Datenordners.
 *
 * Grundsatz (nach der Excel-Makro-Erfahrung): Pflichtfunktion, laeuft bei jedem
 * Programmstart, ohne externe/native Abhaengigkeit.
 *
 * - Es wird ein datiertes Backup je Kalendertag angelegt: backups/backup_<YYYY-MM-DD>.
 *   Startet man mehrfach am selben Tag, wird das Tagesbackup aktualisiert.
 * - Es werden maximal `maxBackups` Tagesbackups aufgehoben, aeltere werden geloescht.
 * - Backups liegen NEBEN dem Datenordner (nicht darin), damit sie sich nicht
 *   selbst mitsichern.
 */

const fs = require("fs");
const path = require("path");

const BACKUP_PREFIX = "backup_";

function pad(value, length = 2) {
  return String(value).padStart(length, "0");
}

function dayStamp(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function isNonEmptyDir(dir) {
  try {
    return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length > 0;
  } catch (_error) {
    return false;
  }
}

/**
 * Behaelt nur die neuesten `maxBackups` Tagesbackups, loescht aeltere.
 * @returns {string[]} Namen der geloeschten Backups.
 */
function pruneOldBackups(backupsDir, maxBackups) {
  let entries;
  try {
    entries = fs.readdirSync(backupsDir, { withFileTypes: true });
  } catch (_error) {
    return [];
  }
  const backups = entries
    .filter((e) => e.isDirectory() && e.name.startsWith(BACKUP_PREFIX))
    .map((e) => e.name)
    .sort(); // Namen enthalten das Datum -> chronologisch sortierbar
  const removed = [];
  while (backups.length > maxBackups) {
    const oldest = backups.shift();
    try {
      fs.rmSync(path.join(backupsDir, oldest), {
        recursive: true,
        force: true,
      });
      removed.push(oldest);
    } catch (_error) {
      // Ein fehlgeschlagenes Loeschen darf den Start nicht verhindern.
    }
  }
  return removed;
}

/**
 * Erstellt beim Start ein Tagesbackup des Datenordners.
 *
 * @param {object} [options]
 * @param {string} options.dataDir      Zu sichernder Datenordner.
 * @param {string} [options.backupsDir] Zielordner (Standard: <dataDir>/../backups).
 * @param {number} [options.maxBackups] Maximale Anzahl Tagesbackups (Standard 30).
 * @param {Date}   [options.now]        Zeitpunkt (fuer Tests).
 * @returns {{ skipped: boolean, reason?: string, path?: string, removed?: string[] }}
 */
function runStartupBackup(options = {}) {
  const dataDir = options.dataDir;
  const backupsDir =
    options.backupsDir || path.join(path.dirname(dataDir), "backups");
  const maxBackups = Number.isFinite(options.maxBackups)
    ? options.maxBackups
    : 30;
  const now = options.now || new Date();

  if (!dataDir || !isNonEmptyDir(dataDir)) {
    return { skipped: true, reason: "no-data" };
  }

  // Sicherheitsnetz: Backups duerfen nicht im Datenordner selbst liegen.
  const resolvedData = path.resolve(dataDir);
  const resolvedBackups = path.resolve(backupsDir);
  if (
    resolvedBackups === resolvedData ||
    resolvedBackups.startsWith(resolvedData + path.sep)
  ) {
    return { skipped: true, reason: "backups-inside-data" };
  }

  fs.mkdirSync(resolvedBackups, { recursive: true });

  const target = path.join(resolvedBackups, `${BACKUP_PREFIX}${dayStamp(now)}`);
  // Tagesbackup aktualisieren: bestehendes zuerst entfernen, dann neu kopieren.
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(resolvedData, target, { recursive: true });

  const removed = pruneOldBackups(resolvedBackups, maxBackups);
  return { skipped: false, path: target, removed };
}

module.exports = { runStartupBackup, pruneOldBackups, dayStamp };
