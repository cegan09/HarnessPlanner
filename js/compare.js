"use strict";
/* Compare / Mates tab: put two connectors side by side (usually from two
 * different harnesses) and check pin-for-pin that the signals line up.
 * "Link as mates" makes the relationship permanent — any later pinout edit
 * that breaks the match raises an alert until it's resolved. */
const CompareView = (() => {
  const { el } = UI;
  let aH = null, aC = null, bH = null, bC = null;

  function openMate(mate) {
    const A = Model.findConnector(mate.a), B = Model.findConnector(mate.b);
    if (A) { aH = A.harness.id; aC = A.conn.id; }
    if (B) { bH = B.harness.id; bC = B.conn.id; }
    Main.showTab("compare");
    render();
  }

  function render() {
    const root = document.getElementById("tab-compare");
    root.innerHTML = "";
    const p = Model.get();
    if (aH && !Model.harness(aH)) { aH = null; aC = null; }
    if (bH && !Model.harness(bH)) { bH = null; bC = null; }

    /* pickers */
    const pickers = el("div", { class: "compare-pickers" },
      sidePicker("Side A", aH, aC, (h, c) => { aH = h; aC = c; render(); }),
      el("div", { style: { alignSelf: "center", fontSize: "22px", color: "var(--muted)" } }, "⟷"),
      sidePicker("Side B", bH, bC, (h, c) => { bH = h; bC = c; render(); }),
      linkControls(),
    );
    root.appendChild(pickers);

    const body = el("div", { class: "compare-body" });

    /* pin-by-pin table */
    if (aC && bC && Model.findConnector(aC) && Model.findConnector(bC)) {
      body.appendChild(comparisonTable());
    } else {
      body.appendChild(el("div", { class: "hint-box", style: { maxWidth: "560px" } },
        "Pick a connector on each side to compare their pinouts pin-for-pin (pin 1 mates with pin 1, and so on). ",
        "Typically side A is a connector in one harness and side B is its mating connector in another harness. ",
        "Use “Link as mates” to keep them checked automatically from then on."));
    }

    /* mates list */
    body.appendChild(el("h4", {}, `Linked mates (${p.mates.length})`));
    if (!p.mates.length) {
      body.appendChild(el("div", { class: "muted small" }, "No linked mates yet."));
    } else {
      const table = el("table", { class: "data", style: { maxWidth: "760px" } },
        el("tr", {}, el("th", {}, "Side A"), el("th", {}, "Side B"), el("th", {}, "Status"), el("th", {}, "")));
      for (const mate of p.mates) {
        const st = Model.mateStatus(mate);
        const A = st.A, B = st.B;
        table.appendChild(el("tr", { class: st.ok ? "" : "status-mismatch" },
          el("td", {}, A ? `${A.conn.label} (${A.harness.name})` : "(deleted)"),
          el("td", {}, B ? `${B.conn.label} (${B.harness.name})` : "(deleted)"),
          el("td", {}, el("span", { class: "status-pill " + (st.ok ? "ok" : "mismatch") }, st.ok ? "✓ match" : "⚠ needs review")),
          el("td", {},
            el("button", { class: "icon-btn", onclick: () => openMate(mate) }, "View"),
            " ",
            el("button", { class: "icon-btn danger", onclick: () => {
              p.mates = p.mates.filter((m) => m.id !== mate.id);
              Model.changed();
            } }, "Unlink"))));
      }
      body.appendChild(table);
    }
    root.appendChild(body);
  }

  function sidePicker(title, hId, cId, cb) {
    const p = Model.get();
    const hSel = el("select", { onchange: (e) => cb(e.target.value || null, null) },
      el("option", { value: "" }, "— harness —"),
      p.harnesses.map((h) => el("option", { value: h.id }, h.name)));
    hSel.value = hId || "";
    const h = hId ? Model.harness(hId) : null;
    const cSel = el("select", { onchange: (e) => cb(hId, e.target.value || null) },
      el("option", { value: "" }, "— connector —"),
      (h ? h.connectors : []).map((c) => el("option", { value: c.id }, `${c.label} (${Model.connSpec(c).name})`)));
    cSel.value = cId || "";
    cSel.disabled = !h;
    return el("div", { class: "compare-side" },
      el("span", { class: "side-title" }, title), hSel, cSel);
  }

  function linkControls() {
    const p = Model.get();
    const wrap = el("div", { class: "compare-side", style: { marginLeft: "auto" } });
    if (!aC || !bC || !Model.findConnector(aC) || !Model.findConnector(bC)) return wrap;
    if (aC === bC) {
      wrap.appendChild(el("span", { class: "muted small" }, "Pick two different connectors."));
      return wrap;
    }
    const existing = p.mates.find((m) => (m.a === aC && m.b === bC) || (m.a === bC && m.b === aC));
    if (existing) {
      const st = Model.mateStatus(existing);
      wrap.appendChild(el("span", { class: "status-pill " + (st.ok ? "ok" : "mismatch") }, st.ok ? "✓ linked & matching" : "⚠ linked — mismatch"));
      wrap.appendChild(el("button", { class: "danger", onclick: () => {
        p.mates = p.mates.filter((m) => m.id !== existing.id);
        Model.changed();
      } }, "Unlink mates"));
    } else {
      const aMate = Model.mateFor(aC), bMate = Model.mateFor(bC);
      if (aMate || bMate) {
        wrap.appendChild(el("span", { class: "muted small" }, "One of these is already mated to another connector."));
      } else {
        wrap.appendChild(el("button", { class: "primary", onclick: () => {
          p.mates.push({ id: Model.uid("m"), a: aC, b: bC });
          Model.changed();
        } }, "🔗 Link as mates"));
      }
    }
    return wrap;
  }

  function comparisonTable() {
    const st = Model.mateStatus({ a: aC, b: bC });
    const wrap = el("div", {});
    const mismatches = st.rows.filter((r) => r.status === "mismatch").length;
    wrap.appendChild(el("div", { class: "side-row" },
      el("span", { class: "status-pill " + (st.ok ? "ok" : "mismatch") },
        st.ok ? "✓ Pinouts match" : `⚠ ${mismatches} pin(s) don't match`)));
    const table = el("table", { class: "data", style: { maxWidth: "820px" } },
      el("tr", {},
        el("th", {}, "Pin"),
        el("th", {}, `A: ${st.A.conn.label}`),
        el("th", {}, `B: ${st.B.conn.label}`),
        el("th", {}, "Status")));
    const specA = Model.connSpec(st.A.conn), specB = Model.connSpec(st.B.conn);
    for (const r of st.rows) {
      const la = Model.pinLabel(specA, r.pin), lb = Model.pinLabel(specB, r.pin);
      table.appendChild(el("tr", { class: "status-" + r.status },
        el("td", {}, la === lb ? la : `${la} / ${lb}`),
        sigCell(r.a),
        sigCell(r.b),
        el("td", {}, r.status === "ok" ? el("span", { class: "status-pill ok" }, "✓")
          : r.status === "mismatch" ? el("span", { class: "status-pill mismatch" }, "✗")
          : el("span", { class: "status-pill empty" }, r.status === "nopin" ? "n/a" : "—"))));
    }
    wrap.appendChild(table);
    return wrap;
  }

  function sigCell(sigId) {
    if (!sigId) return el("td", {}, "—");
    const s = Model.signal(sigId);
    if (!s) return el("td", {}, "(deleted signal)");
    return el("td", {}, UI.swatch(s.color), " " + s.name);
  }

  return { render, openMate };
})();
