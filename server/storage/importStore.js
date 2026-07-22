"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_ROOT = path.join(__dirname, "..", "..", "data", "imports");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function generateImportId(now = new Date()) {
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = Math.random().toString(16).slice(2, 8);
  return `imp-${stamp}-${rand}`;
}

function extractLocalDate(value) {
  const match = String(value || "")
    .trim()
    .match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function summarizeTransports(transports) {
  const list = Array.isArray(transports) ? transports : [];
  const unloadDates = list
    .map((transport) => {
      const stop = transport?.unloading || null;
      return (
        extractLocalDate(stop?.window_local) ||
        extractLocalDate(stop?.arrival_local) ||
        extractLocalDate(stop?.departure_local) ||
        null
      );
    })
    .filter(Boolean)
    .sort();

  return {
    transport_count: list.length,
    unload_date_from: unloadDates[0] || null,
    unload_date_to: unloadDates[unloadDates.length - 1] || null,
  };
}

class ImportStore {
  constructor(options = {}) {
    this.root = options.root || DEFAULT_ROOT;
    this.filesDir = path.join(this.root, "files");
    this.metaDir = path.join(this.root, "meta");
  }

  init() {
    ensureDir(this.filesDir);
    ensureDir(this.metaDir);
  }

  saveImport({ buffer, fileName, transports }) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new Error("Leerer Import kann nicht gespeichert werden.");
    }

    this.init();
    const id = generateImportId();
    const ext = path.extname(String(fileName || "").trim()) || ".xlsx";
    const storedFileName = `${id}${ext}`;
    const filePath = path.join(this.filesDir, storedFileName);
    const importedAt = new Date().toISOString();
    const summary = summarizeTransports(transports);

    fs.writeFileSync(filePath, buffer, { flag: "wx" });

    const meta = {
      id,
      file_name: String(fileName || storedFileName).trim() || storedFileName,
      stored_file_name: storedFileName,
      imported_at: importedAt,
      ...summary,
    };

    fs.writeFileSync(
      path.join(this.metaDir, `${id}.json`),
      JSON.stringify(meta, null, 2),
      { flag: "wx" },
    );

    return meta;
  }

  listImports() {
    this.init();
    return fs
      .readdirSync(this.metaDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(this.metaDir, name), "utf8")),
      )
      .sort((a, b) =>
        String(b.imported_at).localeCompare(String(a.imported_at)),
      );
  }

  getImport(importId) {
    this.init();
    const id = String(importId || "").trim();
    if (!id) return null;
    const file = path.join(this.metaDir, `${id}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  resolveImportFile(importId) {
    const meta = this.getImport(importId);
    if (!meta) return null;
    const filePath = path.join(
      this.filesDir,
      String(meta.stored_file_name || ""),
    );
    return fs.existsSync(filePath) ? filePath : null;
  }

  deleteImport(importId) {
    this.init();
    const meta = this.getImport(importId);
    if (!meta) return false;

    const metaPath = path.join(this.metaDir, `${meta.id}.json`);
    const filePath = path.join(
      this.filesDir,
      String(meta.stored_file_name || ""),
    );

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    if (fs.existsSync(metaPath)) {
      fs.unlinkSync(metaPath);
    }

    return true;
  }
}

module.exports = {
  DEFAULT_ROOT,
  ImportStore,
  generateImportId,
};
