"use strict";
/* Build Sheet tab: the cut list. Every physical wire with its signal, color,
 * gauge, both endpoints and its length — including wires that run from a
 * splice, so you know how long each leg into a splice needs to be. */
const BuildSheetView = (() => {
  const { el } = UI;
  let scope = "current";   // current | all

  const round = (v) => Math.round(v * 10) / 10;

  function render() {
    const root = document.getElementById("tab-build");
    const prev = root.querySelector(".compare-body");
    const top = prev ? prev.scrollTop : 0;
    root.innerHTML = "";

    const p = Model.get();
    const harnesses = scope === "all" ? p.harnesses : [Main.currentHarness()].filter(Boolean);

    /* toolbar */
    const scopeSel = el("select", { onchange: (e) => { scope = e.target.value; render(); } },
      el("option", { value: "current" }, "This harness"),
      el("option", { value: "all" }, "All harnesses"));
    scopeSel.value = scope;
    root.appendChild(el("div", { class: "compare-pickers" },
      el("div", { class: "compare-side" }, el("span", { class: "side-title" }, "Scope"), scopeSel),
      el("div", { class: "compare-side" }, el("span", { class: "side-title" }, " "),
        el("div", { class: "side-row" },
          el("button", { onclick: () => exportCSV(harnesses) }, "⭳ Export CSV"),
          el("button", { onclick: () => window.print() }, "🖨 Print")))));

    const body = el("div", { class: "compare-body" });
    for (const h of harnesses) body.appendChild(harnessSection(h));
    root.appendChild(body);
    body.scrollTop = top;
  }

  function harnessSection(h) {
    const wrap = el("div", { class: "sheet-section" });
    const unit = Model.get().unit;
    const { wires, points, singles, warnings } = Routing.computeRuns(h);
    const rows = wires.map((w) => ({
      run: w,
      len: Routing.runLength(h, w),
      from: Routing.endInfo(h, w.fromKey, w.sig),
      to: Routing.endInfo(h, w.toKey, w.sig),
    }));
    // wires read better running pin -> splice than splice -> pin
    for (const r of rows) {
      if (r.from.kind === "splice" && r.to.kind === "pin") { const t = r.from; r.from = r.to; r.to = t; }
    }

    wrap.appendChild(el("h3", {}, h.name,
      el("span", { class: "muted small" }, `  ${rows.length} wire${rows.length === 1 ? "" : "s"}`)));

    /* warnings */
    const noLen = rows.filter((r) => r.len.incomplete).length;
    if (noLen) {
      wrap.appendChild(el("div", { class: "warn-box" },
        `⚠ ${noLen} wire${noLen === 1 ? " has" : "s have"} an incomplete length — some legs on the path have no length set yet. `,
        "Select a leg on the Layout tab and enter its length."));
    }
    for (const w of [...new Set(warnings)]) {
      wrap.appendChild(el("div", { class: "warn-box" }, "⚠ " + w));
    }
    if (singles.length) {
      wrap.appendChild(el("div", { class: "hint-box" },
        `${singles.map((s) => s.sig.name).join(", ")} ${singles.length === 1 ? "is" : "are"} assigned to only one pin in this harness, `,
        "so no wire is listed (fine if the signal continues through a mating connector)."));
    }

    if (!rows.length) {
      wrap.appendChild(el("div", { class: "hint-box" }, "No wires yet — assign the same signal to two or more pins to create one."));
      return wrap;
    }

    /* wire table */
    const table = el("table", { class: "data sheet-table" },
      el("tr", {},
        el("th", {}, "#"), el("th", {}, "Signal"), el("th", {}, "Type"), el("th", {}, "Color"),
        el("th", {}, "Gauge"), el("th", {}, "From"), el("th", {}, "Pin"),
        el("th", {}, "To"), el("th", {}, "Pin"), el("th", {}, `Length (${unit})`)));
    rows
      .sort((a, b) => a.run.sig.name.localeCompare(b.run.sig.name) || a.run.idx - b.run.idx)
      .forEach((r, i) => {
        const { run, len, from, to } = r;
        table.appendChild(el("tr", {},
          el("td", {}, String(i + 1)),
          el("td", {}, run.sig.name),
          el("td", { class: "muted" }, run.sig.type || "—"),
          el("td", {}, UI.swatch(run.sig.color), " ", el("span", { class: "small" }, UI.colorName(run.sig.color))),
          el("td", {}, run.sig.gauge || "—"),
          el("td", { class: from.kind === "splice" ? "splice-cell" : "" }, from.name),
          el("td", {}, from.pin),
          el("td", { class: to.kind === "splice" ? "splice-cell" : "" }, to.name),
          el("td", {}, to.pin),
          el("td", {}, len.incomplete
            ? el("span", { class: "muted" }, len.length ? `≥ ${round(len.length)} ?` : "?")
            : String(round(len.length)))));
      });
    wrap.appendChild(table);

    /* splices */
    wrap.appendChild(el("h4", {}, `Splices (${points.length})`));
    if (!points.length) {
      wrap.appendChild(el("div", { class: "muted small" },
        "No splices — every signal here runs point to point."));
    }
    for (const point of points) {
      const rec = point.kind === "mid" ? point.splice
        : Model.splicesOf(h).find((s) => s.nodeId === point.nodeId);
      const pos = rec ? Routing.splicePosition(h, rec) : null;
      const allAuto = point.signals.every((s) => s.auto);
      const atKey = point.kind === "mid" ? Routing.spKey(point.splice.id) : point.nodeId;
      const legs = rows.filter((r) => r.to.kind === "splice"
        && (r.to.splice ? Routing.spKey(r.to.splice.id) : r.to.nodeId) === atKey);

      const box = el("div", { class: "splice-box" });
      box.appendChild(el("div", { class: "side-row" },
        el("strong", {}, Routing.pointName(h, point)),
        allAuto ? el("span", { class: "sig-type-tag" }, "automatic") : null,
        el("span", { class: "muted small" }, `${legs.length} wires`)));
      box.appendChild(el("div", { class: "side-row" },
        point.signals.map(({ sig }) => el("span", { class: "small", style: { marginRight: "10px" } },
          UI.swatch(sig.color), " ", sig.name))));
      if (pos) {
        box.appendChild(el("div", { class: "muted small" },
          `Located ${round(pos.fromA)} ${unit} from ${Routing.nodeName(h, pos.seg.a)}, `,
          `${round(pos.fromB)} ${unit} from ${Routing.nodeName(h, pos.seg.b)}.`));
      } else if (point.kind === "node") {
        box.appendChild(el("div", { class: "muted small" }, `At ${Routing.nodeName(h, point.nodeId)}.`));
      }
      if (legs.length) {
        const t = el("table", { class: "data sheet-table" },
          el("tr", {}, el("th", {}, "Signal"), el("th", {}, "Wire to"), el("th", {}, "Pin"), el("th", {}, `Length (${unit})`)));
        for (const { run, len, from } of legs) {
          t.appendChild(el("tr", {},
            el("td", {}, run.sig.name),
            el("td", {}, from.name),
            el("td", {}, from.pin),
            el("td", {}, len.incomplete ? el("span", { class: "muted" }, "?") : String(round(len.length)))));
        }
        box.appendChild(t);
      }
      wrap.appendChild(box);
    }

    /* totals */
    const complete = rows.filter((r) => !r.len.incomplete);
    const total = complete.reduce((a, r) => a + r.len.length, 0);
    const byGauge = {};
    for (const r of complete) {
      const g = r.run.sig.gauge || "unspecified gauge";
      byGauge[g] = (byGauge[g] || 0) + r.len.length;
    }
    wrap.appendChild(el("h4", {}, "Totals"));
    wrap.appendChild(el("div", { class: "muted small" },
      `${rows.length} wires · ${round(total)} ${unit} of wire`
      + (complete.length < rows.length ? ` (from the ${complete.length} with known lengths)` : "")));
    const gt = el("table", { class: "data sheet-table", style: { maxWidth: "360px" } },
      el("tr", {}, el("th", {}, "Gauge"), el("th", {}, `Length (${unit})`)));
    for (const [g, v] of Object.entries(byGauge).sort()) {
      gt.appendChild(el("tr", {}, el("td", {}, g), el("td", {}, String(round(v)))));
    }
    if (Object.keys(byGauge).length) wrap.appendChild(gt);
    return wrap;
  }

  function exportCSV(harnesses) {
    const unit = Model.get().unit;
    const esc = (v) => {
      const s = String(v == null ? "" : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [["Harness", "Signal", "Type", "Color", "Gauge", "From", "From pin", "To", "To pin", `Length (${unit})`, "Notes"].join(",")];
    for (const h of harnesses) {
      const { wires } = Routing.computeRuns(h);
      wires.sort((a, b) => a.sig.name.localeCompare(b.sig.name) || a.idx - b.idx);
      for (const w of wires) {
        const len = Routing.runLength(h, w);
        let from = Routing.endInfo(h, w.fromKey, w.sig);
        let to = Routing.endInfo(h, w.toKey, w.sig);
        if (from.kind === "splice" && to.kind === "pin") { const t = from; from = to; to = t; }
        const notes = [];
        if (to.kind === "splice") notes.push(to.auto ? "to automatic splice" : "to splice");
        if (len.incomplete) notes.push("length incomplete");
        lines.push([
          h.name, w.sig.name, w.sig.type || "", UI.colorName(w.sig.color), w.sig.gauge || "",
          from.name, from.pin, to.name, to.pin,
          len.incomplete ? "" : round(len.length), notes.join("; "),
        ].map(esc).join(","));
      }
    }
    const name = (Model.get().name || "harness").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-");
    UI.download(name + "-wire-list.csv", lines.join("\r\n"), "text/csv");
  }

  return { render };
})();
