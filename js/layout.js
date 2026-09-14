"use strict";
/* Layout tab: sketch the harness shape.
 *  - "Add point": click empty space to drop a connector point; click a
 *    harness line to split it and pull a new leg off it.
 *  - "Connect": click two points to join them, or click empty space to chain
 *    new points as you draw.
 *  - "Jog": click a line to insert a bend point (drag bends in Select mode)
 *    so legs can dogleg instead of running straight.
 *  - Splices are placed and edited on the Wire Diagram tab; they are shown
 *    here so you can see where the joints land while laying the harness out.
 *  - Bundle view: thick trunk lines with short colored wire stubs at each
 *    connector. Wire view: every wire routed individually along the trunk,
 *    with ECAD-style hop arcs where wires cross.
 */
const LayoutView = (() => {
  const { svgEl, el } = UI;

  let svg, sidebar;
  let scale = 1, panX = 0, panY = 0, panInitialized = false;
  let mode = "select";          // select | point | connect | jog | delete
  let viewMode = "bundle";      // bundle | wires
  let sel = null;               // {type:'node'|'seg'|'conn'|'splice', id}
  let connectFrom = null;       // node id while in connect mode
  let drag = null;              // {kind:'node'|'conn'|'bend'|'splice'|'pan', ...}
  let highlightSig = null;      // signal id highlighted across the layout
  let pendingMove = null;       // connector id waiting to be re-homed

  const GRID = 10;
  const LANE = 12;              // wire-view lane spacing (max)
  const LANE_MIN = 4;           // …squeezed to this on busy legs
  const BUNDLE_W = 66;          // widest a wire bundle is allowed to fan
  const HUB_STEP = 13;          // spacing between per-signal splice dots
  const HOP_R = 5;              // hop arc radius
  const TRANS = 14;             // junction transition (fan) length
  const NODE_CLEAR = 26;        // crossings this close to a node aren't hopped
  const DIM = 0.08;             // opacity of non-highlighted wires
  const snap = (v) => Math.round(v / GRID) * GRID;

  const HINTS = {
    select: "Drag points, connectors, bends, and splices · drag empty space to pan · scroll to zoom · double-click a connector for its pinout",
    point: "Click empty space to add a connector point · click a harness line to branch a leg off it",
    connect: "Click a point, then another point to join them — or click empty space to chain new points. Esc to stop.",
    jog: "Click a harness line to add a bend (jog) point there — then drag it in Select mode",
    delete: "Click a point, line, bend, connector, or splice to delete it",
  };

  /* ---------- init ---------- */

  function init() {
    svg = document.getElementById("canvas");
    sidebar = document.getElementById("layoutSidebar");

    for (const b of document.querySelectorAll("#modeButtons button")) {
      b.addEventListener("click", () => setMode(b.dataset.mode));
    }
    for (const b of document.querySelectorAll("#viewButtons button")) {
      b.addEventListener("click", () => setView(b.dataset.view));
    }
    document.getElementById("btnFit").addEventListener("click", fit);
    document.getElementById("btnZoomDir").addEventListener("click", () => {
      Model.setPref("invertZoom", !Model.getPrefs().invertZoom);
      syncZoomButton();
    });
    syncZoomButton();

    svg.addEventListener("pointerdown", onBackgroundDown);
    svg.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    updateHint();
  }

  function setMode(m) {
    mode = m;
    connectFrom = null;
    document.querySelectorAll("#modeButtons button").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
    updateHint();
    render();
  }

  function setView(v) {
    viewMode = v;
    document.querySelectorAll("#viewButtons button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
    render();
  }

  function updateHint() {
    const hint = document.getElementById("toolbarHint");
    if (pendingMove) {
      const f = Model.findConnector(pendingMove);
      hint.textContent = `Moving “${f ? f.conn.label : "connector"}” — click a point to move it there, a leg to break out at that spot, `
        + "or empty space for a new point · Esc to cancel";
      return;
    }
    hint.textContent = HINTS[mode] || "";
  }

  function syncZoomButton() {
    const b = document.getElementById("btnZoomDir");
    if (!b) return;
    const inv = !!Model.getPrefs().invertZoom;
    b.classList.toggle("active", inv);
    b.title = inv
      ? "Scroll wheel: up = zoom out. Click to switch back to standard."
      : "Scroll wheel: up = zoom in. Click to invert.";
  }

  /* ---------- coordinate + geometry helpers ---------- */

  function worldPos(e) {
    const r = svg.getBoundingClientRect();
    return { x: (e.clientX - r.left - panX) / scale, y: (e.clientY - r.top - panY) / scale };
  }

  const H = () => Main.currentHarness();
  const nodeById = (h, id) => h.nodes.find((n) => n.id === id);
  const segById = (h, id) => h.segments.find((s) => s.id === id);
  const segsAt = (h, nodeId) => h.segments.filter((s) => s.a === nodeId || s.b === nodeId);
  const connsAt = (h, nodeId) => h.connectors.filter((c) => c.nodeId === nodeId);

  // Full polyline of a segment: node A, bends, node B.
  function segPts(h, seg) {
    const A = nodeById(h, seg.a), B = nodeById(h, seg.b);
    if (!A || !B) return null;
    return [{ x: A.x, y: A.y }, ...(seg.bends || []), { x: B.x, y: B.y }];
  }

  function polyLen(pts) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return L;
  }

  // Point at fraction t (by arc length) along a polyline; includes local direction.
  function pointAlong(pts, t) {
    const total = polyLen(pts) || 1;
    let want = Math.min(1, Math.max(0, t)) * total;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
      const L = Math.hypot(dx, dy);
      if (want <= L || i === pts.length - 1) {
        const k = L ? want / L : 0;
        return { x: pts[i - 1].x + dx * k, y: pts[i - 1].y + dy * k, ux: L ? dx / L : 1, uy: L ? dy / L : 0 };
      }
      want -= L;
    }
    return { x: pts[0].x, y: pts[0].y, ux: 1, uy: 0 };
  }

  // Nearest point on a polyline: {x, y, t, dist, i} (i = sub-segment index).
  function nearestOnPoly(pts, p) {
    let best = null, acc = 0;
    const total = polyLen(pts) || 1;
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1].x, ay = pts[i - 1].y;
      const dx = pts[i].x - ax, dy = pts[i].y - ay;
      const L2 = dx * dx + dy * dy || 1;
      let k = ((p.x - ax) * dx + (p.y - ay) * dy) / L2;
      k = Math.max(0, Math.min(1, k));
      const x = ax + dx * k, y = ay + dy * k;
      const dist = Math.hypot(p.x - x, p.y - y);
      const L = Math.sqrt(L2);
      if (!best || dist < best.dist) best = { x, y, dist, i: i - 1, t: (acc + L * k) / total };
      acc += L;
    }
    return best;
  }

  // Sub-polyline between fractions t0..t1 (canonical a->b order).
  function subPoly(pts, t0, t1) {
    const p0 = pointAlong(pts, t0), p1 = pointAlong(pts, t1);
    const total = polyLen(pts) || 1;
    const out = [{ x: p0.x, y: p0.y }];
    let acc = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      const t = acc / total;
      if (t > t0 && t < t1) out.push({ x: pts[i].x, y: pts[i].y });
    }
    out.push({ x: p1.x, y: p1.y });
    return out;
  }

  // Offset a polyline sideways (positive = left of canonical direction).
  function offsetPoly(pts, d) {
    if (!d) return pts.map((p) => ({ x: p.x, y: p.y }));
    const norms = [];
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
      const L = Math.hypot(dx, dy) || 1;
      norms.push({ x: -dy / L, y: dx / L });
    }
    return pts.map((p, i) => {
      let nx, ny;
      if (i === 0) ({ x: nx, y: ny } = norms[0]);
      else if (i === pts.length - 1) ({ x: nx, y: ny } = norms[norms.length - 1]);
      else {
        nx = norms[i - 1].x + norms[i].x;
        ny = norms[i - 1].y + norms[i].y;
        const L = Math.hypot(nx, ny) || 1;
        nx /= L; ny /= L;
      }
      return { x: p.x + nx * d, y: p.y + ny * d };
    });
  }

  /* ---------- pointer handling ---------- */

  function onBackgroundDown(e) {
    e.preventDefault();
    if (pendingMove && e.button === 0 && e.target.dataset && e.target.dataset.bg) {
      // drop the connector on a brand-new point
      const w = worldPos(e);
      const h = H();
      const n = { id: Model.uid("n"), x: snap(w.x), y: snap(w.y) };
      h.nodes.push(n);
      completeMove(n.id);
      return;
    }
    if (e.button === 1 || (e.button === 0 && e.target.dataset && e.target.dataset.bg)) {
      const w = worldPos(e);
      if (e.button === 1 || mode === "select" || mode === "delete") {
        if (mode === "select" && e.button === 0) { sel = null; renderSidebar(); }
        drag = { kind: "pan", startX: e.clientX, startY: e.clientY, panX, panY };
        render();
        return;
      }
      if (mode === "point") {
        addNode(snap(w.x), snap(w.y));
      } else if (mode === "connect") {
        const h = H();
        const n = { id: Model.uid("n"), x: snap(w.x), y: snap(w.y) };
        h.nodes.push(n);
        if (connectFrom && nodeById(h, connectFrom)) {
          h.segments.push({ id: Model.uid("s"), a: connectFrom, b: n.id, length: null });
        }
        connectFrom = n.id;
        sel = { type: "node", id: n.id };
        Model.changed();
      } else if (mode === "jog") {
        // clicked near (but not on) a line — find the closest segment
        const h = H();
        let best = null;
        for (const seg of h.segments) {
          const pts = segPts(h, seg);
          if (!pts) continue;
          const near = nearestOnPoly(pts, w);
          if (!best || near.dist < best.near.dist) best = { seg, near };
        }
        if (best && best.near.dist < 40) {
          jogAt(best.seg, best.near);
        }
      }
    }
  }

  function onNodeDown(e, node) {
    e.stopPropagation();
    e.preventDefault();
    const h = H();
    if (pendingMove) { completeMove(node.id); return; }
    if (mode === "delete") { deleteNode(node.id); return; }
    if (mode === "connect") {
      if (!connectFrom) {
        connectFrom = node.id;
      } else if (connectFrom !== node.id) {
        const exists = h.segments.some((s) => (s.a === connectFrom && s.b === node.id) || (s.b === connectFrom && s.a === node.id));
        if (!exists) {
          h.segments.push({ id: Model.uid("s"), a: connectFrom, b: node.id, length: null });
          Model.changed();
        }
        connectFrom = node.id;
      }
      render();
      return;
    }
    if (mode === "select" || mode === "point") {
      sel = { type: "node", id: node.id };
      const w = worldPos(e);
      drag = { kind: "node", id: node.id, grabDX: w.x - node.x, grabDY: w.y - node.y, snap: Model.snapshot(), moved: false };
      render();
      renderSidebar();
    }
  }

  function onSegDown(e, seg) {
    e.stopPropagation();
    e.preventDefault();
    const w = worldPos(e);
    const pts = segPts(H(), seg);
    if (pendingMove) {
      // break the leg at the click point and re-home the connector there
      const junction = splitSegmentAt(H(), seg, nearestOnPoly(pts, w));
      completeMove(junction.id);
      return;
    }
    if (mode === "delete") { deleteSeg(seg.id); return; }
    if (mode === "point") { teeOff(seg, nearestOnPoly(pts, w)); return; }
    if (mode === "jog") { jogAt(seg, nearestOnPoly(pts, w)); return; }
    sel = { type: "seg", id: seg.id };
    render();
    renderSidebar();
  }

  function onBendDown(e, seg, idx) {
    e.stopPropagation();
    e.preventDefault();
    if (mode === "delete") {
      seg.bends.splice(idx, 1);
      Model.changed();
      return;
    }
    if (mode === "select" || mode === "jog") {
      sel = { type: "seg", id: seg.id };
      drag = { kind: "bend", segId: seg.id, idx, snap: Model.snapshot(), moved: false };
      render();
      renderSidebar();
    }
  }

  function onConnDown(e, conn) {
    e.stopPropagation();
    e.preventDefault();
    if (pendingMove) {
      // clicking another connector means "put it at that connector's point"
      if (pendingMove === conn.id) cancelMove();
      else completeMove(conn.nodeId);
      return;
    }
    if (mode === "delete") { deleteConn(conn.id); return; }
    sel = { type: "conn", id: conn.id };
    if (mode === "select") {
      const h = H();
      const node = nodeById(h, conn.nodeId);
      const pos = connPos(h, conn);
      const w = worldPos(e);
      drag = { kind: "conn", id: conn.id, grabDX: w.x - pos.x, grabDY: w.y - pos.y, nodeX: node.x, nodeY: node.y, snap: Model.snapshot(), moved: false };
    }
    render();
    renderSidebar();
  }

  function onSpliceDown(e, point) {
    e.stopPropagation();
    e.preventDefault();
    const h = H();
    const id = pointId(point);
    if (mode === "delete") {
      if (point.kind === "mid") {
        h.splices = Model.splicesOf(h).filter((x) => x.id !== point.splice.id);
        if (sel && sel.type === "splice" && sel.id === id) sel = null;
        Model.changed();
      }
      return;
    }
    sel = { type: "splice", id };
    // only a part-way splice has a position of its own to drag
    if (mode === "select" && point.kind === "mid") {
      drag = { kind: "splice", id: point.splice.id, snap: Model.snapshot(), moved: false };
    }
    render();
    renderSidebar();
  }

  function onPointerMove(e) {
    if (!drag) return;
    // suppress page-wide text selection for the duration of the drag
    document.body.classList.add("dragging");
    if (drag.kind === "pan") {
      panX = drag.panX + (e.clientX - drag.startX);
      panY = drag.panY + (e.clientY - drag.startY);
      applyTransform();
      return;
    }
    const h = H();
    const w = worldPos(e);
    if (drag.kind === "node") {
      const n = nodeById(h, drag.id);
      if (!n) return;
      const nx = snap(w.x - drag.grabDX), ny = snap(w.y - drag.grabDY);
      if (nx !== n.x || ny !== n.y) { n.x = nx; n.y = ny; drag.moved = true; render(); }
    } else if (drag.kind === "conn") {
      const c = h.connectors.find((c) => c.id === drag.id);
      if (!c) return;
      c.dx = Math.round(w.x - drag.grabDX - drag.nodeX);
      c.dy = Math.round(w.y - drag.grabDY - drag.nodeY);
      drag.moved = true;
      render();
    } else if (drag.kind === "bend") {
      const seg = segById(h, drag.segId);
      if (!seg || !seg.bends || !seg.bends[drag.idx]) return;
      seg.bends[drag.idx].x = snap(w.x);
      seg.bends[drag.idx].y = snap(w.y);
      drag.moved = true;
      render();
    } else if (drag.kind === "splice") {
      const sp = Model.splicesOf(h).find((x) => x.id === drag.id);
      if (!sp) return;
      let best = null;
      for (const seg of h.segments) {
        const pts = segPts(h, seg);
        if (!pts) continue;
        const near = nearestOnPoly(pts, w);
        if (!best || near.dist < best.near.dist) best = { seg, near };
      }
      if (best) {
        sp.segId = best.seg.id;
        sp.t = best.near.t;
        drag.moved = true;
        render();
      }
    }
  }

  function onPointerUp() {
    document.body.classList.remove("dragging");
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.snap && d.moved) Model.commitFrom(d.snap);
  }

  function onWheel(e) {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const dir = Model.getPrefs().invertZoom ? -1 : 1;
    const f = e.deltaY * dir < 0 ? 1.12 : 1 / 1.12;
    const ns = Math.min(4, Math.max(0.15, scale * f));
    panX = mx - ((mx - panX) / scale) * ns;
    panY = my - ((my - panY) / scale) * ns;
    scale = ns;
    applyTransform();
  }

  /* ---------- edit operations ---------- */

  function addNode(x, y) {
    const h = H();
    const n = { id: Model.uid("n"), x, y };
    h.nodes.push(n);
    sel = { type: "node", id: n.id };
    Model.changed();
  }

  // Split a segment at a point along it and pull a new leg off the junction.
  function teeOff(seg, near) {
    const h = H();
    const pts = segPts(h, seg);
    const a = pts[near.i], b = pts[near.i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1;
    const junction = splitSegmentAt(h, seg, near);
    const end = {
      id: Model.uid("n"),
      x: snap(junction.x + (-dy / L) * 80),
      y: snap(junction.y + (dx / L) * 80),
    };
    h.nodes.push(end);
    h.segments.push({ id: Model.uid("s"), a: junction.id, b: end.id, length: null, bends: [] });
    sel = { type: "node", id: end.id };
    Model.changed();
  }

  /* Break a leg in two at a point along it, keeping bends on the correct side,
   * splitting the annotated length proportionally, and re-homing any splices
   * that lived on it. Returns the new junction node. Does not commit. */
  function splitSegmentAt(h, seg, near) {
    const pts = segPts(h, seg);
    const t = Math.min(0.98, Math.max(0.02, near.t));
    const junction = { id: Model.uid("n"), x: snap(near.x), y: snap(near.y) };
    h.nodes.push(junction);

    let lenA = null, lenB = null;
    if (seg.length != null && seg.length !== "") {
      const L = Number(seg.length) || 0;
      lenA = Math.round(L * t * 10) / 10;
      lenB = Math.round((L - lenA) * 10) / 10;
    }
    const segA = { id: Model.uid("s"), a: seg.a, b: junction.id, length: lenA, bends: pts.slice(1, near.i + 1) };
    const segB = { id: Model.uid("s"), a: junction.id, b: seg.b, length: lenB, bends: pts.slice(near.i + 1, pts.length - 1) };

    for (const sp of Model.splicesOf(h)) {
      if (sp.segId !== seg.id) continue;
      if (sp.t <= t) { sp.segId = segA.id; sp.t = t > 0 ? sp.t / t : 0; }
      else { sp.segId = segB.id; sp.t = t < 1 ? (sp.t - t) / (1 - t) : 1; }
    }

    h.segments = h.segments.filter((s) => s.id !== seg.id);
    h.segments.push(segA, segB);
    return junction;
  }

  /* ---------- moving a connector to another point ---------- */

  function startMove(connId) {
    pendingMove = connId;
    sel = { type: "conn", id: connId };
    updateHint();
    renderAll();
  }

  function cancelMove() {
    pendingMove = null;
    updateHint();
    renderAll();
  }

  function completeMove(nodeId) {
    const h = H();
    const conn = h.connectors.find((c) => c.id === pendingMove);
    pendingMove = null;
    updateHint();
    if (!conn || !nodeId) { renderAll(); return; }
    conn.nodeId = nodeId;
    // drop any manual placement so it re-splays cleanly around its new point
    delete conn.dx;
    delete conn.dy;
    sel = { type: "conn", id: conn.id };
    Model.changed();
  }

  // Insert a draggable bend point into a segment.
  function jogAt(seg, near) {
    seg.bends = seg.bends || [];
    seg.bends.splice(near.i, 0, { x: snap(near.x), y: snap(near.y) });
    sel = { type: "seg", id: seg.id };
    Model.changed();
  }

  /* ---------- splice points ---------- */

  const pointId = (point) => (point.kind === "mid" ? "sp:" + point.splice.id : "nd:" + point.nodeId);

  function splicePointPos(h, point) {
    if (point.kind === "mid") {
      const seg = segById(h, point.segId);
      const pts = seg && segPts(h, seg);
      return pts ? pointAlong(pts, point.t) : null;
    }
    const n = nodeById(h, point.nodeId);
    return n ? { x: n.x, y: n.y } : null;
  }

  const findPoint = (h, id) => SpliceEdit.findPoint(h, id);

  function deleteNode(id) {
    const h = H();
    Model.removeNode(h, id);
    if (connectFrom === id) connectFrom = null;
    sel = null;
    Model.changed();
  }

  function deleteSeg(id) {
    Model.removeSegment(H(), id);
    sel = null;
    Model.changed();
  }

  function deleteConn(id) {
    Model.removeConnector(H(), id);
    sel = null;
    Model.changed();
  }

  function deleteSelection() {
    if (!sel) return;
    if (sel.type === "node") deleteNode(sel.id);
    else if (sel.type === "seg") deleteSeg(sel.id);
    else if (sel.type === "conn") deleteConn(sel.id);
    else if (sel.type === "splice") {
      const h = H();
      h.splices = Model.splicesOf(h).filter((x) => x.id !== sel.id);
      sel = null;
      Model.changed();
    }
  }

  function escape() {
    connectFrom = null;
    pendingMove = null;
    sel = null;
    highlightSig = null;
    updateHint();
    render();
    renderSidebar();
  }

  function addConnectorAt(nodeId, { libId, termType }) {
    const h = H();
    const li = libId ? Model.libItem(libId) : null;
    const conn = {
      id: Model.uid("c"),
      nodeId,
      libId: libId || null,
      termType: termType || null,
      label: (li ? li.name : termType) + " " + (countInstances(li ? li.name : termType) + 1),
      pins: {},
    };
    h.connectors.push(conn);
    sel = { type: "conn", id: conn.id };
    Model.changed();
  }

  function countInstances(baseName) {
    let n = 0;
    for (const h of Model.get().harnesses) for (const c of h.connectors) if (c.label && c.label.startsWith(baseName)) n++;
    return n;
  }

  /* ---------- connector placement ---------- */

  function connPos(h, conn) {
    const node = nodeById(h, conn.nodeId);
    if (!node) return { x: 0, y: 0 };
    if (conn.dx != null && conn.dy != null) return { x: node.x + conn.dx, y: node.y + conn.dy };
    const siblings = connsAt(h, conn.nodeId);
    const i = siblings.indexOf(conn), cnt = siblings.length;
    // Point away from the harness (opposite the average direction of attached segments).
    let dx = 0, dy = 0;
    for (const s of segsAt(h, conn.nodeId)) {
      const o = nodeById(h, s.a === conn.nodeId ? s.b : s.a);
      if (!o) continue;
      const vx = o.x - node.x, vy = o.y - node.y;
      const L = Math.hypot(vx, vy) || 1;
      dx -= vx / L; dy -= vy / L;
    }
    let ang = Math.hypot(dx, dy) < 0.01 ? -Math.PI / 2 : Math.atan2(dy, dx);
    ang += (i - (cnt - 1) / 2) * 0.75;
    const r = 95;
    return { x: node.x + Math.cos(ang) * r, y: node.y + Math.sin(ang) * r };
  }

  /* ---------- wire runs (wire view) ---------- */

  // Lateral offset of one wire on one leg. Lanes are sorted by the run's
  // global rank, so a wire holds the same relative position along its whole
  // path instead of jumping lanes at every junction.
  // Lane spacing shrinks as a leg gets busier, so a fat bundle never fans out
  // wider than the harness itself (which made it look like extra legs).
  function laneStep(count) {
    if (count < 2) return 0;
    return Math.max(LANE_MIN, Math.min(LANE, BUNDLE_W / (count - 1)));
  }

  function laneOffset(laneMap, segId, run, orient) {
    const arr = laneMap[segId];
    if (!arr) return 0;
    const k = arr.indexOf(run);
    const side = orient ? (orient[segId] || 1) : 1;
    return (k - (arr.length - 1) / 2) * laneStep(arr.length) * side;
  }

  /* Root the harness as a tree. Gives three things at once: a consistent
   * "side" for lane offsets (legs are stored in arbitrary a/b order), a
   * parent/child relation per leg, and DFS in/out numbers used to order
   * wires by where they are heading. */
  function rootedTree(h) {
    const adj = {};
    h.nodes.forEach((n) => { adj[n.id] = []; });
    for (const s of h.segments) {
      if (adj[s.a] && adj[s.b]) {
        adj[s.a].push({ to: s.b, seg: s });
        adj[s.b].push({ to: s.a, seg: s });
      }
    }
    const parent = {}, orient = {}, child = {}, tin = {}, tout = {};
    const seen = {};
    let timer = 0;

    const dirTo = (from, to) => {
      const A = nodeById(h, from), B = nodeById(h, to);
      if (!A || !B) return { x: 1, y: 0 };
      const dx = B.x - A.x, dy = B.y - A.y;
      const L = Math.hypot(dx, dy) || 1;
      return { x: dx / L, y: dy / L };
    };
    // signed turn from the direction we arrived on to the direction of a branch
    const turn = (inDir, c) =>
      Math.atan2(inDir.x * c.y - inDir.y * c.x, inDir.x * c.x + inDir.y * c.y);

    // start from an end of the harness so the flow runs along it, not outwards
    // from the middle; ties broken by position to keep it deterministic
    const roots = h.nodes.slice().sort((a, b) =>
      ((adj[a.id] || []).length - (adj[b.id] || []).length) || (a.x - b.x) || (a.y - b.y));

    for (const start of roots) {
      if (seen[start.id]) continue;
      seen[start.id] = true;
      tin[start.id] = timer++;
      const stack = [{ id: start.id, inDir: { x: 1, y: 0 }, kids: null, i: 0 }];
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top.kids == null) {
          // walk branches in geometric order — the one peeling off furthest to
          // the left first — so a wire bound for a left-hand branch rides on
          // the left of the bundle and never has to cross to reach it
          top.kids = (adj[top.id] || []).slice().sort((p, q) =>
            turn(top.inDir, dirTo(top.id, p.to)) - turn(top.inDir, dirTo(top.id, q.to)));
        }
        if (top.i >= top.kids.length) { tout[top.id] = timer; stack.pop(); continue; }
        const e = top.kids[top.i++];
        if (orient[e.seg.id] == null) orient[e.seg.id] = e.seg.a === top.id ? 1 : -1;
        if (seen[e.to]) continue;
        seen[e.to] = true;
        parent[e.to] = top.id;
        child[e.seg.id] = e.to;
        tin[e.to] = timer++;
        stack.push({ id: e.to, inDir: dirTo(top.id, e.to), kids: null, i: 0 });
      }
    }
    for (const s of h.segments) if (orient[s.id] == null) orient[s.id] = 1;
    return { parent, orient, child, tin, tout };
  }

  /* Which end of a wire is which node, so we can ask "where is this one
   * heading". A splice part-way along a leg is treated as sitting at that
   * leg's child end, just short of everything beyond it. */
  function wireEndNodes(h, wire, tree) {
    const resolve = (key) => {
      if (Routing.isPinKey(key)) {
        const connId = key.split(":")[1];
        const f = Model.findConnector(connId);
        return f ? { n: f.conn.nodeId, k: tree.tin[f.conn.nodeId] } : null;
      }
      if (Routing.isSpKey(key)) {
        const sp = Model.splicesOf(h).find((x) => Routing.spKey(x.id) === key);
        const c = sp && tree.child[sp.segId];
        return c != null ? { n: c, k: tree.tin[c] - 0.5 } : null;
      }
      return tree.tin[key] != null ? { n: key, k: tree.tin[key] } : null;
    };
    return { A: resolve(wire.fromKey), B: resolve(wire.toKey) };
  }

  /* Order the wires on each leg by which way they are going, rather than by
   * signal name. In a tree the destinations beyond any leg form contiguous
   * DFS ranges, so wires bound for the same branch sit together and peel off
   * from the edge of the bundle — which is what stops them crossing. */
  function buildLaneMap(h, info, tree) {
    const laneMap = {};
    const ends = new Map();
    for (const w of info.wires) ends.set(w, wireEndNodes(h, w, tree));
    for (const w of info.wires) {
      const ids = new Set(w.steps.filter((s) => s.segId).map((s) => s.segId));
      for (const id of ids) (laneMap[id] = laneMap[id] || []).push(w);
    }
    const inSub = (r, c) => r && tree.tin[r.n] >= tree.tin[c] && tree.tin[r.n] < tree.tout[c];
    for (const [segId, arr] of Object.entries(laneMap)) {
      const c = tree.child[segId];
      const key = new Map();
      for (const w of arr) {
        const { A, B } = ends.get(w) || {};
        let k;
        if (c == null) k = w.rank;                       // leg outside the tree
        else if (inSub(A, c) && !inSub(B, c)) k = A.k;
        else if (inSub(B, c) && !inSub(A, c)) k = B.k;
        else k = Math.min(A ? A.k : Infinity, B ? B.k : Infinity);
        key.set(w, k);
      }
      arr.sort((a, b) => (key.get(a) - key.get(b)) || (a.rank - b.rank));
    }
    return laneMap;
  }

  function wireGeometry(h, info) {
    info = info || Routing.computeRuns(h);
    const tree = rootedTree(h);
    const orient = tree.orient;
    const laneMap = buildLaneMap(h, info, tree);
    // first pass: lanes only, so we can see where each wire actually arrives
    const raw = info.wires.map((w) => runPolyline(h, w, laneMap, orient));
    const hubs = buildHubs(h, info, raw, laneMap);
    const polys = info.wires.map((w, i) => snapEnds(h, raw[i], w, hubs));
    return { ...info, runs: info.wires, laneMap, orient, tree, hubs, polys };
  }

  /* A splice stops being a single point that everything is dragged onto.
   * Instead the node becomes a small zone, and each signal spliced there gets
   * its own junction dot — placed on the average lane of the wires that meet
   * there, and staggered along the run so several signals splicing at one
   * point don't all pile onto the same cross-section. */
  function buildHubs(h, info, raw, laneMap) {
    const arrivals = {};
    info.wires.forEach((w, i) => {
      const p = raw[i];
      if (!p || p.length < 2) return;
      for (const [key, pt] of [[w.fromKey, p[0]], [w.toKey, p[p.length - 1]]]) {
        if (Routing.isPinKey(key)) continue;
        arrivals[key] = arrivals[key] || {};
        (arrivals[key][w.sig.id] = arrivals[key][w.sig.id] || []).push(pt);
      }
    });

    const out = {};
    for (const point of info.points) {
      const pos = splicePointPos(h, point);
      if (!pos) continue;

      // stagger along the busiest leg meeting here
      let ax = 1, ay = 0;
      if (point.kind === "mid") {
        ax = pos.ux; ay = pos.uy;
      } else {
        let best = null, bestN = -1;
        for (const s of segsAt(h, point.nodeId)) {
          const n = (laneMap[s.id] || []).length;
          if (n > bestN) { bestN = n; best = s; }
        }
        const node = nodeById(h, point.nodeId);
        const other = best && nodeById(h, best.a === point.nodeId ? best.b : best.a);
        if (node && other) {
          const vx = other.x - node.x, vy = other.y - node.y;
          const L = Math.hypot(vx, vy) || 1;
          ax = vx / L; ay = vy / L;
        }
      }
      const px = -ay, py = ax;

      const sigs = point.signals.map((s) => s.sig);
      const sigPos = {};
      sigs.forEach((sig, i) => {
        const stagger = (i - (sigs.length - 1) / 2) * HUB_STEP;
        const arr = (arrivals[point.key] || {})[sig.id] || [];
        let perp = 0;
        if (arr.length) {
          // centre the dot on the lanes of its own wires, so they barely deviate
          perp = arr.reduce((a, p) => a + (p.x - pos.x) * px + (p.y - pos.y) * py, 0) / arr.length;
        }
        sigPos[sig.id] = { x: pos.x + px * perp + ax * stagger, y: pos.y + py * perp + ay * stagger };
      });

      let radius = 15;
      for (const p of Object.values(sigPos)) {
        radius = Math.max(radius, Math.hypot(p.x - pos.x, p.y - pos.y) + 11);
      }
      out[point.key] = { center: { x: pos.x, y: pos.y }, radius, sigPos, point };
    }
    return out;
  }

  /* Wires stop at the harness point a connector sits on — they don't fan out
   * to the connector block itself. The block carries the per-pin colours, so
   * nothing is lost, and the wires no longer cross each other trying to line
   * up with pin order. */
  function snapEnds(h, poly, wire, hubs) {
    if (!poly || poly.length < 2) return poly || [];
    const out = poly.slice();
    const place = (idx, key) => {
      const hub = hubs[key] && hubs[key].sigPos[wire.sig.id];
      if (hub) { out[idx] = { x: hub.x, y: hub.y }; return; }
      if (!Routing.isPinKey(key)) return;
      const f = Model.findConnector(key.split(":")[1]);
      const node = f && nodeById(h, f.conn.nodeId);
      if (node) out[idx] = { x: node.x, y: node.y };
    };
    place(0, wire.fromKey);
    place(out.length - 1, wire.toKey);
    return out;
  }

  // Build one wire as a list of per-leg pieces, then join them with short
  // diagonal transitions so the lane change at a junction reads as a fan
  // rather than a kink. Steps with no segId are pin tails, already drawn as
  // the connector's own stub.
  function runPolyline(h, wire, laneMap, orient, hubs) {
    const pieces = [];
    for (const st of wire.steps) {
      if (!st.segId) continue;
      const seg = segById(h, st.segId);
      const pts = seg && segPts(h, seg);
      if (!pts) continue;
      const lo = Math.min(st.t0, st.t1), hi = Math.max(st.t0, st.t1);
      if (hi - lo < 1e-6) continue;
      const part = offsetPoly(subPoly(pts, lo, hi), laneOffset(laneMap, st.segId, wire, orient));
      if (st.t0 > st.t1) part.reverse();
      pieces.push(part);
    }
    return joinPieces(pieces);
  }

  function trimEndpoint(p, atStart, d) {
    const i = atStart ? 0 : p.length - 1;
    const j = atStart ? 1 : p.length - 2;
    const a = p[i], b = p[j];
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const k = Math.min(d, L * 0.4) / L;
    p[i] = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  }

  function joinPieces(pieces) {
    const out = [];
    pieces.forEach((raw, i) => {
      const p = raw.slice();
      if (p.length < 2) return;
      if (i > 0) trimEndpoint(p, true, TRANS);
      if (i < pieces.length - 1) trimEndpoint(p, false, TRANS);
      out.push(...p);
    });
    return out.filter((p, i) => i === 0 || Math.hypot(p.x - out[i - 1].x, p.y - out[i - 1].y) > 0.01);
  }

  /* Hops: the wire with the higher rank arcs over the lower-ranked one.
   * Crossings at junctions (where a fan legitimately crosses) and shallow
   * near-parallel crossings are ignored — arcs there are just noise. */
  /* Wherever the bundle is turning or splitting — a node, a bend, a splice
   * zone — wires legitimately fan across one another, and an arc there is
   * just noise. Hops are only drawn for crossings out in open run. */
  function hopExclusions(h, geo) {
    const zones = h.nodes.map((n) => ({ x: n.x, y: n.y, r: NODE_CLEAR }));
    for (const seg of h.segments) {
      for (const b of seg.bends || []) zones.push({ x: b.x, y: b.y, r: NODE_CLEAR });
    }
    for (const hub of Object.values(geo.hubs || {})) {
      zones.push({ x: hub.center.x, y: hub.center.y, r: hub.radius + 8 });
    }
    return zones;
  }

  function computeHops(polys, runs, zones) {
    const hops = polys.map(() => ({}));
    const order = runs.map((_, i) => i).sort((a, b) => runs[a].rank - runs[b].rank);
    for (let oi = 1; oi < order.length; oi++) {
      const j = order[oi];
      const B = polys[j];
      if (B.length < 2) continue;
      for (let oj = 0; oj < oi; oj++) {
        const A = polys[order[oj]];
        if (A.length < 2) continue;
        for (let bs = 0; bs < B.length - 1; bs++) {
          for (let as = 0; as < A.length - 1; as++) {
            const x = segCross(B[bs], B[bs + 1], A[as], A[as + 1]);
            if (!x) continue;
            if (zones.some((z) => Math.hypot(z.x - x.x, z.y - x.y) < z.r)) continue;
            (hops[j][bs] = hops[j][bs] || []).push(x.t);
          }
        }
      }
    }
    return hops;
  }

  function segCross(p1, p2, p3, p4) {
    const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
    const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
    const den = d1x * d2y - d1y * d2x;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / den;
    const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / den;
    if (t <= 0.02 || t >= 0.98 || u <= 0.02 || u >= 0.98) return null;
    const L1 = Math.hypot(d1x, d1y) || 1, L2 = Math.hypot(d2x, d2y) || 1;
    if (Math.abs(den) / (L1 * L2) < 0.3) return null;   // too shallow to be a real crossing
    return { t, x: p1.x + d1x * t, y: p1.y + d1y * t };
  }

  const fmt = (v) => Math.round(v * 10) / 10;

  // SVG path for a polyline, inserting hop arcs at crossing fractions.
  function pathWithHops(pts, hopMap) {
    let d = `M ${fmt(pts[0].x)} ${fmt(pts[0].y)}`;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      const L = Math.hypot(dx, dy);
      const ts = (hopMap && hopMap[i - 1] ? hopMap[i - 1].slice() : []).sort((x, y) => x - y);
      if (L > HOP_R * 2 + 4) {
        const ux = dx / L, uy = dy / L;
        let last = 0;
        for (const t of ts) {
          const s = t * L;
          if (s < last + HOP_R + 2 || s > L - HOP_R - 2) continue;
          const cx = a.x + ux * s, cy = a.y + uy * s;
          d += ` L ${fmt(cx - ux * HOP_R)} ${fmt(cy - uy * HOP_R)}`
            + ` A ${HOP_R} ${HOP_R} 0 0 1 ${fmt(cx + ux * HOP_R)} ${fmt(cy + uy * HOP_R)}`;
          last = s + HOP_R;
        }
      }
      d += ` L ${fmt(b.x)} ${fmt(b.y)}`;
    }
    return d;
  }

  function drawRunPath(parent, d, sig, width) {
    parent.appendChild(svgEl("path", {
      d, stroke: sig.color.base, "stroke-width": width, fill: "none",
      "stroke-linecap": "round", "stroke-linejoin": "round",
    }));
    if (sig.color.style === "striped") {
      parent.appendChild(svgEl("path", {
        d, stroke: sig.color.stripe, "stroke-width": width, fill: "none",
        "stroke-dasharray": "7 7", "stroke-linecap": "butt", "stroke-linejoin": "round",
      }));
    }
  }

  /* ---------- rendering ---------- */

  function applyTransform() {
    const g = svg.querySelector("#world");
    if (g) g.setAttribute("transform", `translate(${panX} ${panY}) scale(${scale})`);
    const pat = svg.querySelector("#gridPattern");
    if (pat) pat.setAttribute("patternTransform", `translate(${panX} ${panY}) scale(${scale})`);
  }

  function render() {
    if (!svg) return;
    const h = H();
    if (!panInitialized && svg.clientWidth) {
      panX = svg.clientWidth / 2;
      panY = svg.clientHeight / 2;
      panInitialized = true;
    }
    svg.innerHTML = "";

    const defs = svgEl("defs", {});
    const pat = svgEl("pattern", { id: "gridPattern", width: 40, height: 40, patternUnits: "userSpaceOnUse" });
    pat.appendChild(svgEl("circle", { cx: 1, cy: 1, r: 1, fill: "var(--grid-dot)" }));
    defs.appendChild(pat);
    svg.appendChild(defs);
    const bgRect = svgEl("rect", { x: 0, y: 0, width: "100%", height: "100%", fill: "url(#gridPattern)" });
    bgRect.dataset.bg = "1";
    svg.appendChild(bgRect);

    const world = svgEl("g", { id: "world" });
    svg.appendChild(world);
    if (!h) { applyTransform(); return; }

    const wiresOn = viewMode === "wires";
    // splice points are wanted in both views, so route info is always computed
    const routeInfo = Routing.computeRuns(h);
    const geo = wiresOn ? wireGeometry(h, routeInfo) : null;

    /* segments (trunk polylines) */
    for (const seg of h.segments) {
      const pts = segPts(h, seg);
      if (!pts) continue;
      const ptsAttr = pts.map((p) => `${p.x},${p.y}`).join(" ");
      // In wire view, show the bundle envelope so the trunk stays readable
      // (and clickable) underneath the individual wires.
      if (wiresOn) {
        const n = (geo.laneMap[seg.id] || []).length;
        const band = Math.max(10, (n - 1) * laneStep(n) + 11);
        world.appendChild(svgEl("polyline", { points: ptsAttr, class: "seg-band", "stroke-width": band }));
      }
      const hit = svgEl("polyline", { points: ptsAttr, class: "seg-hit" });
      hit.addEventListener("pointerdown", (e) => onSegDown(e, seg));
      world.appendChild(hit);
      world.appendChild(svgEl("polyline", {
        points: ptsAttr,
        class: "seg-trunk" + (wiresOn ? " thin" : "") + (sel && sel.type === "seg" && sel.id === seg.id ? " selected" : ""),
      }));
      if (seg.length != null && seg.length !== "") {
        const mid = pointAlong(pts, 0.5);
        world.appendChild(svgEl("text", {
          x: mid.x - mid.uy * 14, y: mid.y + mid.ux * 14,
          class: "seg-label",
        }, `${seg.length} ${Model.get().unit}`));
      }
    }

    /* splice zones sit behind the wires, marking the junction area */
    if (wiresOn) {
      for (const point of routeInfo.points) {
        const hub = geo.hubs[point.key];
        if (!hub) continue;
        const lit = !highlightSig || point.signals.some((s) => s.sig.id === highlightSig);
        world.appendChild(svgEl("circle", {
          cx: hub.center.x, cy: hub.center.y, r: hub.radius,
          class: "splice-zone", opacity: lit ? null : DIM,
        }));
      }
    }

    /* individual wires */
    if (wiresOn) {
      const polys = geo.polys.map((p) => (p.length > 1 ? p : []));
      const hops = computeHops(polys, geo.runs, hopExclusions(h, geo));
      // draw dimmed wires first so the highlighted signal sits on top
      const order = geo.runs.map((_, i) => i)
        .filter((i) => polys[i].length >= 2)
        .sort((a, b) => {
          const ha = highlightSig && geo.runs[a].sig.id === highlightSig ? 1 : 0;
          const hb = highlightSig && geo.runs[b].sig.id === highlightSig ? 1 : 0;
          return ha - hb;
        });
      for (const ri of order) {
        const run = geo.runs[ri];
        const lit = !highlightSig || run.sig.id === highlightSig;
        const g = svgEl("g", lit ? {} : { opacity: DIM });
        drawRunPath(g, pathWithHops(polys[ri], hops[ri]), run.sig, highlightSig && lit ? 3.6 : 2.6);
        world.appendChild(g);
      }
    }

    /* connectors (splay lines + stubs + boxes) */
    for (const conn of h.connectors) {
      drawConnector(world, h, conn, wiresOn, geo);
    }

    /* splice points, in both views — explicit ones are solid, automatic ones
     * (at junctions where a signal's destinations diverge) are hollow. Each
     * carries its tag on a little flag so it can be found on the bench and
     * cross-referenced against the build sheet. */
    for (const point of routeInfo.points) {
      const pos = splicePointPos(h, point);
      if (!pos) continue;
      const sigs = point.signals.map((s) => s.sig);
      const allAuto = point.signals.every((s) => s.auto);
      const lit = !highlightSig || sigs.some((s) => s.id === highlightSig);
      const selected = sel && sel.type === "splice" && sel.id === pointId(point);
      const g = svgEl("g", {
        class: "splice-dot" + (selected ? " selected" : ""),
        opacity: lit ? null : DIM,
      });
      const hub = wiresOn && geo.hubs[point.key];
      if (hub) {
        // wire view: one junction dot per signal, where its wires come together
        for (const { sig } of point.signals) {
          const hp = hub.sigPos[sig.id];
          if (!hp) continue;
          const faded = highlightSig && sig.id !== highlightSig;
          g.appendChild(svgEl("circle", {
            cx: hp.x, cy: hp.y, r: 4.6,
            fill: UI.inkFor(sig.color.base),
            class: "splice-junction",
            opacity: faded ? 0.25 : null,
          }, svgEl("title", {}, `${point.tag} · ${sig.name}`)));
        }
      } else {
        const tint = sigs.length === 1 ? UI.inkFor(sigs[0].color.base) : "var(--node-end)";
        g.appendChild(svgEl("circle", {
          cx: pos.x, cy: pos.y, r: allAuto ? 5 : 6.5,
          fill: allAuto ? "#161a23" : tint,
          stroke: allAuto ? tint : "#f5f5f5",
          "stroke-width": allAuto ? 2 : 1.8,
          class: "splice-circle",
        }));
        if (sigs.length > 1) {
          g.appendChild(svgEl("text", { x: pos.x, y: pos.y + 3.5, class: "splice-count" }, String(sigs.length)));
        }
      }

      /* identifier flag */
      const label = point.tag;
      const fw = 9 + label.length * 6.6;
      const fx = pos.x + 9, fy = pos.y - 22;
      g.appendChild(svgEl("line", { x1: pos.x, y1: pos.y, x2: fx + 1, y2: fy + 14, class: "splice-stem" }));
      g.appendChild(svgEl("rect", {
        x: fx, y: fy, width: fw, height: 15, rx: 3,
        class: "splice-flag" + (selected ? " selected" : "") + (allAuto ? " auto" : ""),
      }));
      g.appendChild(svgEl("text", {
        x: fx + fw / 2, y: fy + 11.5,
        class: "splice-flag-text" + (allAuto ? " auto" : ""),
      }, label));

      g.appendChild(svgEl("title", {},
        `${label} — ${Routing.pointName(h, point)}${allAuto ? " (automatic)" : ""}`
        + "\n" + sigs.map((s) => s.name).join(", ")));
      g.addEventListener("pointerdown", (e) => onSpliceDown(e, point));
      world.appendChild(g);
    }

    /* bend handles */
    for (const seg of h.segments) {
      (seg.bends || []).forEach((bp, idx) => {
        const r = svgEl("rect", {
          x: bp.x - 4, y: bp.y - 4, width: 8, height: 8,
          class: "bend-handle",
        });
        r.addEventListener("pointerdown", (e) => onBendDown(e, seg, idx));
        world.appendChild(r);
      });
    }

    /* nodes on top */
    for (const node of h.nodes) {
      const isEndpoint = segsAt(h, node.id).length <= 1 || connsAt(h, node.id).length > 0;
      const selectedNode = sel && sel.type === "node" && sel.id === node.id;
      const faint = wiresOn && !selectedNode && connectFrom !== node.id && !pendingMove;
      const c = svgEl("circle", {
        cx: node.x, cy: node.y,
        r: faint ? (isEndpoint ? 4.5 : 3.5) : (isEndpoint ? 7.5 : 5),
        class: "node-dot " + (faint ? "faint " : "") + (isEndpoint ? "node-endpoint" : "node-junction")
          + (sel && sel.type === "node" && sel.id === node.id ? " selected" : "")
          + (connectFrom === node.id ? " connect-from" : "")
          + (pendingMove ? " move-target" : ""),
      });
      c.addEventListener("pointerdown", (e) => onNodeDown(e, node));
      world.appendChild(c);
    }

    /* empty-state hint */
    if (!h.nodes.length) {
      world.appendChild(svgEl("text", { x: 0, y: -10, class: "canvas-hint" },
        "Pick “Add point” and click here to place your first connector point."));
      world.appendChild(svgEl("text", { x: 0, y: 14, class: "canvas-hint" },
        "Then “Connect” points with lines, and click a line in “Add point” mode to branch a leg."));
    }

    /* wire-view legend */
    if (wiresOn) {
      const sigs = Model.get().signals.filter((s) => Model.signalUses(s.id).some((u) => u.harness.id === h.id));
      if (sigs.length) {
        const lh = 19;
        const lg = svgEl("g", { transform: "translate(12 12)" });
        lg.appendChild(svgEl("rect", { x: 0, y: 0, width: 195, height: sigs.length * lh + 14, rx: 8, fill: "var(--legend-fill)", stroke: "var(--line)" }));
        sigs.forEach((s, i) => {
          const y = 15 + i * lh;
          drawRunPath(lg, `M 12 ${y} L 44 ${y}`, s, 4);
          lg.appendChild(svgEl("text", { x: 52, y: y + 4, fill: "var(--text)", "font-size": 12 }, s.name));
        });
        svg.appendChild(lg);
      }
    }

    applyTransform();
  }

  function drawWire(parent, p1, p2, sig, w) {
    drawRunPath(parent, `M ${fmt(p1.x)} ${fmt(p1.y)} L ${fmt(p2.x)} ${fmt(p2.y)}`, sig, w);
  }

  function drawConnector(world, h, conn, wiresOn, geo) {
    const node = nodeById(h, conn.nodeId);
    if (!node) return;
    const pos = connPos(h, conn);
    const spec = Model.connSpec(conn);
    const pins = Model.assignedPins(conn);

    const dx = node.x - pos.x, dy = node.y - pos.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist, uy = dy / dist;
    const px = -uy, py = ux;
    const ext = 26;
    const convDist = Math.min(dist * 0.55, ext + 42);
    const conv = { x: pos.x + ux * convDist, y: pos.y + uy * convDist };

    const hlSig = highlightSig ? Model.signal(highlightSig) : null;
    const carries = !!hlSig && pins.some((p) => conn.pins[p].signalId === hlSig.id);
    const outer = svgEl("g", hlSig && !carries ? { opacity: 0.28 } : {});

    // One clean tether in both views: individual wires stop at the harness
    // point, and the per-pin colours live on the box chips instead. Fanning
    // them out to the block only made them cross to reach pin order.
    outer.appendChild(svgEl("line", {
      x1: pos.x + ux * ext, y1: pos.y + uy * ext, x2: node.x, y2: node.y,
      class: "splay-line" + (pins.length ? " bundled" : ""),
      style: carries ? { stroke: UI.inkFor(hlSig.color.base) } : null,
    }));

    /* the connector box */
    const label = conn.label || spec.name;
    const showChips = pins.length > 0;
    const boxW = Math.max(78, label.length * 7.2 + 18) + (spec.imageData ? 34 : 0);
    const boxH = showChips ? 54 : 42;
    const g = svgEl("g", { transform: `translate(${pos.x - boxW / 2} ${pos.y - boxH / 2})` });
    const rect = svgEl("rect", {
      width: boxW, height: boxH, rx: 7,
      class: "conn-box" + (sel && sel.type === "conn" && sel.id === conn.id ? " selected" : "")
        + (carries ? " highlighted" : ""),
    });
    rect.addEventListener("pointerdown", (e) => onConnDown(e, conn));
    rect.addEventListener("dblclick", () => PinoutView.open(conn.id));
    g.appendChild(rect);
    let tx = 9;
    if (spec.imageData) {
      g.appendChild(svgEl("image", { href: spec.imageData, x: 5, y: 5, width: 32, height: 32, preserveAspectRatio: "xMidYMid meet", "pointer-events": "none" }));
      tx = 42;
    }
    g.appendChild(svgEl("text", { x: tx, y: 17, class: "conn-label" }, label));
    g.appendChild(svgEl("text", { x: tx, y: 32, class: "conn-sub" }, `${spec.name} · ${pins.length}/${spec.pinCount}`));

    /* wire-color chips along the bottom of the box — always legible, whatever
     * direction the connector is dragged to */
    if (showChips) {
      const chipW = 9, gap = 3, chipY = boxH - 13, chipH = 7;
      const avail = boxW - tx - 9;
      let slots = Math.max(1, Math.floor((avail + gap) / (chipW + gap)));
      let list = pins;
      if (pins.length > slots) list = pins.slice(0, Math.max(1, slots - 1));
      list.forEach((p, i) => {
        const sig = Model.signal(conn.pins[p].signalId);
        if (!sig) return;
        const cx = tx + i * (chipW + gap);
        const isHl = hlSig && sig.id === hlSig.id;
        g.appendChild(svgEl("rect", {
          x: cx, y: chipY, width: chipW, height: chipH, rx: 2,
          fill: sig.color.base, stroke: isHl ? "var(--text)" : "var(--chip-edge)", "stroke-width": isHl ? 1.8 : 1,
        }, svgEl("title", {}, `Pin ${Model.pinLabel(spec, p)}: ${sig.name}`)));
        if (sig.color.style === "striped") {
          g.appendChild(svgEl("rect", {
            x: cx + 1, y: chipY + chipH - 3.4, width: chipW - 2, height: 2.4, rx: 1,
            fill: sig.color.stripe, "pointer-events": "none",
          }));
        }
      });
      if (pins.length > list.length) {
        g.appendChild(svgEl("text", {
          x: tx + list.length * (chipW + gap) + 1, y: chipY + chipH,
          class: "conn-sub",
        }, `+${pins.length - list.length}`));
      }
    }

    if (Main.mateIssues().has(conn.id)) {
      const b = svgEl("g", { transform: `translate(${boxW - 2} 2)`, style: "cursor:pointer" });
      b.appendChild(svgEl("circle", { r: 9, class: "mate-badge" }));
      b.appendChild(svgEl("text", { y: 4, class: "mate-badge-text" }, "!"));
      b.appendChild(svgEl("title", {}, "Mated connector pinout mismatch — see Compare tab"));
      b.addEventListener("pointerdown", (e) => { e.stopPropagation(); const m = Model.mateFor(conn.id); if (m) CompareView.openMate(m); });
      g.appendChild(b);
    }
    outer.appendChild(g);
    world.appendChild(outer);
  }

  function fit() {
    const h = H();
    if (!h || !h.nodes.length || !svg.clientWidth) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const consider = (x, y) => {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    };
    h.nodes.forEach((n) => consider(n.x, n.y));
    h.segments.forEach((s) => (s.bends || []).forEach((b) => consider(b.x, b.y)));
    h.connectors.forEach((c) => { const p = connPos(h, c); consider(p.x, p.y); });
    const pad = 130;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    scale = Math.min(2, svg.clientWidth / (maxX - minX), svg.clientHeight / (maxY - minY));
    panX = (svg.clientWidth - (maxX - minX) * scale) / 2 - minX * scale;
    panY = (svg.clientHeight - (maxY - minY) * scale) / 2 - minY * scale;
    applyTransform();
  }

  /* ---------- sidebar ---------- */

  function toggleHighlight(sigId) {
    highlightSig = highlightSig === sigId ? null : sigId;
    renderAll();
  }

  function renderSidebar() {
    if (!sidebar) return;
    const top = sidebar.scrollTop;
    sidebar.innerHTML = "";
    const h = H();
    if (h) {
      buildSelectionPanel(h);
      buildSignalPanel(h);
    }
    sidebar.scrollTop = top;
  }

  function buildSelectionPanel(h) {
    if (!sel) {
      sidebar.appendChild(el("h3", {}, "Layout"));
      sidebar.appendChild(el("div", { class: "side-help" },
        el("p", {}, "Sketch the rough shape of the harness — the drawing doesn't need to be to scale, it just captures the legs and branch points. Annotate real lengths on each line."),
        el("p", {},
          el("kbd", {}, "V"), " select · ", el("kbd", {}, "A"), " add point · ",
          el("kbd", {}, "C"), " connect · ", el("kbd", {}, "J"), " jog · ",
          el("kbd", {}, "X"), " delete · ",
          el("kbd", {}, "Del"), " remove selected · ", el("kbd", {}, "Ctrl+Z"), " undo"),
        el("p", {}, "Select a connector point to attach connectors to it — a point can hold several (multiple multi-pin connectors, a stack of ring terminals, etc.)."),
        el("p", {}, "Use the Jog tool to put bends in a leg, and the Splice tool (in Wire view) to mark where a shared signal splits into individual wires.")));
      return;
    }

    if (sel.type === "node") {
      const node = nodeById(h, sel.id);
      if (!node) { sel = null; return buildSelectionPanel(h); }
      const conns = connsAt(h, node.id);
      const degree = segsAt(h, node.id).length;
      sidebar.appendChild(el("h3", {}, degree >= 2 && !conns.length ? "Junction" : "Connector point"));
      sidebar.appendChild(el("div", { class: "muted small" }, `${degree} leg(s) attached`));
      sidebar.appendChild(el("h4", {}, `Connectors here (${conns.length})`));
      for (const conn of conns) {
        const spec = Model.connSpec(conn);
        sidebar.appendChild(el("div", { class: "conn-row" },
          el("span", { class: "name" }, conn.label, el("span", { class: "sub" }, ` ${spec.name}`)),
          el("button", { class: "icon-btn", title: "Edit pinout", onclick: () => PinoutView.open(conn.id) }, "pins"),
          el("button", { class: "icon-btn danger", title: "Remove", onclick: () => deleteConn(conn.id) }, "✕")));
      }
      sidebar.appendChild(el("div", { class: "side-row" },
        el("button", { onclick: () => {
          const items = Model.get().library.map((l) => ({ label: l.name, sub: `${l.pinCount} pins`, value: l.id }));
          UI.choose("Add connector from library", items, (libId) => addConnectorAt(node.id, { libId }),
            "Library is empty — create connector types on the Connector Library tab first.");
        } }, "＋ Library connector"),
        el("button", { onclick: () => {
          UI.choose("Add terminal", Model.TERMINAL_TYPES.map((t) => ({ label: t, value: t })), (t) => addConnectorAt(node.id, { termType: t }));
        } }, "＋ Terminal")));
      sidebar.appendChild(el("div", { class: "hint-box" },
        "Add every connector that lives at this point — they'll splay out around it. Drag them to arrange."));
      return;
    }

    if (sel.type === "seg") {
      const seg = segById(h, sel.id);
      if (!seg) { sel = null; return buildSelectionPanel(h); }
      sidebar.appendChild(el("h3", {}, "Harness leg"));
      sidebar.appendChild(el("div", { class: "side-row" },
        el("label", {}, "Length"),
        el("input", { type: "number", min: 0, step: "any", value: seg.length != null ? seg.length : "", onchange: (e) => {
          seg.length = e.target.value === "" ? null : Number(e.target.value);
          Model.changed();
        } }),
        el("span", { class: "muted" }, Model.get().unit)));
      const bendCount = (seg.bends || []).length;
      sidebar.appendChild(el("div", { class: "hint-box" },
        "“Add point” mode: click this line to branch a new leg off it. “Jog” mode: click it to add a bend you can drag."));
      if (bendCount) {
        sidebar.appendChild(el("div", { class: "side-row" },
          el("span", { class: "muted small" }, `${bendCount} bend(s)`),
          el("button", { class: "icon-btn", onclick: () => { seg.bends = []; Model.changed(); } }, "Straighten")));
      }
      sidebar.appendChild(el("button", { class: "danger", onclick: () => deleteSeg(seg.id) }, "Delete leg"));
      return;
    }

    if (sel.type === "conn") {
      const conn = h.connectors.find((c) => c.id === sel.id);
      if (!conn) { sel = null; return buildSelectionPanel(h); }
      const spec = Model.connSpec(conn);
      sidebar.appendChild(el("h3", {}, "Connector"));
      if (pendingMove === conn.id) {
        sidebar.appendChild(el("div", { class: "warn-box" },
          "Pick a destination on the canvas: another connector point, a leg (to break out there), or empty space for a new point. ",
          el("button", { class: "icon-btn", onclick: cancelMove }, "Cancel move")));
      }
      sidebar.appendChild(el("div", { class: "side-row" },
        el("label", {}, "Label"),
        el("input", { value: conn.label, style: { flex: 1 }, onchange: (e) => { conn.label = e.target.value.trim() || conn.label; Model.changed(); } })));
      sidebar.appendChild(el("div", { class: "muted small" }, `${spec.name} — ${Model.assignedPins(conn).length}/${spec.pinCount} pins assigned`));
      sidebar.appendChild(el("div", { class: "side-row" },
        el("label", { title: "Extra wire from the harness breakout to this connector — added to every wire's cut length on the build sheet" }, "Lead"),
        el("input", {
          type: "number", min: 0, step: "any", value: conn.lead != null ? conn.lead : "",
          placeholder: "0",
          onchange: (e) => { conn.lead = e.target.value === "" ? null : Number(e.target.value); Model.changed(); },
        }),
        el("span", { class: "muted" }, Model.get().unit)));

      sidebar.appendChild(el("h4", {}, "Wires at this connector"));
      const pinList = el("div", { class: "pin-list" });
      for (let p = 1; p <= spec.pinCount; p++) {
        const pa = conn.pins && conn.pins[p];
        const sig = pa && pa.signalId ? Model.signal(pa.signalId) : null;
        pinList.appendChild(el("div", {
          class: "pin-line" + (sig ? "" : " empty") + (sig && highlightSig === sig.id ? " hl" : ""),
          title: sig ? `Click to highlight "${sig.name}" everywhere it runs` : "Unassigned pin",
          onclick: sig ? () => toggleHighlight(sig.id) : null,
        },
          el("span", { class: "pin-no" }, Model.pinLabel(spec, p)),
          sig ? UI.swatch(sig.color) : el("span", { class: "swatch empty-swatch" }),
          el("span", { class: "pin-sig" + (sig ? "" : " muted") }, sig ? sig.name : "—"),
          sig && sig.gauge ? el("span", { class: "muted small" }, sig.gauge) : null));
      }
      sidebar.appendChild(pinList);
      sidebar.appendChild(el("div", { class: "muted small" },
        "Click a wire to highlight every connector it reaches."));

      const mate = Model.mateFor(conn.id);
      if (mate) {
        const st = Model.mateStatus(mate);
        const otherId = mate.a === conn.id ? mate.b : mate.a;
        const other = Model.findConnector(otherId);
        sidebar.appendChild(el("div", { class: st.ok ? "hint-box" : "warn-box" },
          st.ok ? "✓ Mated to " : "⚠ Pinout mismatch with ",
          other ? `"${other.conn.label}" (${other.harness.name})` : "(deleted connector)"));
      }
      sidebar.appendChild(el("div", { class: "side-row" },
        el("button", { class: "primary", onclick: () => PinoutView.open(conn.id) }, "Edit pinout"),
        el("button", { onclick: () => startMove(conn.id) }, "⤴ Move to point"),
        el("button", { class: "danger", onclick: () => deleteConn(conn.id) }, "Delete")));
      sidebar.appendChild(el("div", { class: "hint-box" },
        "Drag the connector box to reposition it around its point; use ", el("b", {}, "Move to point"),
        " to re-home it on a different point (pins and mates come with it). Double-click it on the canvas to jump straight to its pinout."));
      return;
    }

    if (sel.type === "splice") {
      const point = findPoint(h, sel.id);
      if (!point) { sel = null; return buildSelectionPanel(h); }
      SpliceEdit.panel(sidebar, h, point, { onDeleted: () => { sel = null; } });
      return;
    }
  }

  /* Signal list: click one to highlight every connector it runs to. */
  function buildSignalPanel(h) {
    const sigs = Model.get().signals
      .map((s) => ({ sig: s, conns: new Set(Model.signalUses(s.id).filter((u) => u.harness.id === h.id).map((u) => u.conn.id)) }))
      .filter((r) => r.conns.size);

    sidebar.appendChild(el("h4", {}, "Highlight a signal"));
    if (!sigs.length) {
      sidebar.appendChild(el("div", { class: "muted small" },
        "No signals are assigned in this harness yet — assign some on the Pinouts & Signals tab."));
      return;
    }
    if (highlightSig && Model.signal(highlightSig)) {
      sidebar.appendChild(el("button", {
        class: "icon-btn", style: { marginBottom: "6px" },
        onclick: () => toggleHighlight(highlightSig),
      }, "✕ Clear highlight"));
    }
    const listBox = el("div", {});
    const fill = (q) => {
      listBox.innerHTML = "";
      const qq = (q || "").trim().toLowerCase();
      for (const { sig, conns } of sigs) {
        if (qq && !(sig.name + " " + (sig.type || "")).toLowerCase().includes(qq)) continue;
        listBox.appendChild(el("div", {
          class: "sig-row" + (highlightSig === sig.id ? " active" : ""),
          onclick: () => toggleHighlight(sig.id),
        },
          UI.swatch(sig.color),
          el("span", { class: "name" }, sig.name, sig.type ? el("span", { class: "sig-type-tag" }, sig.type) : null),
          el("span", { class: "uses" }, `${conns.size} conn`)));
      }
    };
    if (sigs.length > 8) {
      sidebar.appendChild(el("input", {
        placeholder: "Filter signals…", style: { width: "100%", marginBottom: "6px" },
        oninput: (e) => fill(e.target.value),
      }));
    }
    fill("");
    sidebar.appendChild(listBox);
  }

  function renderAll() {
    render();
    renderSidebar();
  }

  function onHarnessSwitched() {
    sel = null;
    connectFrom = null;
    pendingMove = null;
    highlightSig = null;
    updateHint();
    renderAll();
  }

  return { init, render: renderAll, fit, setMode, deleteSelection, escape, onHarnessSwitched };
})();
