"use strict";
/* Pinouts & Signals tab.
 * Left: connectors in the current harness. Center: visual pin map + pin table
 * for the selected connector — click any pin to pick its signal from a popup.
 * Right: signal (net) manager with search + type filtering. Wire colors live
 * on the signal, so the same signal is guaranteed the same color everywhere. */
const PinoutView = (() => {
  const { el } = UI;
  let connId = null;
  let editSig = null;       // signal id whose inline editor is open
  let filterText = "";      // signal list search
  let filterType = "";      // signal list type filter ("" = all)

  const TYPE_SUGGESTIONS = ["power", "ground", "data", "CAN", "sensor", "lighting", "ignition", "audio", "other"];

  function open(id) {
    connId = id;
    const found = Model.findConnector(id);
    if (found && Main.currentHarness().id !== found.harness.id) Main.setHarness(found.harness.id);
    Main.showTab("pinout");
    render();
  }

  function render() {
    const root = document.getElementById("tab-pinout");
    // keep each column's scroll position across re-renders
    const scrolls = {};
    for (const c of root.querySelectorAll(".col")) {
      for (const cls of ["col-list", "col-main", "col-side"]) {
        if (c.classList.contains(cls)) scrolls[cls] = c.scrollTop;
      }
    }
    root.innerHTML = "";
    const h = Main.currentHarness();
    if (!h) return;
    if (connId && !h.connectors.some((c) => c.id === connId)) connId = null;
    const cols = el("div", { class: "cols" });
    cols.appendChild(renderConnList(h));
    cols.appendChild(renderCenter(h));
    cols.appendChild(renderSignals());
    root.appendChild(cols);
    for (const [cls, top] of Object.entries(scrolls)) {
      const c = root.querySelector("." + cls);
      if (c) c.scrollTop = top;
    }
  }

  /* ---------- left: connector list ---------- */

  function renderConnList(h) {
    const col = el("div", { class: "col col-list" });
    col.appendChild(el("h3", {}, h.name));
    if (!h.connectors.length) {
      col.appendChild(el("div", { class: "hint-box" },
        "No connectors in this harness yet. Add connector points and attach connectors on the Layout tab first."));
    }
    for (const conn of h.connectors) {
      const spec = Model.connSpec(conn);
      const assigned = Model.assignedPins(conn).length;
      col.appendChild(el("div", {
        class: "list-item" + (conn.id === connId ? " selected" : ""),
        onclick: () => { connId = conn.id; render(); },
      },
        spec.imageData ? el("img", { class: "thumb", src: spec.imageData }) : el("div", { class: "thumb-ph" }, conn.libId ? "▦" : "◎"),
        el("span", { class: "name" }, conn.label,
          el("span", { class: "sub" }, `${spec.name} · ${assigned}/${spec.pinCount} pins assigned`))));
    }
    return col;
  }

  /* ---------- center: pin map ---------- */

  function renderCenter(h) {
    const col = el("div", { class: "col col-main" });
    const conn = h.connectors.find((c) => c.id === connId);
    if (!conn) {
      col.appendChild(el("div", { class: "hint-box", style: { maxWidth: "480px" } },
        "Select a connector on the left, then click any pin to assign a signal to it."));
      return col;
    }
    const spec = Model.connSpec(conn);
    col.appendChild(el("h3", {}, conn.label, el("span", { class: "muted" }, `  —  ${spec.name}`)));

    const mate = Model.mateFor(conn.id);
    if (mate) {
      const st = Model.mateStatus(mate);
      const otherId = mate.a === conn.id ? mate.b : mate.a;
      const other = Model.findConnector(otherId);
      col.appendChild(el("div", { class: st.ok ? "hint-box" : "warn-box" },
        st.ok ? "✓ " : "⚠ ",
        `Mated to "${other ? other.conn.label : "?"}" in ${other ? other.harness.name : "?"} — pinouts ${st.ok ? "match" : "DO NOT match"}. `,
        el("button", { class: "icon-btn", onclick: () => CompareView.openMate(mate) }, "Review in Compare")));
    }

    const row = el("div", { style: { display: "flex", gap: "22px", flexWrap: "wrap", alignItems: "flex-start" } });
    if (spec.imageData) row.appendChild(el("img", { src: spec.imageData, style: { maxWidth: "200px", maxHeight: "180px", borderRadius: "8px", background: "#0c0e13" } }));
    row.appendChild(el("div", {},
      UI.pinGrid(spec, {
        signalFor: (pin) => sigAt(conn, pin),
        titleFor: (pin) => {
          const s = sigAt(conn, pin);
          return `Pin ${Model.pinLabel(spec, pin)}: ` + (s ? `${s.name} (${UI.colorName(s.color)})` : "unassigned — click to assign");
        },
        onPinClick: (pin) => pickSignalForPin(conn, pin),
      }),
      el("div", { class: "muted small", style: { marginTop: "4px" } },
        "Click a pin to assign or change its signal.")));
    col.appendChild(row);

    /* pin table */
    const table = el("table", { class: "data", style: { maxWidth: "560px" } },
      el("tr", {}, el("th", {}, "Pin"), el("th", {}, "Signal"), el("th", {}, "Wire color"), el("th", {}, "")));
    for (let p = 1; p <= spec.pinCount; p++) {
      const s = sigAt(conn, p);
      table.appendChild(el("tr", { class: s ? "" : "status-empty" },
        el("td", {}, Model.pinLabel(spec, p)),
        el("td", { style: { cursor: "pointer" }, onclick: () => pickSignalForPin(conn, p) }, s ? s.name : "— click to assign —"),
        el("td", {}, s ? [UI.swatch(s.color), " ", el("span", { class: "muted small" }, UI.colorName(s.color) + (s.gauge ? ` · ${s.gauge}` : ""))] : ""),
        el("td", {}, s ? el("button", { class: "icon-btn", onclick: () => { delete conn.pins[p]; Model.changed(); } }, "clear") : "")));
    }
    col.appendChild(table);
    return col;
  }

  function sigAt(conn, pin) {
    const pa = conn.pins && conn.pins[pin];
    return pa && pa.signalId ? Model.signal(pa.signalId) : null;
  }

  /* Popup: pick a signal for a pin (same flow for terminals and multi-pin). */
  function pickSignalForPin(conn, pin) {
    conn.pins = conn.pins || {};
    const pinName = Model.pinLabel(Model.connSpec(conn), pin);
    const cur = conn.pins[pin] && conn.pins[pin].signalId;
    const wrap = el("div", {});
    const list = el("div", { class: "choice-list" });
    const sigButtons = [];
    for (const s of Model.get().signals) {
      const uses = Model.signalUses(s.id).length;
      const btn = el("button", {
        style: cur === s.id ? { borderColor: "var(--accent)" } : null,
        onclick: () => {
          UI.closeModal();
          conn.pins[pin] = { signalId: s.id };
          Model.changed();
        },
      },
        UI.swatch(s.color), " ", s.name,
        el("span", { class: "muted small" },
          (s.type ? ` · ${s.type}` : "") + (s.gauge ? ` · ${s.gauge}` : "") + ` · ${uses} pin${uses === 1 ? "" : "s"}` + (cur === s.id ? " · currently assigned" : "")));
      btn.dataset.search = (s.name + " " + (s.type || "")).toLowerCase();
      sigButtons.push(btn);
      list.appendChild(btn);
    }
    if (Model.get().signals.length > 6) {
      wrap.appendChild(el("input", {
        placeholder: "Filter signals…",
        style: { width: "100%", marginBottom: "8px" },
        oninput: (e) => {
          const q = e.target.value.trim().toLowerCase();
          for (const b of sigButtons) b.style.display = !q || b.dataset.search.includes(q) ? "" : "none";
        },
      }));
    }
    if (!Model.get().signals.length) {
      list.appendChild(el("div", { class: "muted" }, "No signals yet — create the first one:"));
    }
    list.appendChild(el("button", { onclick: () => {
      UI.closeModal();
      newSignal((sig) => { conn.pins[pin] = { signalId: sig.id }; Model.changed(); });
    } }, "＋ New signal…"));
    if (cur) {
      list.appendChild(el("button", { class: "danger", onclick: () => {
        UI.closeModal();
        delete conn.pins[pin];
        Model.changed();
      } }, "✕ Clear this pin"));
    }
    wrap.appendChild(list);
    const box = UI.modal(`Pin ${pinName} — ${conn.label}`, wrap, [{ label: "Cancel" }]);
    const search = box.querySelector("input");
    if (search) search.focus();
  }

  /* ---------- right: signals ---------- */

  function renderSignals() {
    const col = el("div", { class: "col col-side" });
    col.appendChild(el("div", { class: "side-row" },
      el("h3", { style: { flex: 1, margin: 0 } }, "Signals (nets)"),
      el("button", { class: "primary", onclick: () => newSignal((sig) => { editSig = sig.id; render(); }) }, "＋ New")));
    col.appendChild(el("div", { class: "side-row" },
      el("button", {
        class: "small", onclick: saveSignals,
        title: "Save this signal list to its own file, to reuse in other projects",
      }, "⭳ Save signals"),
      el("button", {
        class: "small", onclick: loadSignals,
        title: "Add signals from a saved list (or another project file) to this project",
      }, "⭱ Load signals")));

    const p = Model.get();
    if (!p.signals.length) {
      col.appendChild(el("div", { class: "hint-box" },
        "Signals work like nets in an ECAD tool: assign the same signal to pins on different connectors and they're assumed connected by a wire. ",
        "The wire color is defined once per signal, so it's automatically identical everywhere the signal appears."));
      return col;
    }

    /* filter controls */
    const types = [...new Set(p.signals.map((s) => (s.type || "").trim()).filter(Boolean))].sort();
    const listBox = el("div", {});
    const fillList = () => {
      listBox.innerHTML = "";
      const q = filterText.trim().toLowerCase();
      let shown = 0;
      for (const sig of p.signals) {
        const type = (sig.type || "").trim();
        if (filterType === "__untyped" ? type : (filterType && type !== filterType)) continue;
        if (q && !(sig.name + " " + type).toLowerCase().includes(q)) continue;
        shown++;
        const uses = Model.signalUses(sig.id);
        listBox.appendChild(el("div", {
          class: "sig-row" + (editSig === sig.id ? " active" : ""),
          onclick: () => { editSig = editSig === sig.id ? null : sig.id; render(); },
        },
          UI.swatch(sig.color),
          el("span", { class: "name" }, sig.name,
            sig.gauge ? el("span", { class: "muted small" }, ` ${sig.gauge}`) : null,
            type ? el("span", { class: "sig-type-tag" }, type) : null),
          el("span", { class: "uses" }, `${uses.length} pin${uses.length === 1 ? "" : "s"}`)));
        if (editSig === sig.id) listBox.appendChild(signalEditor(sig, uses));
      }
      if (!shown) listBox.appendChild(el("div", { class: "muted small" }, "No signals match the filter."));
    };

    if (filterType && filterType !== "__untyped" && !types.includes(filterType)) filterType = "";
    const typeSel = el("select", { style: { flex: "0 0 auto" }, onchange: (e) => { filterType = e.target.value; fillList(); } },
      el("option", { value: "" }, "All types"),
      types.map((t) => el("option", { value: t }, t)),
      el("option", { value: "__untyped" }, "(untyped)"));
    typeSel.value = filterType;
    col.appendChild(el("div", { class: "side-row", style: { flexWrap: "nowrap" } },
      el("input", {
        placeholder: "Search…", value: filterText, style: { flex: 1, minWidth: "60px" },
        oninput: (e) => { filterText = e.target.value; fillList(); },
      }),
      typeSel));

    fillList();
    col.appendChild(listBox);
    return col;
  }

  function saveSignals() {
    const p = Model.get();
    if (!p.signals.length) {
      UI.modal("Nothing to save", el("div", {}, "This project has no signals yet."), [{ label: "OK", primary: true }]);
      return;
    }
    UI.saveJSON("signal-list.json",
      { type: "harnessPlanner.signals", version: 1, source: p.name, signals: p.signals });
  }

  function loadSignals() {
    UI.openJSON((data, fname) => {
      const items = Model.listFrom(data, "signals");
      if (!items) {
        UI.modal("Load failed", el("div", {}, `"${fname}" doesn't contain a signal list.`), [{ label: "OK", primary: true }]);
        return;
      }
      const { added, skipped } = Model.mergeSignals(items);
      if (added) Model.changed();
      UI.modal("Signals loaded", el("div", {},
        `Added ${added} signal${added === 1 ? "" : "s"} from "${fname}".`,
        skipped ? el("div", { class: "muted small" }, `${skipped} skipped — that signal name is already in this project.`) : null),
        [{ label: "OK", primary: true }]);
    });
  }

  function newSignal(cb) {
    UI.promptText("New signal name", "", (name) => {
      const p = Model.get();
      if (p.signals.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
        UI.modal("Duplicate name", el("div", {}, `A signal named "${name}" already exists. Signal names must be unique — same name means same net.`), [{ label: "OK", primary: true }]);
        return;
      }
      const sig = {
        id: Model.uid("sig"),
        name,
        gauge: "",
        type: "",
        color: { style: "solid", base: UI.PALETTE[p.signals.length % UI.PALETTE.length], stripe: "#ffffff" },
      };
      p.signals.push(sig);
      Model.changed();
      if (cb) cb(sig);
    });
  }

  function signalEditor(sig, uses) {
    const box = el("div", { class: "sig-editor" });
    const typeList = el("datalist", { id: "sigTypeList" },
      [...new Set([...TYPE_SUGGESTIONS, ...Model.get().signals.map((s) => (s.type || "").trim()).filter(Boolean)])]
        .map((t) => el("option", { value: t })));
    box.appendChild(typeList);
    const grid = el("div", { class: "form-grid", style: { maxWidth: "100%" } });
    grid.append(
      el("label", {}, "Name"),
      el("input", { value: sig.name, onchange: (e) => { const v = e.target.value.trim(); if (v) sig.name = v; Model.changed(); } }),
      el("label", {}, "Type"),
      el("input", { value: sig.type || "", list: "sigTypeList", placeholder: "power, data, CAN…", onchange: (e) => { sig.type = e.target.value.trim(); Model.changed(); } }),
      el("label", {}, "Gauge"),
      el("input", { value: sig.gauge || "", placeholder: "e.g. 18 AWG", onchange: (e) => { sig.gauge = e.target.value; Model.changed(); } }),
      el("label", {}, "Style"),
      (() => {
        const sel = el("select", { onchange: (e) => { sig.color.style = e.target.value; Model.changed(); } },
          el("option", { value: "solid" }, "Solid"),
          el("option", { value: "striped" }, "Striped (tracer)"));
        sel.value = sig.color.style;
        return sel;
      })(),
      el("label", {}, "Base color"),
      colorPicker(sig, "base"),
    );
    if (sig.color.style === "striped") {
      grid.append(el("label", {}, "Stripe color"), colorPicker(sig, "stripe"));
    }
    box.appendChild(grid);
    box.appendChild(el("div", { class: "side-row", style: { marginTop: "8px" } },
      UI.swatch(sig.color, true),
      el("span", { class: "muted small" },
        `Used on ${uses.length} pin${uses.length === 1 ? "" : "s"} across ${new Set(uses.map((u) => u.conn.id)).size} connector(s). Color changes apply everywhere.`)));
    box.appendChild(el("div", { class: "side-row" },
      el("button", { class: "danger icon-btn", onclick: () => {
        const doIt = () => { Model.removeSignal(sig.id); editSig = null; Model.changed(); };
        if (uses.length) UI.confirmBox(`Delete "${sig.name}" and clear it from ${uses.length} pin(s)?`, doIt);
        else doIt();
      } }, "Delete signal")));
    box.addEventListener("click", (e) => e.stopPropagation());
    return box;
  }

  function colorPicker(sig, key) {
    const wrap = el("div", {},
      el("input", { type: "color", value: sig.color[key], onchange: (e) => { sig.color[key] = e.target.value; Model.changed(); } }),
      el("div", { class: "palette" },
        UI.PALETTE.map((c) => el("button", { style: { background: c }, title: c, onclick: () => { sig.color[key] = c; Model.changed(); } }))));
    return wrap;
  }

  return { render, open };
})();
