"use strict";
/* Connector Library tab: define connector types with a photo, pin count,
 * and a visual pin arrangement (rows x cols + numbering order). */
const LibraryView = (() => {
  const { el } = UI;
  let selId = null;

  function render() {
    const root = document.getElementById("tab-library");
    const scrolls = {};
    for (const cls of ["col-list", "col-main"]) {
      const c = root.querySelector("." + cls);
      if (c) scrolls[cls] = c.scrollTop;
    }
    root.innerHTML = "";
    const p = Model.get();
    const cols = el("div", { class: "cols" });

    /* --- left: item list --- */
    const list = el("div", { class: "col col-list" });
    list.appendChild(el("div", { class: "side-row" },
      el("h3", { style: { flex: 1, margin: 0 } }, "Library"),
      el("button", { class: "primary", onclick: addItem }, "＋ New")));
    list.appendChild(el("div", { class: "side-row" },
      el("button", {
        class: "small", onclick: saveLibrary,
        title: "Save this connector library to its own file, to reuse in other projects",
      }, "⭳ Save library"),
      el("button", {
        class: "small", onclick: loadLibrary,
        title: "Add connectors from a saved library (or another project file) to this project",
      }, "⭱ Load library")));
    if (!p.library.length) {
      list.appendChild(el("div", { class: "hint-box" },
        "Define your connector types here (Deutsch DT, Molex, GM Weather-Pack, etc.). ",
        "Each type gets a pin count, a visual pin arrangement, and optionally a photo. ",
        "You then place them on connector points in the Layout tab."));
    }
    for (const item of p.library) {
      const uses = countUses(item.id);
      list.appendChild(el("div", {
        class: "list-item" + (item.id === selId ? " selected" : ""),
        onclick: () => { selId = item.id; render(); },
      },
        item.imageData
          ? el("img", { class: "thumb", src: item.imageData })
          : el("div", { class: "thumb-ph" }, "▦"),
        el("span", { class: "name" }, item.name,
          el("span", { class: "sub" }, `${item.pinCount} pin${item.pinCount === 1 ? "" : "s"}` + (uses ? ` · used ×${uses}` : "")))));
    }
    cols.appendChild(list);

    /* --- right: editor --- */
    const main = el("div", { class: "col col-main" });
    const item = p.library.find((l) => l.id === selId);
    if (!item) {
      main.appendChild(el("div", { class: "hint-box", style: { maxWidth: "460px" } },
        "Select a connector on the left, or create a new one. ",
        "Simple ring/spade/blade terminals don't need library entries — those are built in and added directly on the Layout tab."));
    } else {
      main.appendChild(editor(item));
    }
    cols.appendChild(main);
    root.appendChild(cols);
    for (const [cls, top] of Object.entries(scrolls)) {
      const c = root.querySelector("." + cls);
      if (c) c.scrollTop = top;
    }
  }

  function countUses(libId) {
    let n = 0;
    for (const h of Model.get().harnesses) n += h.connectors.filter((c) => c.libId === libId).length;
    return n;
  }

  function addItem() {
    const p = Model.get();
    const item = {
      id: Model.uid("lib"), name: "New connector", type: "",
      pinCount: 4, rows: 2, cols: 2, numbering: "row",
      imageData: null, notes: "",
    };
    p.library.push(item);
    selId = item.id;
    Model.changed();
  }

  function saveLibrary() {
    const p = Model.get();
    if (!p.library.length) {
      UI.modal("Nothing to save", el("div", {}, "This project's connector library is empty."), [{ label: "OK", primary: true }]);
      return;
    }
    UI.saveJSON("connector-library.json",
      { type: "harnessPlanner.library", version: 1, source: p.name, library: p.library });
  }

  function loadLibrary() {
    UI.openJSON((data, fname) => {
      const items = Model.listFrom(data, "library");
      if (!items) {
        UI.modal("Load failed", el("div", {}, `"${fname}" doesn't contain a connector library.`), [{ label: "OK", primary: true }]);
        return;
      }
      const { added, skipped } = Model.mergeLibrary(items);
      if (added) Model.changed();
      UI.modal("Library loaded", el("div", {},
        `Added ${added} connector${added === 1 ? "" : "s"} from "${fname}".`,
        skipped ? el("div", { class: "muted small" }, `${skipped} skipped — a connector with that name is already in this project.`) : null),
        [{ label: "OK", primary: true }]);
    });
  }

  function editor(item) {
    const wrap = el("div");
    const field = (label, input) => [el("label", {}, label), input];
    const commit = () => Model.changed();

    const layout = item.layout || "grid";
    const select = (value, onchange, options) => {
      const sel = el("select", { onchange }, options.map(([v, label]) => el("option", { value: v }, label)));
      sel.value = value;
      return sel;
    };

    const grid = el("div", { class: "form-grid" },
      field("Name", el("input", { value: item.name, onchange: (e) => { item.name = e.target.value.trim() || item.name; commit(); } })),
      field("Series / part #", el("input", { value: item.type || "", placeholder: "e.g. Deutsch DT06-6S", onchange: (e) => { item.type = e.target.value; commit(); } })),
      field("Pin count", el("input", { type: "number", min: 1, max: 200, value: item.pinCount, onchange: (e) => {
        item.pinCount = Math.max(1, e.target.value | 0);
        // Grow a grid layout if it can't hold the pins.
        if (layout === "grid") while (item.rows * item.cols - (item.blocked || []).length < item.pinCount) item.cols++;
        commit();
      } })),
      field("Layout", select(layout, (e) => { item.layout = e.target.value; commit(); }, [
        ["grid", "Grid (rows × columns)"],
        ["circle", "Circular (rings of pins)"],
      ])),
    );

    if (layout === "grid") {
      grid.append(
        ...field("Rows", el("input", { type: "number", min: 1, max: 50, value: item.rows, onchange: (e) => {
          item.rows = Math.max(1, e.target.value | 0);
          item.blocked = []; // cell indices shift when the grid resizes
          item.pinCount = Math.min(item.pinCount, item.rows * item.cols);
          commit();
        } })),
        ...field("Columns", el("input", { type: "number", min: 1, max: 50, value: item.cols, onchange: (e) => {
          item.cols = Math.max(1, e.target.value | 0);
          item.blocked = [];
          item.pinCount = Math.min(item.pinCount, item.rows * item.cols);
          commit();
        } })),
        ...field("Numbering", select(item.numbering || "row", (e) => { item.numbering = e.target.value; commit(); }, [
          ["row", "Row by row (1,2,3… left→right each row)"],
          ["col", "Column by column (down each column)"],
          ["serp", "Serpentine (row by row, alternating direction)"],
        ])),
      );
    } else {
      grid.append(
        ...field("Rings", el("input", { type: "number", min: 1, max: 4, value: item.rings || 1, onchange: (e) => {
          item.rings = Math.min(4, Math.max(1, e.target.value | 0));
          commit();
        } })),
        ...field("Center pin", select(item.centerPin || "none", (e) => { item.centerPin = e.target.value; commit(); }, [
          ["none", "No center pin"],
          ["first", "Center pin is pin 1"],
          ["last", `Center pin is the last pin (${item.pinCount})`],
        ])),
        ...field("Numbering direction", select(item.direction || "cw", (e) => { item.direction = e.target.value; commit(); }, [
          ["cw", "Clockwise (viewed from mating face)"],
          ["ccw", "Counter-clockwise (viewed from mating face)"],
        ])),
        ...field("First pin position", select(item.startPos || "top", (e) => { item.startPos = e.target.value; commit(); }, [
          ["top", "12 o'clock"],
          ["right", "3 o'clock"],
          ["bottom", "6 o'clock"],
          ["left", "9 o'clock"],
        ])),
        ...field("Ring order", select(item.ringOrder || "in", (e) => { item.ringOrder = e.target.value; commit(); }, [
          ["in", "Number inner ring first"],
          ["out", "Number outer ring first"],
        ])),
      );
    }
    grid.append(...field("Notes", el("textarea", { rows: 2, onchange: (e) => { item.notes = e.target.value; commit(); } }, item.notes || "")));
    wrap.appendChild(grid);

    /* image */
    const fileInput = el("input", { type: "file", accept: "image/*", hidden: "hidden", onchange: (e) => {
      const f = e.target.files[0];
      if (f) UI.fileToDataURL(f, 480, (dataUrl) => { item.imageData = dataUrl; Model.changed(); });
    } });
    wrap.appendChild(el("h4", {}, "Photo"));
    wrap.appendChild(el("div", { class: "side-row" },
      item.imageData ? el("img", { src: item.imageData, style: { maxWidth: "220px", maxHeight: "160px", borderRadius: "8px", background: "#0c0e13" } }) : el("span", { class: "muted" }, "No image yet."),
      el("button", { onclick: () => fileInput.click() }, item.imageData ? "Replace image…" : "Add image…"),
      item.imageData ? el("button", { onclick: () => { item.imageData = null; Model.changed(); } }, "Remove") : null,
      fileInput));

    /* pin preview / editor */
    if (layout === "grid") {
      wrap.appendChild(el("h4", {}, "Pin arrangement (mating face)"));
      wrap.appendChild(gridPinEditor(item));
      wrap.appendChild(el("div", { class: "muted small", style: { marginTop: "4px" } },
        "Click a position to populate / unpopulate it — e.g. a relay socket is a 3×3 grid with the four corners unpopulated. ",
        "Numbering runs in the chosen order, skipping empty positions."));
    } else {
      wrap.appendChild(el("h4", {}, "Pin arrangement preview (mating face)"));
      wrap.appendChild(el("div", {}, UI.pinGrid(item, { showNumbers: true })));
      wrap.appendChild(el("div", { class: "muted small", style: { marginTop: "4px" } },
        `Showing pins 1–${item.pinCount} on ${item.rings || 1} ring(s). Adjust rings, direction, and start position until it matches the real connector (viewed from the mating face).`));
    }

    /* custom pin labels */
    wrap.appendChild(el("h4", {}, "Pin labels"));
    wrap.appendChild(el("div", { class: "muted small" },
      "Optional real-world pin names (85, 86, 30, 87a…). Leave blank to use the position number. ",
      "Labels are display-only — mate checks still compare position to position."));
    const labelRow = el("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "6px", maxWidth: "560px" } });
    item.pinLabels = item.pinLabels || {};
    for (let p = 1; p <= item.pinCount; p++) {
      labelRow.appendChild(el("div", { style: { display: "flex", alignItems: "center", gap: "3px" } },
        el("span", { class: "muted small", style: { minWidth: "20px", textAlign: "right" } }, `${p}:`),
        el("input", {
          value: item.pinLabels[p] || "", placeholder: String(p),
          style: { width: "58px" },
          onchange: (e) => {
            const v = e.target.value.trim();
            if (v) item.pinLabels[p] = v; else delete item.pinLabels[p];
            commit();
          },
        })));
    }
    wrap.appendChild(labelRow);

    /* delete */
    wrap.appendChild(el("h4", {}, "Danger zone"));
    const uses = countUses(item.id);
    wrap.appendChild(el("button", { class: "danger", onclick: () => {
      const doDelete = () => {
        const p = Model.get();
        for (const h of p.harnesses) for (const c of h.connectors) if (c.libId === item.id) { c.libId = null; c.termType = "Board pin"; }
        p.library = p.library.filter((l) => l.id !== item.id);
        selId = null;
        Model.changed();
      };
      if (uses) UI.confirmBox(`"${item.name}" is placed ${uses} time(s). Those placements will become generic terminals (pin assignments beyond pin 1 will be hidden). Delete anyway?`, doDelete);
      else doDelete();
    } }, "Delete this connector type"));

    return wrap;
  }

  /* Interactive grid: every cell is clickable — populated cells show their
   * pin label, unpopulated ones a dashed outline. Toggling a cell keeps
   * pinCount = number of populated cells. */
  function gridPinEditor(item) {
    const { svgEl } = UI;
    const cell = 40, pad = 15;
    const rows = Math.max(1, item.rows | 0), cols = Math.max(1, item.cols | 0);
    const w = cols * cell + pad * 2, h = rows * cell + pad * 2;
    const svg = svgEl("svg", { viewBox: `0 0 ${w} ${h}`, class: "pin-grid", width: Math.min(w, 560) });
    svg.appendChild(svgEl("rect", { x: 3, y: 3, width: w - 6, height: h - 6, rx: 9, class: "pin-body" }));
    const pinAt = {};
    for (const pp of Model.pinPositions(item)) pinAt[pp.row * cols + pp.col] = pp.pin;
    const blocked = new Set(item.blocked || []);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const cx = pad + c * cell + cell / 2, cy = pad + r * cell + cell / 2;
        const rad = cell * 0.36;
        const pin = pinAt[idx];
        const g = svgEl("g", { class: "pin clickable", style: "cursor:pointer" });
        if (pin != null) {
          const lbl = Model.pinLabel(item, pin);
          g.appendChild(svgEl("circle", { cx, cy, r: rad, fill: "#2a3040", class: "pin-circle" }));
          g.appendChild(svgEl("text", { x: cx, y: cy, class: "pin-num", "font-size": lbl.length > 2 ? "9.5" : null, fill: "#8b93a7" }, lbl));
          g.appendChild(svgEl("title", {}, `Pin ${lbl} — click to unpopulate`));
        } else {
          g.appendChild(svgEl("circle", { cx, cy, r: rad, fill: "none", stroke: "#3a4356", "stroke-width": 1.4, "stroke-dasharray": "4 4" }));
          g.appendChild(svgEl("title", {}, "Empty position — click to populate"));
        }
        g.addEventListener("click", () => {
          item.blocked = item.blocked || [];
          const at = item.blocked.indexOf(idx);
          if (at >= 0) item.blocked.splice(at, 1);
          else if (rows * cols - item.blocked.length > 1) item.blocked.push(idx);
          else return; // never unpopulate the last pin
          item.pinCount = rows * cols - item.blocked.length;
          Model.changed();
        });
        svg.appendChild(g);
      }
    }
    return svg;
  }

  return { render };
})();
