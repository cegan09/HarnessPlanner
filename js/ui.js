"use strict";
/* Small DOM / SVG helpers, modals, color utilities. */
const UI = (() => {
  const SVGNS = "http://www.w3.org/2000/svg";

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    applyAttrs(e, attrs);
    appendKids(e, children);
    return e;
  }

  function svgEl(tag, attrs, ...children) {
    const e = document.createElementNS(SVGNS, tag);
    applyAttrs(e, attrs);
    appendKids(e, children);
    return e;
  }

  function applyAttrs(e, attrs) {
    if (!attrs) return;
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
      else e.setAttribute(k, v);
    }
  }

  function appendKids(e, children) {
    for (const c of children.flat()) {
      if (c == null) continue;
      e.append(typeof c === "string" || typeof c === "number" ? document.createTextNode(c) : c);
    }
  }

  /* ---------- color helpers ---------- */

  // A quick-pick palette of common automotive wire colors.
  const PALETTE = [
    "#d02020", "#111111", "#f5f5f5", "#ffd400", "#0a8a30", "#1560d4",
    "#ff7f00", "#7b2fbf", "#8b5a2b", "#9aa0ab", "#ff69b4", "#00b8b8",
    "#7a4a1e", "#c8e83c",
  ];

  function contrast(hex) {
    if (!/^#[0-9a-f]{6}$/i.test(hex || "")) return "#fff";
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (r * 299 + g * 587 + b * 114) / 1000 > 140 ? "#111" : "#fff";
  }

  // Lighten a wire color just enough to stay visible against the dark canvas
  // (black/dark-brown wires would otherwise vanish when drawn as a line).
  function visibleOnDark(hex, min = 105) {
    if (!/^#[0-9a-f]{6}$/i.test(hex || "")) return hex;
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    let guard = 0;
    while ((r * 299 + g * 587 + b * 114) / 1000 < min && guard++ < 40) {
      r = Math.round(r + (255 - r) * 0.2);
      g = Math.round(g + (255 - g) * 0.2);
      b = Math.round(b + (255 - b) * 0.2);
    }
    return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
  }

  function swatchCSS(color) {
    if (!color) return "transparent";
    if (color.style === "striped")
      return `repeating-linear-gradient(45deg, ${color.base} 0 7px, ${color.stripe} 7px 11px)`;
    return color.base;
  }

  function swatch(color, big) {
    return el("span", {
      class: "swatch" + (big ? " big" : ""),
      style: { background: swatchCSS(color) },
      title: color ? colorName(color) : "",
    });
  }

  function colorName(color) {
    if (!color) return "";
    return color.style === "striped" ? `${color.base} / ${color.stripe} stripe` : color.base;
  }

  // Plain-English colour names, for things you read out loud at the parts
  // counter. Custom colours snap to the nearest common wire colour.
  const COLOR_NAMES = [
    ["Red", "#d02020"], ["Black", "#111111"], ["White", "#f5f5f5"], ["Yellow", "#ffd400"],
    ["Green", "#0a8a30"], ["Blue", "#1560d4"], ["Orange", "#ff7f00"], ["Violet", "#7b2fbf"],
    ["Brown", "#8b5a2b"], ["Grey", "#9aa0ab"], ["Pink", "#ff69b4"], ["Cyan", "#00b8b8"],
    ["Dk Brown", "#7a4a1e"], ["Lt Green", "#c8e83c"],
  ];

  function nearestColorName(hex) {
    if (!/^#[0-9a-f]{6}$/i.test(hex || "")) return hex || "?";
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    let best = null, bestD = Infinity;
    for (const [name, ref] of COLOR_NAMES) {
      const m = parseInt(ref.slice(1), 16);
      const dr = r - ((m >> 16) & 255), dg = g - ((m >> 8) & 255), db = b - (m & 255);
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = name; }
    }
    return best;
  }

  function colorLabel(color) {
    if (!color) return "";
    const base = nearestColorName(color.base);
    return color.style === "striped" ? `${base} / ${nearestColorName(color.stripe)} stripe` : base;
  }

  /* ---------- pin grid renderer (shared by library + pinout) ---------- */
  // opts: { cell, signalFor(pin)->signal|null, onPinClick(pin), titleFor(pin), showNumbers }
  let clipCounter = 0;
  function pinGrid(spec, opts = {}) {
    const cell = opts.cell || 40;
    const lay = Model.pinPoints(spec, cell);
    const { w, h } = lay;
    const svg = svgEl("svg", { viewBox: `0 0 ${w} ${h}`, class: "pin-grid", width: Math.min(w, 560) });
    if (lay.shape === "circle") {
      svg.appendChild(svgEl("circle", { cx: w / 2, cy: h / 2, r: lay.bodyR + 3, class: "pin-body" }));
    } else {
      svg.appendChild(svgEl("rect", { x: 3, y: 3, width: w - 6, height: h - 6, rx: 9, class: "pin-body" }));
    }
    for (const pp of lay.points) {
      const cx = pp.x;
      const cy = pp.y;
      const r = cell * 0.36;
      const sig = opts.signalFor ? opts.signalFor(pp.pin) : null;
      const base = sig ? sig.color.base : "#2a3040";
      const g = svgEl("g", { class: "pin" + (opts.onPinClick ? " clickable" : "") });
      g.appendChild(svgEl("circle", { cx, cy, r, fill: base, class: "pin-circle" }));
      if (sig && sig.color.style === "striped") {
        const id = "pgclip" + (clipCounter++);
        const clip = svgEl("clipPath", { id });
        clip.appendChild(svgEl("circle", { cx, cy, r: r - 0.5 }));
        svg.appendChild(clip);
        g.appendChild(svgEl("line", {
          x1: cx - r, y1: cy + r, x2: cx + r, y2: cy - r,
          stroke: sig.color.stripe, "stroke-width": r * 0.62, "clip-path": `url(#${id})`,
        }));
      }
      if (opts.showNumbers !== false) {
        const lbl = Model.pinLabel(spec, pp.pin);
        g.appendChild(svgEl("text", {
          x: cx, y: cy, class: "pin-num",
          "font-size": lbl.length > 2 ? "9.5" : null,
          fill: sig ? contrast(base) : "#8b93a7",
        }, lbl));
      }
      if (opts.titleFor) g.appendChild(svgEl("title", {}, opts.titleFor(pp.pin)));
      if (opts.onPinClick) {
        g.style.cursor = "pointer";
        g.addEventListener("click", () => opts.onPinClick(pp.pin));
      }
      svg.appendChild(g);
    }
    return svg;
  }

  /* ---------- modals ---------- */

  function closeModal() {
    document.getElementById("modalHost").innerHTML = "";
  }

  function modal(title, body, buttons) {
    const host = document.getElementById("modalHost");
    host.innerHTML = "";
    const box = el("div", { class: "modal" }, el("h3", {}, title), body);
    if (buttons && buttons.length) {
      box.appendChild(el("div", { class: "modal-buttons" },
        buttons.map((b) => el("button", {
          class: b.primary ? "primary" : (b.danger ? "danger" : ""),
          onclick: () => { if (!b.onClick || b.onClick() !== false) closeModal(); },
        }, b.label))));
    }
    const overlay = el("div", { class: "overlay", onmousedown: (e) => { if (e.target === overlay) closeModal(); } }, box);
    host.appendChild(overlay);
    return box;
  }

  function promptText(title, value, cb) {
    const input = el("input", { value: value || "", style: { width: "100%" } });
    modal(title, input, [
      { label: "Cancel" },
      { label: "OK", primary: true, onClick: () => { const v = input.value.trim(); if (v) cb(v); } },
    ]);
    input.focus();
    input.select();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { const v = input.value.trim(); if (v) { closeModal(); cb(v); } }
    });
  }

  function confirmBox(msg, cb) {
    modal("Confirm", el("div", {}, msg), [
      { label: "Cancel" },
      { label: "OK", primary: true, onClick: () => cb() },
    ]);
  }

  // options: [{label, sub, value}]
  function choose(title, options, cb, emptyMsg) {
    const list = el("div", { class: "choice-list" });
    if (!options.length) list.appendChild(el("div", { class: "muted" }, emptyMsg || "Nothing available."));
    for (const o of options) {
      list.appendChild(el("button", { onclick: () => { closeModal(); cb(o.value); } },
        o.label, o.sub ? el("span", { class: "muted small" }, " — " + o.sub) : null));
    }
    modal(title, list, [{ label: "Cancel" }]);
  }

  /* ---------- files ---------- */

  function download(filename, text, mime) {
    const a = el("a", {
      href: URL.createObjectURL(new Blob([text], { type: mime || "application/json" })),
      download: filename,
    });
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const fileError = (title, msg) => modal(title, el("div", {}, msg), [{ label: "OK", primary: true }]);

  /* Standalone side-files (connector libraries, signal lists). Uses the file
   * picker where the browser has one, download/upload where it doesn't. */
  async function saveJSON(suggestedName, data) {
    const text = JSON.stringify(data, null, 2);
    if (!Storage.supported()) { download(suggestedName, text); return; }
    try {
      await Storage.write(await Storage.pickSave(suggestedName), text);
    } catch (e) {
      if (e && e.name !== "AbortError") fileError("Save failed", String((e && e.message) || e));
    }
  }

  // cb(parsedJSON, fileName)
  function openJSON(cb) {
    const parse = (text, name) => {
      try {
        cb(JSON.parse(text), name);
      } catch (e) {
        fileError("Load failed", `"${name}" isn't valid JSON: ` + e.message);
      }
    };
    if (Storage.supported()) {
      Storage.pickOpen()
        .then(async (h) => parse(await Storage.read(h), h.name))
        .catch((e) => { if (e && e.name !== "AbortError") fileError("Load failed", String((e && e.message) || e)); });
      return;
    }
    const input = el("input", { type: "file", accept: ".json,application/json", style: { display: "none" } });
    input.addEventListener("change", () => {
      const f = input.files[0];
      if (f) {
        const reader = new FileReader();
        reader.onload = () => parse(reader.result, f.name);
        reader.readAsText(f);
      }
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  }

  // Downscales large images so the project stays small enough for autosave.
  function fileToDataURL(file, maxDim, cb) {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let w = img.width, h = img.height;
      const s = Math.min(1, maxDim / Math.max(w, h));
      w = Math.max(1, Math.round(w * s));
      h = Math.max(1, Math.round(h * s));
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      cv.getContext("2d").drawImage(img, 0, 0, w, h);
      const mime = /png|gif|webp/.test(file.type) ? "image/png" : "image/jpeg";
      cb(cv.toDataURL(mime, 0.85));
      URL.revokeObjectURL(url);
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  return { el, svgEl, PALETTE, contrast, visibleOnDark, swatch, swatchCSS, colorName, colorLabel, nearestColorName, pinGrid, modal, closeModal, promptText, confirmBox, choose, download, saveJSON, openJSON, fileToDataURL };
})();
