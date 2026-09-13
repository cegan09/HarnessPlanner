"use strict";
/* Build Sheet tab: the cut list. Every physical wire with its signal, color,
 * gauge, both endpoints and its length — including wires that run from a
 * splice, so you know how long each leg into a splice needs to be. */
const BuildSheetView = (() => {
  const { el } = UI;
  let scope = "current";   // current | all

  const round = (v) => Math.round(v * 10) / 10;
  let spare = 10;          // % extra added to the order quantities

  // default column widths, as percentages so they survive printing
  //             #   Signal Type Color Gauge From  Pin  To   Pin  Length
  const COLS_WIRES = [4, 16, 8, 14, 7, 16, 5, 16, 5, 9];

  /* A splice endpoint shows its tag, so the drawing and this table can be
   * read against each other. */
  function endCell(end, tag) {
    if (end.kind !== "splice") return el("td", {}, end.name);
    return el("td", { class: "splice-cell" },
      tag ? el("span", { class: "splice-tag-pill" }, tag) : null, " ", end.name);
  }

  /* ---------- resizable columns ---------- */

  const savedCols = () => Model.getPrefs().buildCols || {};

  function applyResizable(table, key, defaults) {
    const saved = savedCols()[key];
    const pcts = (Array.isArray(saved) && saved.length === defaults.length ? saved : defaults).slice();
    const cg = document.createElement("colgroup");
    for (const p of pcts) {
      const c = document.createElement("col");
      c.style.width = p + "%";
      cg.appendChild(c);
    }
    // grab the header row before the colgroup shifts the child order
    const headRow = table.querySelector("tr");
    table.insertBefore(cg, table.firstChild);
    table.classList.add("resizable");

    const ths = headRow ? [...headRow.querySelectorAll("th")] : [];
    ths.forEach((th, i) => {
      if (i >= ths.length - 1) return;
      const grip = el("span", { class: "col-grip", title: "Drag to resize" });
      th.appendChild(grip);
      grip.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const tableW = table.getBoundingClientRect().width || 1;
        const a0 = pcts[i], b0 = pcts[i + 1];
        const move = (ev) => {
          const d = ((ev.clientX - startX) / tableW) * 100;
          // borrow width from the neighbour so the row always totals 100%
          const a = Math.max(3, Math.min(a0 + b0 - 3, a0 + d));
          pcts[i] = a;
          pcts[i + 1] = a0 + b0 - a;
          cg.children[i].style.width = pcts[i] + "%";
          cg.children[i + 1].style.width = pcts[i + 1] + "%";
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          document.body.classList.remove("col-resizing");
          Model.setPref("buildCols", { ...savedCols(), [key]: pcts.map((v) => Math.round(v * 10) / 10) });
        };
        document.body.classList.add("col-resizing");
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      });
    });
  }

  function resetColumns() {
    Model.setPref("buildCols", {});
  }

  /* ---------- wire-to-order grouping ---------- */

  // Two signals that share a gauge and an identical colour are the same spool
  // of wire, so their lengths add up into one line to buy.
  const spoolKey = (sig) => {
    const c = sig.color || {};
    const style = c.style || "solid";
    return [sig.gauge || "", style, (c.base || "").toLowerCase(),
      style === "striped" ? (c.stripe || "").toLowerCase() : ""].join("|");
  };

  function orderGroups(entries) {
    const groups = new Map();
    for (const { sig, length, incomplete } of entries) {
      const key = spoolKey(sig);
      let g = groups.get(key);
      if (!g) {
        g = { gauge: sig.gauge || "", color: sig.color, length: 0, wires: 0, unknown: 0, signals: new Set() };
        groups.set(key, g);
      }
      g.wires++;
      g.signals.add(sig.name);
      if (incomplete) g.unknown++;
      else g.length += length;
    }
    return [...groups.values()].sort((a, b) =>
      (a.gauge || "~~").localeCompare(b.gauge || "~~", undefined, { numeric: true })
      || UI.colorLabel(a.color).localeCompare(UI.colorLabel(b.color)));
  }

  // A friendlier buying unit alongside the project's own unit.
  function inOrderUnits(v, unit) {
    if (unit === "in") return { v: v / 12, u: "ft" };
    if (unit === "cm") return { v: v / 100, u: "m" };
    if (unit === "mm") return { v: v / 1000, u: "m" };
    return null;
  }

  function orderTable(entries, unit) {
    const groups = orderGroups(entries);
    const wrap = el("div", {});
    if (!groups.length) {
      wrap.appendChild(el("div", { class: "muted small" }, "Nothing to order yet."));
      return wrap;
    }
    const alt = inOrderUnits(1, unit);
    const table = el("table", { class: "data sheet-table", style: { maxWidth: "760px" } },
      el("tr", {},
        el("th", {}, "Gauge"), el("th", {}, "Colour"), el("th", {}, "Wires"),
        el("th", {}, `Length (${unit})`),
        alt ? el("th", {}, `(${alt.u})`) : null,
        el("th", { title: `Length plus ${spare}% spare` }, `Order +${spare}%`)));
    for (const g of groups) {
      const padded = g.length * (1 + spare / 100);
      const altLen = inOrderUnits(padded, unit);
      table.appendChild(el("tr", { title: [...g.signals].sort().join(", ") },
        el("td", {}, g.gauge || el("span", { class: "muted" }, "unspecified")),
        el("td", {}, UI.swatch(g.color), " ",
          el("span", {}, UI.colorLabel(g.color)),
          el("span", { class: "muted small" }, "  " + UI.colorName(g.color))),
        el("td", {}, String(g.wires) + (g.unknown ? ` (${g.unknown} unknown)` : "")),
        el("td", {}, String(round(g.length))),
        alt ? el("td", { class: "muted" }, String(round(g.length / (unit === "in" ? 12 : unit === "cm" ? 100 : 1000)))) : null,
        el("td", {}, el("strong", {}, String(round(padded))
          + (altLen ? ` ${unit}  ≈ ${Math.ceil(altLen.v * 10) / 10} ${altLen.u}` : ` ${unit}`)))));
    }
    wrap.appendChild(table);
    const anyUnknown = groups.some((g) => g.unknown);
    if (anyUnknown) {
      wrap.appendChild(el("div", { class: "muted small" },
        "Wires with an unknown length aren't counted — set the missing leg lengths on the Layout tab."));
    }
    return wrap;
  }

  function spareControl(onChange) {
    const input = el("input", {
      type: "number", min: 0, max: 100, step: 5, value: spare,
      style: { width: "64px" },
      onchange: (e) => { spare = Math.max(0, Math.min(100, Number(e.target.value) || 0)); onChange(); },
    });
    return el("div", { class: "compare-side" },
      el("span", { class: "side-title" }, "Spare %"), input);
  }

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
      spareControl(render),
      el("div", { class: "compare-side" }, el("span", { class: "side-title" }, " "),
        el("div", { class: "side-row" },
          el("button", { onclick: () => exportCSV(harnesses) }, "⭳ Wire list CSV"),
          el("button", { onclick: () => exportOrderCSV(harnesses) }, "⭳ Order list CSV"),
          el("button", { onclick: resetColumns, title: "Restore the default column widths" }, "↔ Reset columns"),
          el("button", { onclick: () => window.print() }, "🖨 Print")))));

    const body = el("div", { class: "compare-body" });
    for (const h of harnesses) body.appendChild(harnessSection(h));

    // one combined shopping list when looking at the whole project
    if (harnesses.length > 1) {
      const unit = p.unit;
      const grand = el("div", { class: "sheet-section" });
      grand.appendChild(el("h3", {}, "Whole project — wire to order"));
      grand.appendChild(el("div", { class: "muted small" },
        `Every harness combined (${harnesses.map((x) => x.name).join(", ")}).`));
      grand.appendChild(orderTable(allEntries(harnesses), unit));
      body.appendChild(grand);
    }

    root.appendChild(body);
    body.scrollTop = top;
  }

  function harnessSection(h) {
    const wrap = el("div", { class: "sheet-section" });
    const unit = Model.get().unit;
    const { wires, points, singles, warnings } = Routing.computeRuns(h);
    const rows = wires.map((w) => {
      let from = Routing.endInfo(h, w.fromKey, w.sig);
      let to = Routing.endInfo(h, w.toKey, w.sig);
      let fromTag = w.fromTag, toTag = w.toTag;
      // wires read better running pin -> splice than splice -> pin
      if (from.kind === "splice" && to.kind === "pin") {
        [from, to] = [to, from];
        [fromTag, toTag] = [toTag, fromTag];
      }
      return { run: w, len: Routing.runLength(h, w), from, to, fromTag, toTag };
    });

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
        const { run, len, from, to, fromTag, toTag } = r;
        table.appendChild(el("tr", {},
          el("td", {}, String(i + 1)),
          el("td", {}, run.sig.name),
          el("td", { class: "muted" }, run.sig.type || "—"),
          el("td", {}, UI.swatch(run.sig.color), " ",
            el("span", { class: "small" }, UI.colorLabel(run.sig.color))),
          el("td", {}, run.sig.gauge || "—"),
          endCell(from, fromTag),
          el("td", {}, from.pin),
          endCell(to, toTag),
          el("td", {}, to.pin),
          el("td", {}, len.incomplete
            ? el("span", { class: "muted" }, len.length ? `≥ ${round(len.length)} ?` : "?")
            : String(round(len.length)))));
      });
    applyResizable(table, "wires", COLS_WIRES);
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
      const legs = rows.filter((r) => r.toTag === point.tag);

      const box = el("div", { class: "splice-box", id: "splice-" + point.tag });
      box.appendChild(el("div", { class: "side-row" },
        el("span", { class: "splice-tag-pill big" }, point.tag),
        el("strong", {}, Routing.pointName(h, point, true)),
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

    /* wire to order */
    const complete = rows.filter((r) => !r.len.incomplete);
    const total = complete.reduce((a, r) => a + r.len.length, 0);
    wrap.appendChild(el("h4", {}, "Wire to order"));
    wrap.appendChild(el("div", { class: "muted small" },
      `${rows.length} wires · ${round(total)} ${unit} total`
      + (complete.length < rows.length ? ` (from the ${complete.length} with known lengths)` : "")
      + " · grouped by gauge and colour, so signals sharing a spool add up together."));
    wrap.appendChild(orderTable(entriesOf(h, rows), unit));
    return wrap;
  }

  // Flatten a harness's wires into {sig, length, incomplete} for grouping.
  const entriesOf = (h, rows) => rows.map((r) => ({
    sig: r.run.sig, length: r.len.length, incomplete: r.len.incomplete,
  }));

  function allEntries(harnesses) {
    const out = [];
    for (const h of harnesses) {
      for (const w of Routing.computeRuns(h).wires) {
        const len = Routing.runLength(h, w);
        out.push({ sig: w.sig, length: len.length, incomplete: len.incomplete });
      }
    }
    return out;
  }

  function exportCSV(harnesses) {
    const unit = Model.get().unit;
    const esc = (v) => {
      const s = String(v == null ? "" : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [["Harness", "Signal", "Type", "Colour", "Colour codes", "Gauge", "From", "From pin", "To", "To pin", `Length (${unit})`, "Notes"].join(",")];
    for (const h of harnesses) {
      const { wires } = Routing.computeRuns(h);
      wires.sort((a, b) => a.sig.name.localeCompare(b.sig.name) || a.idx - b.idx);
      for (const w of wires) {
        const len = Routing.runLength(h, w);
        let from = Routing.endInfo(h, w.fromKey, w.sig);
        let to = Routing.endInfo(h, w.toKey, w.sig);
        let fromTag = w.fromTag, toTag = w.toTag;
        if (from.kind === "splice" && to.kind === "pin") {
          [from, to] = [to, from];
          [fromTag, toTag] = [toTag, fromTag];
        }
        const notes = [];
        if (to.kind === "splice") notes.push(to.auto ? "to automatic splice" : "to splice");
        if (len.incomplete) notes.push("length incomplete");
        const tagged = (end, tag) => (end.kind === "splice" && tag ? `${tag} ${end.name}` : end.name);
        lines.push([
          h.name, w.sig.name, w.sig.type || "", UI.colorLabel(w.sig.color), UI.colorName(w.sig.color),
          w.sig.gauge || "",
          tagged(from, fromTag), from.pin, tagged(to, toTag), to.pin,
          len.incomplete ? "" : round(len.length), notes.join("; "),
        ].map(esc).join(","));
      }
    }
    UI.download(projectFileName() + "-wire-list.csv", lines.join("\r\n"), "text/csv");
  }

  function exportOrderCSV(harnesses) {
    const unit = Model.get().unit;
    const alt = inOrderUnits(1, unit);
    const esc = (v) => {
      const s = String(v == null ? "" : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ["Gauge", "Colour", "Colour codes", "Wires", `Length (${unit})`, `Order +${spare}% (${unit})`];
    if (alt) head.push(`Order +${spare}% (${alt.u})`);
    head.push("Signals");
    const lines = [head.join(",")];
    const emit = (label, entries) => {
      for (const g of orderGroups(entries)) {
        const padded = g.length * (1 + spare / 100);
        const row = [
          g.gauge || "unspecified", UI.colorLabel(g.color), UI.colorName(g.color),
          g.wires, round(g.length), round(padded),
        ];
        if (alt) row.push(Math.ceil(inOrderUnits(padded, unit).v * 10) / 10);
        row.push([...g.signals].sort().join("; "));
        lines.push(row.map(esc).join(","));
      }
    };
    if (harnesses.length > 1) {
      lines.push(esc("— whole project —"));
      emit("all", allEntries(harnesses));
      for (const h of harnesses) {
        lines.push("");
        lines.push(esc("— " + h.name + " —"));
        emit(h.name, allEntries([h]));
      }
    } else {
      emit("", allEntries(harnesses));
    }
    UI.download(projectFileName() + "-order-list.csv", lines.join("\r\n"), "text/csv");
  }

  const projectFileName = () =>
    (Model.get().name || "harness").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-");

  return { render };
})();
