"use strict";

const el = {
  freeMinutes: document.getElementById("freeMinutes"),
  blockMinutes: document.getElementById("blockMinutes"),
  blockRateEur: document.getElementById("blockRateEur"),
  triggerMinutes: document.getElementById("triggerMinutes"),
  lateArrivalGraceMinutes: document.getElementById("lateArrivalGraceMinutes"),
  exportFile: document.getElementById("exportFile"),
  windowsFile: document.getElementById("windowsFile"),
  scope: document.getElementById("scope"),
  sixfoldUrl: document.getElementById("sixfoldUrl"),
  sixfoldToken: document.getElementById("sixfoldToken"),
  uploadWindowsBtn: document.getElementById("uploadWindowsBtn"),
  runBtn: document.getElementById("runBtn"),
  status: document.getElementById("status"),
  resultPanel: document.getElementById("resultPanel"),
  importId: document.getElementById("importId"),
  transportCount: document.getElementById("transportCount"),
  stopCount: document.getElementById("stopCount"),
  unloadStopCount: document.getElementById("unloadStopCount"),
  chargeableCount: document.getElementById("chargeableCount"),
  totalFee: document.getElementById("totalFee"),
  fallbackApplied: document.getElementById("fallbackApplied"),
  checks: document.getElementById("checks"),
};

function setStatus(text, type = "info") {
  el.status.textContent = text;
  el.status.style.color =
    type === "error" ? "#b91c1c" : type === "success" ? "#166534" : "#73675a";
}

function euro(value) {
  return Number(value || 0).toLocaleString("de-DE", {
    style: "currency",
    currency: "EUR",
  });
}

function addCheckRow(label, value) {
  const tr = document.createElement("tr");
  tr.innerHTML = `<td>${label}</td><td>${value}</td>`;
  el.checks.appendChild(tr);
}

function sixfoldHeaders() {
  const headers = {};
  const url = String(el.sixfoldUrl.value || "").trim();
  const token = String(el.sixfoldToken.value || "").trim();
  if (url && token) {
    headers["x-sixfold-url"] = url;
    headers["x-sixfold-token"] = token;
  }
  return headers;
}

function billingParams(exportName) {
  const params = new URLSearchParams();
  params.set("scope", String(el.scope.value || "fernverkehr"));
  params.set("name", exportName || "upload.xlsx");
  params.set("freeMinutes", String(el.freeMinutes.value || 120));
  params.set("blockMinutes", String(el.blockMinutes.value || 30));
  params.set("blockRateEur", String(el.blockRateEur.value || 30));
  params.set("triggerMinutes", String(el.triggerMinutes.value || 10));
  params.set("lateArrivalGraceEnabled", "1");
  params.set(
    "lateArrivalGraceMinutes",
    String(el.lateArrivalGraceMinutes.value || 45),
  );
  params.set("allowPartialLive", "0");
  return params;
}

async function uploadWindows() {
  const file = el.windowsFile.files && el.windowsFile.files[0];
  if (!file) {
    setStatus("Bitte Entladezeitfenster-Excel auswählen.", "error");
    return;
  }

  el.uploadWindowsBtn.disabled = true;
  try {
    setStatus(`Importiere Zeitfenster aus ${file.name} ...`);
    const scope = encodeURIComponent(String(el.scope.value || "fernverkehr"));
    const res = await fetch(`/api/windows/upload?scope=${scope}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    setStatus(
      `Zeitfenster importiert: ${data.windows_count || 0} Zeilen erkannt.`,
      "success",
    );
  } catch (error) {
    setStatus(error.message || "Zeitfenster-Import fehlgeschlagen.", "error");
  } finally {
    el.uploadWindowsBtn.disabled = false;
  }
}

async function runSeparatedBilling() {
  const exportFile = el.exportFile.files && el.exportFile.files[0];
  if (!exportFile) {
    setStatus("Bitte Touren-Export auswählen.", "error");
    return;
  }

  const gps = sixfoldHeaders();
  if (!gps["x-sixfold-url"] || !gps["x-sixfold-token"]) {
    setStatus("Bitte Sixfold-Link und Session-Token eintragen.", "error");
    return;
  }

  el.runBtn.disabled = true;
  el.resultPanel.hidden = true;
  el.checks.innerHTML = "";

  try {
    setStatus(
      "Führe separaten Lauf aus: Upload, Abrechnung, Ladenummer- und Sixfold-Prüfung ...",
    );

    const params = billingParams(exportFile.name);
    const billingRes = await fetch(`/api/billing/upload?${params.toString()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        ...gps,
      },
      body: exportFile,
    });
    const billingData = await billingRes.json();
    if (!billingRes.ok) {
      throw new Error(billingData.error || `HTTP ${billingRes.status}`);
    }

    const importId = String(billingData.import?.id || "").trim();
    const scope = encodeURIComponent(String(el.scope.value || "fernverkehr"));

    const [debugData, selectiveData] = await Promise.all([
      (async () => {
        if (!importId) return null;
        const res = await fetch(
          `/api/windows/debug?scope=${scope}&importId=${encodeURIComponent(importId)}`,
        );
        const data = await res.json();
        return res.ok ? data : null;
      })(),
      (async () => {
        const res = await fetch("/api/sixfold/selective-match", {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            ...gps,
          },
          body: exportFile,
        });
        const data = await res.json();
        return res.ok ? data : null;
      })(),
    ]);

    const summary = billingData.summary || {};
    const stops = Array.isArray(billingData.stops) ? billingData.stops : [];
    const unloadCount = stops.filter((s) => s.stop_type === "UNLOADING").length;

    el.importId.textContent = importId || "-";
    el.transportCount.textContent = String(summary.transport_count ?? "-");
    el.stopCount.textContent = String(summary.stop_count ?? "-");
    el.unloadStopCount.textContent = String(unloadCount);
    el.chargeableCount.textContent = String(summary.chargeable_count ?? "-");
    el.totalFee.textContent =
      summary.total_fee_display || euro(summary.total_fee_eur);
    el.fallbackApplied.textContent = `${summary.fallback_applied || 0}/${summary.fallback_candidates || 0}`;

    addCheckRow(
      "Excel-Fallback überschreibt TP-Fenster",
      String(summary.fallback_overridden_existing || 0),
    );
    addCheckRow(
      "Excel-Fallback bereits identisch",
      String(summary.fallback_already_matching || 0),
    );

    if (debugData && debugData.match_test) {
      const mt = debugData.match_test;
      addCheckRow(
        "Ladenummer-Matches (Import ↔ Zeitfenster)",
        `${mt.matched || 0}/${mt.total || 0}`,
      );
      addCheckRow(
        "Davon würden fehlende Entladefenster gefüllt",
        String(mt.would_fill_missing || 0),
      );
      addCheckRow(
        "Davon würden vorhandene TP-Fenster überschrieben",
        String(mt.would_override_existing || 0),
      );
    } else {
      addCheckRow(
        "Ladenummer-Matchtest",
        "Nicht verfügbar (kein Import-ID Matchtest)",
      );
    }

    if (selectiveData && selectiveData.summary) {
      const ss = selectiveData.summary;
      addCheckRow(
        "Sixfold-Matches (Transportnummer)",
        `${ss.matched_count || 0}/${ss.total_excel || 0}`,
      );
      addCheckRow("Kennzeichen-Matches", String(ss.plate_matches_count || 0));
      addCheckRow(
        "Kennzeichen-Mismatches",
        String(ss.plate_mismatches_count || 0),
      );
      addCheckRow("Nur in Excel", String(ss.only_in_excel_count || 0));
    } else {
      addCheckRow("Sixfold-Abgleich", "Nicht verfügbar");
    }

    if (unloadCount === 0) {
      addCheckRow(
        "Hinweis",
        "Im Touren-Export wurden keine Entlade-Stopps erkannt. Dann kann kein Entladezeitfenster greifen.",
      );
    }

    el.resultPanel.hidden = false;
    setStatus("Separater Lauf abgeschlossen.", "success");
  } catch (error) {
    setStatus(error.message || "Separater Lauf fehlgeschlagen.", "error");
  } finally {
    el.runBtn.disabled = false;
  }
}

el.uploadWindowsBtn.addEventListener("click", uploadWindows);
el.runBtn.addEventListener("click", runSeparatedBilling);
