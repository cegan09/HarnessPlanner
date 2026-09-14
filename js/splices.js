"use strict";
/* Splice editing, shared by the Layout and Wire Diagram tabs so both work the
 * same way and there is only one copy of the rules.
 *
 * A splice point is identified by a stable key: "nd:<nodeId>" for one sitting
 * on a harness point, "sp:<spliceId>" for one part-way along a leg. */
const SpliceEdit = (() => {
  const { el } = UI;

  const pointId = (point) => (point.kind === "mid" ? "sp:" + point.splice.id : "nd:" + point.nodeId);

  const findPoint = (h, id) => Routing.computeRuns(h).points.find((p) => pointId(p) === id) || null;

  // Signals that physically reach a spot, so we only ever offer splices that
  // could actually exist there.
  function signalsReaching(h, { nodeId, segId }) {
    const info = Routing.computeRuns(h);
    return Model.get().signals.filter((sig) => {
      if (nodeId) return (info.reach[sig.id] || new Set()).has(nodeId);
      return info.wires.some((w) => w.sig.id === sig.id && w.steps.some((s) => s.segId === segId));
    });
  }

  function recordFor(h, point) {
    if (point.kind === "mid") return point.splice;
    return Model.splicesOf(h).find((s) => s.nodeId === point.nodeId) || null;
  }

  /* state: "on" splice here · "off" explicitly don't (suppresses the automatic
   * splice) · "clear" no opinion, so automatic behaviour applies */
  function setSignal(h, locator, sig, state) {
    let rec = locator.rec;
    if (!rec) {
      if (state === "clear") return;      // nothing worth recording
      rec = { id: Model.uid("sp"), label: "", signalIds: [], exclude: [] };
      if (locator.nodeId) rec.nodeId = locator.nodeId;
      else { rec.segId = locator.segId; rec.t = locator.t; }
      Model.splicesOf(h).push(rec);
      locator.rec = rec;
    }
    rec.signalIds = (rec.signalIds || []).filter((id) => id !== sig.id);
    rec.exclude = (rec.exclude || []).filter((id) => id !== sig.id);
    if (state === "on") rec.signalIds.push(sig.id);
    else if (state === "off") rec.exclude.push(sig.id);
    // a record that neither splices nor suppresses anything is just clutter
    h.splices = Model.splicesOf(h).filter((s) => (s.signalIds || []).length || (s.exclude || []).length);
    Model.changed();
  }

  /* Pick which signals splice at a spot — a harness point (nodeId) or
   * part-way along a leg (segId + t). `onPlaced` gets the new point key. */
  function chooser(h, locator, title, onPlaced) {
    const candidates = signalsReaching(h, locator);
    if (!candidates.length) {
      UI.modal("Nothing to splice here", el("div", {},
        "No signal with two or more pins runs through this point. ",
        "Assign a signal to several connectors first (Pinouts & Signals tab)."),
        [{ label: "OK", primary: true }]);
      return;
    }
    const rec = locator.rec || null;
    const chosen = new Set((rec && rec.signalIds) || []);
    const list = el("div", { class: "choice-list" });
    for (const sig of candidates) {
      const cb = el("input", { type: "checkbox" });
      cb.checked = chosen.has(sig.id);
      list.appendChild(el("label", { class: "check-row" }, cb, UI.swatch(sig.color), " ", sig.name,
        el("span", { class: "muted small" }, ` · ${Model.signalUses(sig.id).filter((u) => u.harness.id === h.id).length} pins`)));
      cb.addEventListener("change", () => { if (cb.checked) chosen.add(sig.id); else chosen.delete(sig.id); });
    }
    UI.modal(title, el("div", {},
      el("div", { class: "hint-box" },
        "Signals already splice automatically wherever their destinations branch. ",
        "Use this to splice somewhere extra — several signals can share one point."),
      list), [
      { label: "Cancel" },
      { label: "Place splice", primary: true, onClick: () => {
        if (!chosen.size) return;
        const loc = { ...locator, rec };
        // only ticked signals are affected — the rest keep their automatic behaviour
        for (const sig of candidates) setSignal(h, loc, sig, chosen.has(sig.id) ? "on" : "clear");
        if (onPlaced && loc.rec) onPlaced(locator.nodeId ? "nd:" + locator.nodeId : "sp:" + loc.rec.id);
        Model.changed();
      } },
    ]);
  }

  /* The "what splices here" editor, appended into a sidebar. `opts.position`
   * adds the along-the-leg controls (Layout only, where legs are to scale). */
  function panel(host, h, point, opts = {}) {
    const rec = recordFor(h, point);
    const locator = point.kind === "mid"
      ? { segId: point.segId, t: point.t, rec }
      : { nodeId: point.nodeId, rec };
    const unit = Model.get().unit;

    host.appendChild(el("h3", {}, "Splice ", el("span", { class: "splice-tag-pill" }, point.tag)));
    host.appendChild(el("div", { class: "muted small" },
      point.kind === "mid" ? "Part-way along a leg" : `At ${Routing.nodeName(h, point.nodeId, true)}`));

    if (rec) {
      host.appendChild(el("div", { class: "side-row" },
        el("label", {}, "Name"),
        el("input", {
          value: rec.label || "", placeholder: Routing.spliceName(rec), style: { flex: 1 },
          onchange: (e) => { rec.label = e.target.value.trim(); Model.changed(); },
        })));
    }

    if (point.kind === "mid" && opts.position !== false) {
      const seg = h.segments.find((s) => s.id === point.segId);
      const pos = Routing.splicePosition(h, rec);
      if (pos && seg) {
        host.appendChild(el("div", { class: "side-row" },
          el("label", {}, `From ${Routing.nodeName(h, seg.a)}`),
          el("input", {
            type: "number", min: 0, max: pos.total, step: "any",
            value: Math.round(pos.fromA * 10) / 10,
            onchange: (e) => {
              const v = Math.max(0, Math.min(pos.total, Number(e.target.value) || 0));
              rec.t = pos.total ? v / pos.total : 0;
              Model.changed();
            },
          }),
          el("span", { class: "muted" }, unit)));
        host.appendChild(el("div", { class: "muted small" },
          `${Math.round(pos.fromB * 10) / 10} ${unit} from ${Routing.nodeName(h, seg.b)} · leg is ${pos.total} ${unit}`));
      } else {
        host.appendChild(el("div", { class: "muted small" },
          "Set a length on this leg to position the splice by distance."));
      }
    }

    host.appendChild(el("h4", {}, "Signals spliced here"));
    const reaching = signalsReaching(h, point.kind === "mid" ? { segId: point.segId } : { nodeId: point.nodeId });
    const shown = [...new Set([...reaching, ...point.signals.map((s) => s.sig)])];
    for (const sig of shown) {
      const entry = point.signals.find((s) => s.sig.id === sig.id);
      const cb = el("input", { type: "checkbox" });
      cb.checked = !!entry;
      cb.addEventListener("change", () => {
        // unticking an automatic splice means "route straight through here"
        setSignal(h, locator, sig, cb.checked ? "on" : "off");
      });
      host.appendChild(el("label", { class: "check-row" }, cb, UI.swatch(sig.color),
        el("span", { class: "pin-sig" }, sig.name),
        entry && entry.auto ? el("span", { class: "sig-type-tag" }, "auto") : null));
    }
    host.appendChild(el("div", { class: "hint-box" },
      "Ticked signals splice here — one wire arrives and separate wires leave. ",
      "Untick one to route it straight through as individual wires instead. ",
      el("b", {}, "auto"), " marks a splice added automatically because the signal branches here."));

    if (rec) {
      host.appendChild(el("button", { class: "danger", onclick: () => {
        h.splices = Model.splicesOf(h).filter((x) => x.id !== rec.id);
        if (opts.onDeleted) opts.onDeleted();
        Model.changed();
      } }, point.kind === "mid" ? "Delete splice" : "Reset to automatic"));
    }
  }

  return { pointId, findPoint, signalsReaching, recordFor, setSignal, chooser, panel };
})();
