"use strict";

// Zuschlags-Cockpit (Phase 1). Klassisches Script - kein Modul, kein
// Top-Level-return.
(function () {
  const API = "/api/subsidies";

  const state = {
    view: "alle",
    month: "alle",
    art: "alle",
    search: "",
    includeArchived: false,
    records: [],
  };

  const ART_LABEL = {
    STANDGELD: "Standgeld",
    RETOURE: "Retoure",
    AUSFALLFRACHT: "Ausfallfracht",
    ZWEITE_ANLIEFERUNG: "Zweite Anlieferung",
    AFF: "AFF",
    SONSTIGES: "Sonstiges",
  };

  const STATUS_LABEL = {
    UNBEKANNT: "Unbekannt",
    OFFEN: "Offen",
    AKZEPTIERT: "Akzeptiert",
    ABGELEHNT: "Abgelehnt",
    PRUEFEN: "Prüfen",
  };

  const QUELLE_LABEL = {
    manuell: "Manuell",
    standgeld_app: "Standgeld-App",
    transporeon_excel: "Transporeon-Excel",
    transporeon_email: "Transporeon-E-Mail",
  };

  function $(id) {
    return document.getElementById(id);
  }

  function euro(value) {
    if (value === null || value === undefined || value === "") return "-";
    const num = Number(value);
    if (!Number.isFinite(num)) return "-";
    return num.toLocaleString("de-DE", {
      style: "currency",
      currency: "EUR",
    });
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }

  function statusBadge(record) {
    let cls = "subsidy-status subsidy-status-unbekannt";
    let text = STATUS_LABEL[record.status] || record.status;
    if (record.status === "OFFEN") cls = "subsidy-status subsidy-status-offen";
    else if (record.status === "ABGELEHNT")
      cls = "subsidy-status subsidy-status-abgelehnt";
    else if (record.status === "PRUEFEN")
      cls = "subsidy-status subsidy-status-pruefen";
    else if (record.status === "AKZEPTIERT") {
      if (record.tl_erfasst) {
        cls = "subsidy-status subsidy-status-abgeschlossen";
        text = "Abgeschlossen";
      } else {
        cls = "subsidy-status subsidy-status-akzeptiert";
      }
    }
    if (record.pruefung_erforderlich && record.status !== "PRUEFEN") {
      cls = "subsidy-status subsidy-status-pruefen";
      text = "Prüfen";
    }
    return '<span class="' + cls + '">' + esc(text) + "</span>";
  }

  async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(API + path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const msg =
        (data.errors && data.errors.join(" ")) || data.error || res.statusText;
      throw new Error(msg);
    }
    return data;
  }

  function buildQuery() {
    const params = new URLSearchParams();
    if (state.view && state.view !== "alle") params.set("view", state.view);
    if (state.month && state.month !== "alle") params.set("month", state.month);
    if (state.art && state.art !== "alle") params.set("art", state.art);
    if (state.search) params.set("search", state.search);
    if (state.includeArchived) params.set("includeArchived", "1");
    const q = params.toString();
    return q ? "?" + q : "";
  }

  function fillMonths(records) {
    const sel = $("filterMonth");
    const current = sel.value;
    const months = new Set();
    records.forEach((r) => {
      const d = r.antragsdatum || r.created_at || "";
      if (d && d.length >= 7) months.add(d.slice(0, 7));
    });
    const sorted = Array.from(months).sort().reverse();
    sel.innerHTML = '<option value="alle">Alle Monate</option>';
    sorted.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      sel.appendChild(opt);
    });
    if (current && (current === "alle" || months.has(current))) {
      sel.value = current;
    }
  }

  async function refreshStats() {
    try {
      const q =
        state.month && state.month !== "alle" ? "?month=" + state.month : "";
      const data = await api("GET", "/stats" + q);
      const s = data.stats || {};
      $("kpiCount").textContent = s.anzahl != null ? s.anzahl : "-";
      $("kpiBeantragt").textContent = euro(s.beantragt_summe);
      $("kpiTlOffen").textContent = euro(s.akzeptiert_tl_offen_summe);
      $("kpiAbgelehnt").textContent = euro(s.abgelehnt_summe);
    } catch (err) {
      // KPIs sind nicht kritisch - Fehler nur still ignorieren.
    }
  }

  function actionButtons(r) {
    const btns = [];
    btns.push(
      '<button type="button" class="btn-secondary" data-act="detail" data-id="' +
        r.id +
        '">Details</button>',
    );
    if (!r.archiviert) {
      if (r.status !== "AKZEPTIERT") {
        btns.push(
          '<button type="button" data-act="akzeptieren" data-id="' +
            r.id +
            '">Akzeptieren</button>',
        );
      }
      if (r.status !== "ABGELEHNT") {
        btns.push(
          '<button type="button" class="btn-secondary" data-act="ablehnen" data-id="' +
            r.id +
            '">Ablehnen</button>',
        );
      }
      if (r.status !== "PRUEFEN") {
        btns.push(
          '<button type="button" class="btn-secondary" data-act="pruefen" data-id="' +
            r.id +
            '">Prüfen</button>',
        );
      }
      if (r.status === "AKZEPTIERT" && !r.tl_erfasst) {
        btns.push(
          '<button type="button" data-act="tl" data-id="' +
            r.id +
            '">TL erfasst</button>',
        );
      }
      btns.push(
        '<button type="button" class="btn-secondary" data-act="archiv" data-id="' +
          r.id +
          '">Archivieren</button>',
      );
    }
    return '<div class="subsidy-actions">' + btns.join("") + "</div>";
  }

  function renderRows() {
    const tbody = $("rows");
    if (!state.records.length) {
      tbody.innerHTML =
        '<tr><td colspan="10">Keine Zuschläge gefunden.</td></tr>';
      return;
    }
    tbody.innerHTML = state.records
      .map((r) => {
        return (
          "<tr>" +
          "<td>" +
          esc(r.cola_nummer) +
          "</td>" +
          "<td>" +
          esc(ART_LABEL[r.zuschlagsart] || r.zuschlagsart) +
          "</td>" +
          "<td>" +
          euro(r.beantragte_summe) +
          "</td>" +
          "<td>" +
          euro(r.genehmigte_summe) +
          "</td>" +
          "<td>" +
          esc(r.antragsdatum || "-") +
          "</td>" +
          "<td>" +
          esc(r.lade_oder_entladestelle || "-") +
          "</td>" +
          "<td>" +
          esc(QUELLE_LABEL[r.quelle] || r.quelle || "-") +
          "</td>" +
          "<td>" +
          statusBadge(r) +
          "</td>" +
          "<td>" +
          (r.tl_erfasst ? "✔" : "–") +
          "</td>" +
          "<td>" +
          actionButtons(r) +
          "</td>" +
          "</tr>"
        );
      })
      .join("");
  }

  async function load() {
    $("status").textContent = "Lade …";
    try {
      const data = await api("GET", "/" + buildQuery());
      state.records = data.records || [];
      renderRows();
      fillMonths(state.records);
      await refreshStats();
      $("status").textContent =
        state.records.length + " Zuschlag/Zuschläge angezeigt.";
    } catch (err) {
      $("status").textContent = "Fehler beim Laden: " + err.message;
    }
  }

  async function showDetail(id) {
    try {
      const data = await api("GET", "/" + id);
      const r = data.record;
      const hist = data.history || [];
      const histRows = hist
        .slice()
        .reverse()
        .map((h) => {
          return (
            "<tr><td>" +
            esc(h.ts) +
            "</td><td>" +
            esc(h.actor || "-") +
            "</td><td>" +
            esc(h.field) +
            "</td><td>" +
            esc(h.from == null ? "-" : h.from) +
            "</td><td>" +
            esc(h.to == null ? "-" : h.to) +
            "</td></tr>"
          );
        })
        .join("");

      const details = r.standgeld_details || {};
      const detailLines = Object.keys(details).length
        ? "<p><strong>Standgeld-Daten:</strong> " +
          esc(JSON.stringify(details)) +
          "</p>"
        : "";

      $("detailBody").innerHTML =
        '<div class="summary">' +
        "<div><strong>Cola-Nr.:</strong> " +
        esc(r.cola_nummer) +
        " <small>(" +
        esc(r.cola_nummer_original || "-") +
        ")</small></div>" +
        "<div><strong>Art:</strong> " +
        esc(ART_LABEL[r.zuschlagsart] || r.zuschlagsart) +
        "</div>" +
        "<div><strong>Status:</strong> " +
        statusBadge(r) +
        "</div>" +
        "<div><strong>Zuschlags-ID:</strong> " +
        esc(r.zuschlags_id || "-") +
        "</div>" +
        "</div>" +
        "<p><strong>Beantragt:</strong> " +
        euro(r.beantragte_summe) +
        " · <strong>Genehmigt:</strong> " +
        euro(r.genehmigte_summe) +
        "</p>" +
        '<div class="grid grid-3">' +
        '<label>Genehmigte Summe (€)<input id="editGenehmigt" type="text" value="' +
        esc(r.genehmigte_summe != null ? r.genehmigte_summe : "") +
        '" /></label>' +
        '<label>Bemerkung<input id="editBemerkung" type="text" value="' +
        esc(r.bemerkung || "") +
        '" /></label>' +
        '<label style="align-self:end"><button type="button" id="saveDetailBtn" data-id="' +
        r.id +
        '">Speichern</button></label>' +
        "</div>" +
        "<p><strong>Grund:</strong> " +
        esc(r.grund || "-") +
        " · <strong>Stelle:</strong> " +
        esc(r.lade_oder_entladestelle || "-") +
        " · <strong>Quelle:</strong> " +
        esc(QUELLE_LABEL[r.quelle] || r.quelle || "-") +
        "</p>" +
        detailLines +
        "<h3>Historie</h3>" +
        '<div class="table-wrap"><table><thead><tr><th>Zeit</th><th>Wer</th><th>Feld</th><th>Von</th><th>Nach</th></tr></thead><tbody>' +
        (histRows || '<tr><td colspan="5">Keine Historie.</td></tr>') +
        "</tbody></table></div>";

      $("detailPanel").hidden = false;
      $("detailPanel").scrollIntoView({ behavior: "smooth" });

      const saveBtn = $("saveDetailBtn");
      if (saveBtn) {
        saveBtn.addEventListener("click", async () => {
          try {
            await api("PATCH", "/" + r.id, {
              genehmigte_summe: $("editGenehmigt").value,
              bemerkung: $("editBemerkung").value,
            });
            await load();
            await showDetail(r.id);
          } catch (err) {
            alert("Speichern fehlgeschlagen: " + err.message);
          }
        });
      }
    } catch (err) {
      alert("Details konnten nicht geladen werden: " + err.message);
    }
  }

  async function handleAction(act, id) {
    try {
      if (act === "detail") return showDetail(id);
      if (act === "akzeptieren") {
        await api("PATCH", "/" + id, { status: "AKZEPTIERT" });
      } else if (act === "ablehnen") {
        await api("PATCH", "/" + id, { status: "ABGELEHNT" });
      } else if (act === "pruefen") {
        await api("PATCH", "/" + id, {
          status: "PRUEFEN",
          pruefung_erforderlich: true,
        });
      } else if (act === "tl") {
        await api("POST", "/" + id + "/tl-erfasst");
      } else if (act === "archiv") {
        if (!confirm("Diesen Zuschlag wirklich archivieren?")) return;
        await api("POST", "/" + id + "/archive");
      }
      await load();
    } catch (err) {
      alert("Aktion fehlgeschlagen: " + err.message);
    }
  }

  async function createSubsidy() {
    const btn = $("createBtn");
    btn.disabled = true;
    $("createStatus").textContent = "";
    try {
      const payload = {
        cola_nummer: $("newCola").value,
        zuschlagsart: $("newArt").value,
        beantragte_summe: $("newSumme").value,
        antragsdatum: $("newDatum").value,
        lade_oder_entladestelle: $("newStelle").value,
        zuschlags_id: $("newZuschlagsId").value,
        grund: $("newGrund").value,
        bemerkung: $("newBemerkung").value,
        quelle: "manuell",
      };
      await api("POST", "/", payload);
      $("createStatus").textContent = "Zuschlag angelegt.";
      [
        "newCola",
        "newSumme",
        "newStelle",
        "newZuschlagsId",
        "newGrund",
        "newBemerkung",
      ].forEach((idv) => {
        $(idv).value = "";
      });
      await load();
    } catch (err) {
      $("createStatus").textContent = "Fehler: " + err.message;
    } finally {
      btn.disabled = false;
    }
  }

  // Zuletzt geladene Datei merken, damit Vorschau und Übernehmen dieselbe
  // Datei nutzen.
  let importBuffer = null;

  async function runImport(dryRun) {
    const fileInput = $("importFile");
    const file = fileInput.files && fileInput.files[0];
    if (!file && !importBuffer) {
      $("importStatus").textContent = "Bitte zuerst eine .xlsx-Datei wählen.";
      return;
    }
    const previewBtn = $("importPreviewBtn");
    const applyBtn = $("importApplyBtn");
    previewBtn.disabled = true;
    applyBtn.disabled = true;
    $("importStatus").textContent = dryRun
      ? "Vorschau wird erstellt …"
      : "Abgleich wird übernommen …";
    try {
      if (file) importBuffer = await file.arrayBuffer();
      const res = await fetch(
        API + "/import" + (dryRun ? "?dryRun=1" : ""),
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: importBuffer,
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || res.statusText);
      }
      renderImportResult(data);
      $("importStatus").textContent = dryRun
        ? "Vorschau erstellt. Bei Bedarf „Abgleich übernehmen“ klicken."
        : "Abgleich übernommen.";
      // Nach echter Übernahme Liste/Kennzahlen neu laden.
      if (!dryRun) {
        importBuffer = null;
        fileInput.value = "";
        applyBtn.disabled = true;
        await load();
      }
    } catch (err) {
      $("importStatus").textContent = "Fehler: " + err.message;
    } finally {
      previewBtn.disabled = false;
      // „Übernehmen“ nur freigeben, wenn eine Datei bereitsteht.
      if (importBuffer) applyBtn.disabled = false;
    }
  }

  function renderImportResult(data) {
    const box = $("importResult");
    const s = data.summary || {};
    const rows = [];
    rows.push(
      `<p><strong>${data.dryRun ? "Vorschau" : "Ergebnis"}</strong> · Blatt „${esc(data.sheet)}“ · ${Number(data.rows) || 0} Zeilen</p>`,
    );
    rows.push(
      `<div class="summary">
        <div><strong>Aktualisiert:</strong> ${s.update || 0}</div>
        <div><strong>Unverändert:</strong> ${s.noop || 0}</div>
        <div><strong>Prüfen:</strong> ${s.pruefen || 0}</div>
        <div><strong>Kein Treffer:</strong> ${s.no_match || 0}</div>
        <div><strong>Parse-Fehler:</strong> ${s.parseFehler || 0}</div>
      </div>`,
    );

    function detailTable(title, items, cols) {
      if (!items || !items.length) return "";
      const head = cols.map((c) => `<th>${esc(c.label)}</th>`).join("");
      const body = items
        .slice(0, 50)
        .map((it) => {
          const tds = cols
            .map((c) => `<td>${esc(c.get(it))}</td>`)
            .join("");
          return `<tr>${tds}</tr>`;
        })
        .join("");
      const more =
        items.length > 50
          ? `<p class="status">… und ${items.length - 50} weitere.</p>`
          : "";
      return `<h3>${esc(title)} (${items.length})</h3>
        <table class="subsidy-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${more}`;
    }

    rows.push(
      detailTable("Zu prüfen", data.pruefen, [
        { label: "Zuschlags-ID", get: (x) => x.zuschlags_id },
        { label: "Cola-Nr.", get: (x) => x.cola_nummer },
        { label: "Betrag", get: (x) => euro(x.betrag) },
        { label: "Grund", get: (x) => x.reason },
      ]),
    );
    rows.push(
      detailTable("Kein Treffer im Cockpit", data.noMatch, [
        { label: "Zuschlags-ID", get: (x) => x.zuschlags_id },
        { label: "Cola-Nr.", get: (x) => x.cola_nummer },
        { label: "Art", get: (x) => ART_LABEL[x.zuschlagsart] || x.zuschlagsart || "-" },
        { label: "Betrag", get: (x) => euro(x.betrag) },
        { label: "Status", get: (x) => STATUS_LABEL[x.status] || x.status },
      ]),
    );
    if (data.parseErrors && data.parseErrors.length) {
      rows.push(
        `<h3>Fehlerhafte Zeilen (${data.parseErrors.length})</h3>
        <p class="status">${esc(
          data.parseErrors
            .slice(0, 20)
            .map((e) => `Zeile ${Number(e.index) + 2}: ${e.errors.join(", ")}`)
            .join(" · "),
        )}</p>`,
      );
    }

    box.innerHTML = rows.join("");
    box.hidden = false;
  }

  function wire() {
    $("tabs").addEventListener("click", (ev) => {
      const btn = ev.target.closest(".tab-btn");
      if (!btn) return;
      Array.from($("tabs").children).forEach((b) =>
        b.classList.remove("active"),
      );
      btn.classList.add("active");
      state.view = btn.getAttribute("data-view");
      load();
    });

    $("rows").addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-act]");
      if (!btn) return;
      handleAction(btn.getAttribute("data-act"), btn.getAttribute("data-id"));
    });

    $("filterMonth").addEventListener("change", (ev) => {
      state.month = ev.target.value;
      load();
    });
    $("filterArt").addEventListener("change", (ev) => {
      state.art = ev.target.value;
      load();
    });
    let searchTimer = null;
    $("filterSearch").addEventListener("input", (ev) => {
      clearTimeout(searchTimer);
      const value = ev.target.value.trim();
      searchTimer = setTimeout(() => {
        state.search = value;
        load();
      }, 250);
    });
    $("filterArchived").addEventListener("change", (ev) => {
      state.includeArchived = ev.target.checked;
      load();
    });
    $("createBtn").addEventListener("click", createSubsidy);

    $("importPreviewBtn").addEventListener("click", () => runImport(true));
    $("importApplyBtn").addEventListener("click", () => runImport(false));
    $("importFile").addEventListener("change", () => {
      importBuffer = null;
      $("importApplyBtn").disabled = true;
      $("importResult").hidden = true;
      $("importStatus").textContent = "";
    });

    const today = new Date().toISOString().slice(0, 10);
    $("newDatum").value = today;
  }

  document.addEventListener("DOMContentLoaded", () => {
    wire();
    load();
  });
})();
