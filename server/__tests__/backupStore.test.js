"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { runStartupBackup } = require("../backup/backupStore");

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "standgeld-backup-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "example.json"), '{"ok":true}');
  return { root, dataDir };
}

test("erstellt ein Tagesbackup mit dem Inhalt des Datenordners", () => {
  const { root, dataDir } = makeTempRoot();
  const result = runStartupBackup({
    dataDir,
    now: new Date(2026, 0, 1, 6, 45),
  });
  assert.equal(result.skipped, false);
  const copied = path.join(result.path, "example.json");
  assert.equal(fs.existsSync(copied), true);
  assert.equal(path.basename(result.path), "backup_2026-01-01");
  assert.equal(
    path.dirname(result.path),
    path.join(root, "backups"),
    "Backups liegen neben dem Datenordner",
  );
});

test("mehrfacher Start am selben Tag aktualisiert dasselbe Tagesbackup", () => {
  const { dataDir } = makeTempRoot();
  const now = new Date(2026, 0, 1, 6, 45);
  const first = runStartupBackup({ dataDir, now });
  const second = runStartupBackup({ dataDir, now: new Date(2026, 0, 1, 20, 0) });
  assert.equal(first.path, second.path);
  const backupsDir = path.dirname(second.path);
  const entries = fs
    .readdirSync(backupsDir)
    .filter((name) => name.startsWith("backup_"));
  assert.equal(entries.length, 1);
});

test("behaelt nur die neuesten maxBackups Tagesbackups", () => {
  const { dataDir } = makeTempRoot();
  let backupsDir;
  for (let day = 1; day <= 5; day += 1) {
    const result = runStartupBackup({
      dataDir,
      maxBackups: 3,
      now: new Date(2026, 0, day, 6, 45),
    });
    backupsDir = path.dirname(result.path);
  }
  const entries = fs
    .readdirSync(backupsDir)
    .filter((name) => name.startsWith("backup_"))
    .sort();
  assert.deepEqual(entries, [
    "backup_2026-01-03",
    "backup_2026-01-04",
    "backup_2026-01-05",
  ]);
});

test("ueberspringt Backup bei leerem Datenordner", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "standgeld-backup-empty-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const result = runStartupBackup({ dataDir });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "no-data");
});

test("verweigert Backups, die im Datenordner selbst liegen wuerden", () => {
  const { dataDir } = makeTempRoot();
  const result = runStartupBackup({
    dataDir,
    backupsDir: path.join(dataDir, "backups"),
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "backups-inside-data");
});
