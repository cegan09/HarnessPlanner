"use strict";
/*
 * Wire Diagram tab — an orthogonal, schematic-style view of the harness.
 *
 * This is deliberately NOT the freeform Layout drawing. The layout is a sketch
 * of the real harness shape; this is the wiring document you read while
 * building or debugging, so it follows strict rules:
 *
 *   - every leg is drawn horizontal or vertical (diagonals become an elbow)
 *   - collinear legs join into one "corridor"; a wire holds a single lane for
 *     the whole corridor and never wanders, so a wire crossing the harness is
 *     one dead-straight line
 *   - a wire leaving the bundle turns through a true right angle
 *   - when a wire leaves, its lane stays empty rather than everything shuffling
 *   - wires terminate fanned out side by side at a connector point; they do
 *     not converge on it. The connector block carries the per-pin colours.
 *   - splice dots land on the intersection of the lanes that meet there, so
 *     runs into and out of a splice stay straight and square
 */
const WireDiagram = (() => {
  const { svgEl, el } = UI;

  const LANE = 11;          // spacing between wire lanes
  const DOT_R = 4.4;        // junction dot
  const TERM = 16;          // how far past the point a terminating wire runs

  let svg, sidebar;
  let scale = 1, panX = 0, panY = 0, inited = false;
  let drag = null;
  let mode = "select";      // select | splice
  let highlightSig = null;
  let sel = null;           // {type:'splice'|'conn'|'node', id}

  const HINTS = {
    select: "Drag points, connector blocks and splice tags to tidy the drawing · click a connector for its wires · drag empty space to pan, scroll to zoom",
    splice: "Click a harness point or a leg to choose which signals splice there · Esc to stop",
  };

  /* ---------- geometry helpers ---------- */

  const nodeById = (h, id) => h.nodes.find((n) => n.id === id);
  const key2 = (p) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;

  function segPolyline(h, seg) {
    const A = nodeById(h, seg.a), B = nodeById(h, seg.b);
    if (!A || !B) return null;
    return [{ x: A.x, y: A.y }, ...(seg.bends || []).map((b) => ({ x: b.x, y: b.y })), { x: B.x, y: B.y }];
  }

  // Replace any diagonal with an elbow, keeping the original points in place.
  function orthoPoints(pts) {
    const out = [{ ...pts[0] }];
    for (let i = 1; i < pts.length; i++) {
      const P = out[out.length - 1], Q = pts[i];
      const dx = Q.x - P.x, dy = Q.y - P.y;
      if (dx === 0 || dy === 0) { out.push({ ...Q }); continue; }
      // turn along the dominant axis first, so the elbow sits at the short end
      out.push(Math.abs(dx) >= Math.abs(dy) ? { x: Q.x, y: P.y } : { x: P.x, y: Q.y });
      out.push({ ...Q });
    }
    return out;
  }

  const manhattan = (a, b) => Math.abs(b.x - a.x) + Math.abs(b.y - a.y);

  // Split the polyline at fraction t (by length) and return that point's index.
  function insertAt(pts, t) {
    const lens = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) { const L = manhattan(pts[i - 1], pts[i]); lens.push(L); total += L; }
    let want = Math.max(0, Math.min(1, t)) * total;
    for (let i = 0; i < lens.length; i++) {
      if (want <= lens[i] + 1e-9) {
        const k = lens[i] ? want / lens[i] : 0;
        if (k < 1e-6) return i;
        if (k > 1 - 1e-6) return i + 1;
        const P = pts[i], Q = pts[i + 1];
        pts.splice(i + 1, 0, { x: P.x + (Q.x - P.x) * k, y: P.y + (Q.y - P.y) * k });
        return i + 1;
      }
      want -= lens[i];
    }
    return pts.length - 1;
  }

  /* ---------- skeleton: orthogonal runs grouped into corridors ---------- */

  function buildSkeleton(h) {
    const runs = [];
    const segRuns = {};      // segId -> ordered run indices
    const segMarks = {};     // segId -> [{t, idx}] point indices for 0, splices, 1

    for (const seg of h.segments) {
      const raw = segPolyline(h, seg);
      if (!raw) continue;
      const pts = orthoPoints(raw);
      const marks = [{ t: 0, idx: 0 }];
      const mids = Model.splicesOf(h)
        .filter((sp) => sp.segId === seg.id && !sp.nodeId)
        .slice().sort((a, b) => a.t - b.t);
      for (const sp of mids) marks.push({ t: sp.t, idx: insertAt(pts, sp.t), spliceId: sp.id });
      marks.push({ t: 1, idx: pts.length - 1 });

      const idxs = [];
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        if (a.x === b.x && a.y === b.y) continue;
        const ax = a.y === b.y ? "h" : "v";
        idxs.push(runs.length);
        runs.push({ id: runs.length, segId: seg.id, ax, fixed: ax === "h" ? a.y : a.x, a, b, corridor: -1 });
      }
      segRuns[seg.id] = idxs;
      segMarks[seg.id] = marks;
    }

    /* corridors: collinear runs that touch */
    const parent = runs.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const join = (i, j) => { const a = find(i), b = find(j); if (a !== b) parent[a] = b; };
    const atPoint = {};
    runs.forEach((r) => {
      for (const p of [r.a, r.b]) (atPoint[key2(p)] = atPoint[key2(p)] || []).push(r);
    });
    for (const list of Object.values(atPoint)) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          if (list[i].ax === list[j].ax && Math.abs(list[i].fixed - list[j].fixed) < 0.01) join(list[i].id, list[j].id);
        }
      }
    }
    const corridors = {};
    for (const r of runs) {
      const c = find(r.id);
      r.corridor = c;
      const co = corridors[c] || (corridors[c] = { id: c, ax: r.ax, fixed: r.fixed, runs: [], lanes: [] });
      co.runs.push(r);
    }
    return { runs, segRuns, segMarks, corridors };
  }

  /* ---------- map each wire onto the skeleton ---------- */

  const alongOf = (co, p) => (co.ax === "h" ? p.x : p.y);

  function wireRunPath(h, sk, wire) {
    const out = [];
    for (const st of wire.steps) {
      if (!st.segId) continue;
      const idxs = sk.segRuns[st.segId];
      const marks = sk.segMarks[st.segId];
      if (!idxs || !marks) continue;
      const near = (t) => {
        let best = marks[0];
        for (const m of marks) if (Math.abs(m.t - t) < Math.abs(best.t - t)) best = m;
        return best.idx;
      };
      const i0 = near(st.t0), i1 = near(st.t1);
      // run n spans point n..n+1 within this segment
      if (i1 > i0) for (let k = i0; k < i1; k++) out.push({ run: sk.runs[idxs[k]], fwd: true });
      else for (let k = i0 - 1; k >= i1; k--) out.push({ run: sk.runs[idxs[k]], fwd: false });
    }
    return out;
  }

  /* ---------- lanes ---------- */

  /* A signal is one conductor, so all its wires share a lane within a corridor
   * — unless the user has told it to route through as separate wires, in which
   * case overlapping runs get lanes of their own. */
  function assignLanes(h, info, sk) {
    const paths = new Map();
    for (const w of info.wires) paths.set(w, wireRunPath(h, sk, w));

    // which wires use each corridor, and over what stretch
    const use = {};
    for (const w of info.wires) {
      for (const step of paths.get(w)) {
        const co = sk.corridors[step.run.corridor];
        const rec = (use[co.id] = use[co.id] || new Map());
        const lo = Math.min(alongOf(co, step.run.a), alongOf(co, step.run.b));
        const hi = Math.max(alongOf(co, step.run.a), alongOf(co, step.run.b));
        const cur = rec.get(w);
        if (cur) { cur.lo = Math.min(cur.lo, lo); cur.hi = Math.max(cur.hi, hi); }
        else rec.set(w, { lo, hi });
      }
    }

    const laneOf = new Map();    // `${corridorId}|${wireIdx}` -> lane index
    for (const co of Object.values(sk.corridors)) {
      const rec = use[co.id];
      if (!rec) continue;

      // group a signal's wires into shared tracks where they don't overlap
      const bySig = new Map();
      for (const [w, span] of rec) {
        const g = bySig.get(w.sig.id) || [];
        g.push({ w, span });
        bySig.set(w.sig.id, g);
      }
      const tracks = [];
      for (const group of bySig.values()) {
        group.sort((a, b) => a.span.lo - b.span.lo);
        const sub = [];
        for (const item of group) {
          let placed = false;
          for (const t of sub) {
            if (item.span.lo >= t.hi - 0.01) { t.hi = item.span.hi; t.items.push(item); placed = true; break; }
          }
          if (!placed) sub.push({ hi: item.span.hi, items: [item] });
        }
        for (const t of sub) {
          const lo = Math.min(...t.items.map((i) => i.span.lo));
          const hi = Math.max(...t.items.map((i) => i.span.hi));
          tracks.push({ sig: t.items[0].w.sig, items: t.items, lo, hi, rank: t.items[0].w.rank });
        }
      }

      /* Order tracks across the corridor by which side they attach to.
       * Wires that peel off towards one side sit on that side of the bundle,
       * earliest departure outermost, so nothing has to cross to get out. */
      for (const t of tracks) {
        let top = null, bot = null;
        for (const { w } of t.items) {
          const path = paths.get(w);
          for (let i = 0; i < path.length; i++) {
            if (path[i].run.corridor !== co.id) continue;
            for (const nb of [path[i - 1], path[i + 1]]) {
              if (!nb || nb.run.corridor === co.id) continue;
              const other = sk.corridors[nb.run.corridor];
              if (other.ax === co.ax) continue;
              const p = nb.fwd ? nb.run.b : nb.run.a;
              const side = (co.ax === "h" ? p.y : p.x) - co.fixed;
              const at = alongOf(co, nb.fwd ? nb.run.a : nb.run.b);
              if (side < 0) top = top == null ? at : Math.min(top, at);
              else if (side > 0) bot = bot == null ? at : Math.max(bot, at);
            }
          }
        }
        t.band = (top != null ? -1 : 0) + (bot != null ? 1 : 0);
        t.top = top; t.bot = bot;
      }
      tracks.sort((a, b) =>
        (a.band - b.band)
        || (a.band < 0 ? (a.top - b.top) : a.band > 0 ? (b.bot - a.bot) : 0)
        || (a.rank - b.rank));
      tracks.forEach((t, i) => {
        t.lane = i;
        for (const { w } of t.items) laneOf.set(`${co.id}|${w.idx}`, i);
      });
      co.lanes = tracks;
      co.count = tracks.length;
    }
    return { paths, laneOf };
  }

  const laneOffset = (co, lane) => (lane - (co.count - 1) / 2) * LANE;

  function lineCoord(co, lane) { return co.fixed + laneOffset(co, lane); }

  /* ---------- build the drawn polyline for each wire ---------- */

  function corridorSeq(sk, path) {
    const seq = [];
    for (const step of path) {
      const co = sk.corridors[step.run.corridor];
      const last = seq[seq.length - 1];
      const a = step.fwd ? step.run.a : step.run.b;
      const b = step.fwd ? step.run.b : step.run.a;
      if (last && last.co.id === co.id) { last.end = b; }
      else seq.push({ co, start: a, end: b });
    }
    return seq;
  }

  function buildGeometry(h) {
    const info = Routing.computeRuns(h);
    const sk = buildSkeleton(h);
    const { paths, laneOf } = assignLanes(h, info, sk);

    // where each splice sits: the crossing of the lanes that meet there
    const spliceAt = {};
    for (const point of info.points) {
      for (const { sig } of point.signals) {
        const hits = [];
        for (const w of info.wires) {
          if (w.sig.id !== sig.id) continue;
          if (w.fromKey !== point.key && w.toKey !== point.key) continue;
          const seq = corridorSeq(sk, paths.get(w));
          if (!seq.length) continue;
          // take the end of the run that actually touches this splice — the
          // near end for a wire leaving it, the far end for one arriving
          const leaving = w.fromKey === point.key;
          const run = leaving ? seq[0] : seq[seq.length - 1];
          hits.push({ co: run.co, near: leaving ? run.start : run.end });
        }
        if (!hits.length) continue;
        const lineOf = (s) => lineCoord(s.co, laneIdx(s.co, sig, info, laneOf));
        const hz = hits.find((s) => s.co.ax === "h"), vt = hits.find((s) => s.co.ax === "v");
        let pos;
        if (hz && vt) {
          // the joint lands where the two lanes cross, keeping both runs square
          pos = { x: lineOf(vt), y: lineOf(hz) };
        } else {
          const s = hits[0];
          const l = lineOf(s);
          const at = alongOf(s.co, s.near);
          pos = s.co.ax === "h" ? { x: at, y: l } : { x: l, y: at };
        }
        (spliceAt[point.key] = spliceAt[point.key] || {})[sig.id] = pos;
      }
    }

    const polys = info.wires.map((w) => {
      const seq = corridorSeq(sk, paths.get(w));
      if (!seq.length) return [];
      const lines = seq.map((s) => ({ s, coord: lineCoord(s.co, laneOf.get(`${s.co.id}|${w.idx}`) || 0) }));
      const pts = [];

      const endPoint = (which) => {
        const key = which === 0 ? w.fromKey : w.toKey;
        const sp = spliceAt[key] && spliceAt[key][w.sig.id];
        if (sp) return sp;
        const L = which === 0 ? lines[0] : lines[lines.length - 1];
        const p = which === 0 ? L.s.start : L.s.end;
        // terminate a little past the point, fanned out in its own lane
        let at = alongOf(L.s.co, p);
        if (Routing.isPinKey(key)) {
          const other = which === 0 ? L.s.end : L.s.start;
          at += Math.sign(at - alongOf(L.s.co, other)) * TERM * 0.35;
        }
        return L.s.co.ax === "h" ? { x: at, y: L.coord } : { x: L.coord, y: at };
      };

      pts.push(endPoint(0));
      for (let i = 0; i < lines.length - 1; i++) {
        const A = lines[i], B = lines[i + 1];
        if (A.s.co.ax === B.s.co.ax) {
          // same orientation, different line: a short square jog at the joint
          const at = alongOf(A.s.co, A.s.end);
          if (A.s.co.ax === "h") { pts.push({ x: at, y: A.coord }, { x: at, y: B.coord }); }
          else { pts.push({ x: A.coord, y: at }, { x: B.coord, y: at }); }
        } else {
          // true right angle: the corner is where the two lanes cross
          pts.push(A.s.co.ax === "h" ? { x: B.coord, y: A.coord } : { x: A.coord, y: B.coord });
        }
      }
      pts.push(endPoint(1));
      return pts.filter((p, i, arr) => i === 0 || Math.abs(p.x - arr[i - 1].x) > 0.01 || Math.abs(p.y - arr[i - 1].y) > 0.01);
    });

    return { info, sk, paths, laneOf, polys, spliceAt };
  }

  // lane index of a signal on one corridor (any of its wires will do — a
  // signal shares one lane per corridor)
  function laneIdx(co, sig, info, laneOf) {
    for (const w of info.wires) {
      if (w.sig.id !== sig.id) continue;
      const l = laneOf.get(`${co.id}|${w.idx}`);
      if (l != null) return l;
    }
    return 0;
  }

  /* ---------- rendering ---------- */

  function init() {
    svg = document.getElementById("wdCanvas");
    sidebar = document.getElementById("wdSidebar");
    if (!svg) return;
    svg.addEventListener("pointerdown", onDown);
    svg.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    const fit = document.getElementById("wdFit");
    if (fit) fit.addEventListener("click", () => fitView());
    for (const b of document.querySelectorAll("#wdModeButtons button")) {
      b.addEventListener("click", () => setMode(b.dataset.wdmode));
    }
    const reset = document.getElementById("wdReset");
    if (reset) reset.addEventListener("click", resetPlacement);
    updateHint();
  }

  function setMode(m) {
    mode = m;
    document.querySelectorAll("#wdModeButtons button")
      .forEach((b) => b.classList.toggle("active", b.dataset.wdmode === m));
    updateHint();
  }

  function updateHint() {
    const hint = document.getElementById("wdHint");
    if (hint) hint.textContent = HINTS[mode] || "";
  }

  function escape() { setMode("select"); sel = null; renderAll(); }

  function resetPlacement() {
    const h = Main.currentHarness();
    if (!h) return;
    UI.confirmBox("Put all connector blocks and splice tags back to their default positions?", () => {
      h.labelOffsets = {};
      h.blockOffsets = {};
      Model.changed();
    });
  }

  function onDown(e) {
    e.preventDefault();
    if (!(e.target.dataset && e.target.dataset.bg)) return;
    if (mode === "splice") {
      // clicked near, but not on, a leg — find the closest one
      const w = worldPos(e);
      const h = Main.currentHarness();
      let best = null;
      for (const seg of h.segments) {
        const near = nearestOnSeg(h, seg, w);
        if (near && (!best || near.dist < best.near.dist)) best = { seg, near };
      }
      if (best && best.near.dist < 34) spliceOnLeg(h, best.seg, best.near.t);
      return;
    }
    sel = null;
    drag = { kind: "pan", x: e.clientX, y: e.clientY, panX, panY };
    renderSidebar();
    render();
  }

  function nearestOnSeg(h, seg, p) {
    const pts = segPolyline(h, seg);
    if (!pts) return null;
    let best = null, acc = 0;
    const total = pts.slice(1).reduce((a, q, i) => a + Math.hypot(q.x - pts[i].x, q.y - pts[i].y), 0) || 1;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      const L2 = dx * dx + dy * dy || 1;
      let k = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
      const x = a.x + dx * k, y = a.y + dy * k;
      const dist = Math.hypot(p.x - x, p.y - y);
      const L = Math.sqrt(L2);
      if (!best || dist < best.dist) best = { dist, t: (acc + L * k) / total };
      acc += L;
    }
    return best;
  }

  function spliceOnLeg(h, seg, t) {
    SpliceEdit.chooser(h, { segId: seg.id, t }, "Splice signals along this leg", (key) => {
      sel = { type: "splice", id: key };
      setMode("select");
    });
  }

  function spliceOnNode(h, node) {
    SpliceEdit.chooser(h, {
      nodeId: node.id,
      rec: Model.splicesOf(h).find((s) => s.nodeId === node.id) || null,
    }, `Splice signals at ${Routing.nodeName(h, node.id, true)}`, (key) => {
      sel = { type: "splice", id: key };
      setMode("select");
    });
  }

  const snap10 = (v) => Math.round(v / 10) * 10;

  function onMove(e) {
    if (!drag) return;
    document.body.classList.add("dragging");
    const w = drag.kind === "pan" ? null : worldPos(e);
    if (drag.kind === "pan") {
      panX = drag.panX + (e.clientX - drag.x);
      panY = drag.panY + (e.clientY - drag.y);
      applyTransform();
      return;
    }
    if (drag.kind === "label") {
      Model.labelOffsets(drag.h)[drag.key] = {
        dx: Math.round(w.x - drag.baseX), dy: Math.round(w.y - drag.baseY),
      };
    } else if (drag.kind === "block") {
      Model.blockOffsets(drag.h)[drag.id] = {
        dx: Math.round(w.x - drag.baseX), dy: Math.round(w.y - drag.baseY),
      };
    } else if (drag.kind === "node") {
      // same edit as the Layout tab — this really moves the harness point
      const n = nodeById(drag.h, drag.id);
      if (!n) return;
      n.x = snap10(w.x - drag.grabX);
      n.y = snap10(w.y - drag.grabY);
    } else if (drag.kind === "bend") {
      const seg = drag.h.segments.find((s) => s.id === drag.segId);
      if (!seg || !seg.bends || !seg.bends[drag.idx]) return;
      seg.bends[drag.idx] = { x: snap10(w.x), y: snap10(w.y) };
    } else return;
    drag.moved = true;
    render();
  }

  function onUp() {
    document.body.classList.remove("dragging");
    if (drag && drag.snap && drag.moved) Model.commitFrom(drag.snap);
    drag = null;
  }

  function onWheel(e) {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const dir = Model.getPrefs().invertZoom ? -1 : 1;
    const f = e.deltaY * dir < 0 ? 1.12 : 1 / 1.12;
    const ns = Math.min(4, Math.max(0.1, scale * f));
    panX = mx - ((mx - panX) / scale) * ns;
    panY = my - ((my - panY) / scale) * ns;
    scale = ns;
    applyTransform();
  }

  function worldPos(e) {
    const r = svg.getBoundingClientRect();
    return { x: (e.clientX - r.left - panX) / scale, y: (e.clientY - r.top - panY) / scale };
  }

  function applyTransform() {
    const g = svg.querySelector("#wdWorld");
    if (g) g.setAttribute("transform", `translate(${panX} ${panY}) scale(${scale})`);
  }

  function drawWirePath(parent, pts, sig, width, opacity, title) {
    if (pts.length < 2) return;
    const d = pts.map((p, i) => `${i ? "L" : "M"} ${Math.round(p.x * 10) / 10} ${Math.round(p.y * 10) / 10}`).join(" ");
    const g = svgEl("g", opacity != null ? { opacity } : {});
    g.dataset.sig = sig.name;
    if (title) g.appendChild(svgEl("title", {}, title));
    g.appendChild(svgEl("path", {
      d, fill: "none", stroke: UI.inkFor(sig.color.base),
      "stroke-width": width, "stroke-linejoin": "round", "stroke-linecap": "round",
    }));
    if (sig.color.style === "striped") {
      g.appendChild(svgEl("path", {
        d, fill: "none", stroke: UI.inkFor(sig.color.stripe),
        "stroke-width": width, "stroke-dasharray": "7 7", "stroke-linejoin": "round",
      }));
    }
    parent.appendChild(g);
    return g;
  }

  function render() {
    if (!svg) return;
    const h = Main.currentHarness();
    svg.innerHTML = "";
    const bg = svgEl("rect", { x: 0, y: 0, width: "100%", height: "100%", fill: "transparent" });
    bg.dataset.bg = "1";
    svg.appendChild(bg);
    const world = svgEl("g", { id: "wdWorld" });
    svg.appendChild(world);
    if (!h) return;

    const geo = buildGeometry(h);
    cache = { h, geo };

    /* corridor guides, so the harness shape is still readable underneath */
    for (const co of Object.values(geo.sk.corridors)) {
      if (!co.count) continue;
      const lo = Math.min(...co.runs.map((r) => Math.min(alongOf(co, r.a), alongOf(co, r.b))));
      const hi = Math.max(...co.runs.map((r) => Math.max(alongOf(co, r.a), alongOf(co, r.b))));
      const halfW = ((co.count - 1) / 2) * LANE + 7;
      world.appendChild(svgEl("rect", {
        x: co.ax === "h" ? lo : co.fixed - halfW,
        y: co.ax === "h" ? co.fixed - halfW : lo,
        width: co.ax === "h" ? hi - lo : halfW * 2,
        height: co.ax === "h" ? halfW * 2 : hi - lo,
        rx: 5, class: "wd-corridor",
      }));
    }

    /* wires — dimmed ones first so a highlighted signal reads on top */
    const order = geo.info.wires.map((_, i) => i).sort((a, b) => {
      const la = highlightSig && geo.info.wires[a].sig.id === highlightSig ? 1 : 0;
      const lb = highlightSig && geo.info.wires[b].sig.id === highlightSig ? 1 : 0;
      return la - lb;
    });
    for (const i of order) {
      const w = geo.info.wires[i];
      const lit = !highlightSig || w.sig.id === highlightSig;
      const from = Routing.endInfo(h, w.fromKey, w.sig), to = Routing.endInfo(h, w.toKey, w.sig);
      drawWirePath(world, geo.polys[i], w.sig, lit && highlightSig ? 3.4 : 2.4, lit ? null : 0.08,
        `${w.sig.name}\n${from.name} ${from.pin} → ${to.name} ${to.pin}`);
    }

    /* connector blocks */
    for (const conn of h.connectors) drawConnector(world, h, conn, geo);

    /* splice zones, dots + labels */
    for (const point of geo.info.points) drawSplice(world, h, point, geo);

    /* draggable handles for the harness points and bends themselves */
    for (const node of h.nodes) {
      const isSel = sel && sel.type === "node" && sel.id === node.id;
      const c = svgEl("circle", {
        cx: node.x, cy: node.y, r: isSel ? 6.5 : 5,
        class: "wd-node" + (isSel ? " selected" : ""),
      }, svgEl("title", {}, `${Routing.nodeName(h, node.id, true)} — drag to move, or use the Splice tool here`));
      c.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (mode === "splice") { spliceOnNode(h, node); return; }
        sel = { type: "node", id: node.id };
        const w = worldPos(e);
        drag = { kind: "node", id: node.id, h, grabX: w.x - node.x, grabY: w.y - node.y, snap: Model.snapshot(), moved: false };
        render();
        renderSidebar();
      });
      world.appendChild(c);
    }
    for (const seg of h.segments) {
      (seg.bends || []).forEach((b, idx) => {
        const r = svgEl("rect", { x: b.x - 4, y: b.y - 4, width: 8, height: 8, class: "bend-handle" },
          svgEl("title", {}, "Bend — drag to move"));
        r.addEventListener("pointerdown", (e) => {
          e.stopPropagation();
          e.preventDefault();
          drag = { kind: "bend", segId: seg.id, idx, h, snap: Model.snapshot(), moved: false };
        });
        world.appendChild(r);
      });
    }

    if (!inited && svg.clientWidth) { inited = true; fitView(); }
    applyTransform();
  }

  function drawConnector(world, h, conn, geo) {
    const node = nodeById(h, conn.nodeId);
    if (!node) return;
    const spec = Model.connSpec(conn);
    const pins = Model.assignedPins(conn);
    const hlSig = highlightSig ? Model.signal(highlightSig) : null;
    const carries = !!hlSig && pins.some((p) => conn.pins[p].signalId === hlSig.id);
    const g = svgEl("g", hlSig && !carries ? { opacity: 0.3 } : {});

    /* Put the block out beyond the fan of wire ends, square-on and pointing
     * away from the harness, so it never lands on top of the runs. */
    let dx = 0, dy = 0;
    for (const s of h.segments) {
      if (s.a !== node.id && s.b !== node.id) continue;
      const o = nodeById(h, s.a === node.id ? s.b : s.a);
      if (!o) continue;
      const vx = o.x - node.x, vy = o.y - node.y;
      const L = Math.hypot(vx, vy) || 1;
      dx -= vx / L; dy -= vy / L;
    }
    if (Math.hypot(dx, dy) < 0.01) { dx = 1; dy = 0; }
    if (Math.abs(dx) >= Math.abs(dy)) { dx = Math.sign(dx) || 1; dy = 0; } else { dy = Math.sign(dy) || 1; dx = 0; }

    const others = h.connectors.filter((c) => c.nodeId === conn.nodeId);
    const slot = others.indexOf(conn);
    const label = conn.label || spec.name;
    const boxW = Math.max(96, label.length * 6.6 + 20);
    const boxH = 40;
    const fan = (geo.sk.corridors[nodeCorridor(geo, node)] || {}).count || 1;
    const clear = 46 + ((fan - 1) / 2) * LANE;
    const step = (dx !== 0 ? boxH + 10 : boxW + 14);
    const px = dx !== 0 ? 0 : 1, py = dx !== 0 ? 1 : 0;
    const slide = (slot - (others.length - 1) / 2) * step;
    const off = Model.blockOffsets(h)[conn.id];
    const cxB = off ? node.x + off.dx : node.x + dx * (clear + boxW / 2) + px * slide;
    const cyB = off ? node.y + off.dy : node.y + dy * (clear + boxH / 2) + py * slide;
    const bx = cxB - boxW / 2, by = cyB - boxH / 2;

    // tether meets the nearest edge of the block, wherever it has been dragged
    const ex = Math.max(bx, Math.min(node.x, bx + boxW));
    const ey = Math.max(by, Math.min(node.y, by + boxH));
    g.appendChild(svgEl("line", { x1: node.x, y1: node.y, x2: ex, y2: ey, class: "wd-tether" }));

    const isSel = sel && sel.type === "conn" && sel.id === conn.id;
    const rect = svgEl("rect", {
      x: bx, y: by, width: boxW, height: boxH, rx: 6,
      class: "wd-conn" + (isSel ? " selected" : ""),
    }, svgEl("title", {}, `${conn.label} — click for its wires, drag to move, double-click to edit the pinout`));
    rect.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      sel = { type: "conn", id: conn.id };
      const w = worldPos(e);
      drag = { kind: "block", id: conn.id, h, baseX: w.x - (cxB - node.x), baseY: w.y - (cyB - node.y), snap: Model.snapshot(), moved: false };
      render();
      renderSidebar();
    });
    rect.addEventListener("dblclick", () => PinoutView.open(conn.id));
    g.appendChild(rect);
    g.appendChild(svgEl("text", { x: bx + 8, y: by + 15, class: "conn-label" }, label));
    g.appendChild(svgEl("text", { x: bx + 8, y: by + 28, class: "conn-sub" }, `${spec.name} · ${pins.length}/${spec.pinCount}`));

    // colour chips, in pin order
    const chipW = 8, gap = 2.5;
    const avail = boxW - 16;
    let list = pins;
    const slots = Math.max(1, Math.floor((avail + gap) / (chipW + gap)));
    if (pins.length > slots) list = pins.slice(0, Math.max(1, slots - 1));
    const chipH = 6, chipY = by + boxH - 10;
    list.forEach((p, i) => {
      const sig = Model.signal(conn.pins[p].signalId);
      if (!sig) return;
      const isHl = hlSig && sig.id === hlSig.id;
      const cx = bx + 8 + i * (chipW + gap);
      g.appendChild(svgEl("rect", {
        x: cx, y: chipY, width: chipW, height: chipH, rx: 2,
        fill: sig.color.base, stroke: isHl ? "var(--text)" : "var(--chip-edge)", "stroke-width": isHl ? 1.6 : 1,
      }, svgEl("title", {}, `Pin ${Model.pinLabel(spec, p)}: ${sig.name} (${UI.colorLabel(sig.color)})`)));
      // striped wire gets its tracer on the chip too, same as the Layout tab
      if (sig.color.style === "striped") {
        g.appendChild(svgEl("rect", {
          x: cx + 1, y: chipY + chipH - 3, width: chipW - 2, height: 2.2, rx: 1,
          fill: sig.color.stripe, "pointer-events": "none",
        }));
      }
    });
    world.appendChild(g);
  }

  // the busiest corridor touching a node, used to clear its wire fan
  function nodeCorridor(geo, node) {
    let best = -1, bestN = -1;
    for (const r of geo.sk.runs) {
      if ((r.a.x !== node.x || r.a.y !== node.y) && (r.b.x !== node.x || r.b.y !== node.y)) continue;
      const co = geo.sk.corridors[r.corridor];
      if (co && (co.count || 0) > bestN) { bestN = co.count || 0; best = r.corridor; }
    }
    return best;
  }

  function drawSplice(world, h, point, geo) {
    const spots = geo.spliceAt[point.key];
    if (!spots) return;
    const sigs = point.signals.map((s) => s.sig);
    const allAuto = point.signals.every((s) => s.auto);
    const lit = !highlightSig || sigs.some((s) => s.id === highlightSig);
    const g = svgEl("g", lit ? {} : { opacity: 0.15 });

    /* the zone: one outline round all of this splice point's dots, so it
     * reads as a single joint carrying one S number */
    const pts = sigs.map((s) => spots[s.id]).filter(Boolean);
    if (!pts.length) return;
    const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
    const pad = DOT_R + 7;
    g.appendChild(svgEl("rect", {
      x: minX - pad, y: minY - pad,
      width: (maxX - minX) + pad * 2, height: (maxY - minY) + pad * 2,
      rx: Math.min(14, pad + (maxX - minX) / 2, pad + (maxY - minY) / 2),
      class: "splice-zone" + (sel && sel.type === "splice" && sel.id === point.key ? " selected" : ""),
    }));

    let cx = 0, cy = 0;
    for (const sig of sigs) {
      const p = spots[sig.id];
      if (!p) continue;
      cx += p.x; cy += p.y;
      g.appendChild(svgEl("circle", {
        cx: p.x, cy: p.y, r: DOT_R, fill: UI.inkFor(sig.color.base), class: "splice-junction",
        opacity: highlightSig && sig.id !== highlightSig ? 0.3 : null,
      }, svgEl("title", {}, `${point.tag} · ${sig.name}`)));
    }
    cx /= pts.length; cy /= pts.length;

    // stagger the default tag positions so neighbouring splices don't collide
    const tagNo = parseInt(point.tag.slice(1), 10) || 0;
    const off = Model.labelOffsets(h)[point.key] || { dx: 24, dy: -26 - (tagNo % 3) * 15 };
    const lx = cx + off.dx, ly = cy + off.dy;
    const fw = 9 + point.tag.length * 6.6;
    const selected = sel && sel.type === "splice" && sel.id === point.key;
    const flag = svgEl("g", { class: "wd-flag" + (selected ? " selected" : "") });
    flag.appendChild(svgEl("line", { x1: cx, y1: cy, x2: lx + fw / 2, y2: ly + 8, class: "splice-stem" }));
    flag.appendChild(svgEl("rect", {
      x: lx, y: ly, width: fw, height: 16, rx: 3,
      class: "splice-flag" + (allAuto ? " auto" : "") + (selected ? " selected" : ""),
    }));
    flag.appendChild(svgEl("text", {
      x: lx + fw / 2, y: ly + 12, class: "splice-flag-text" + (allAuto ? " auto" : ""),
    }, point.tag));
    flag.appendChild(svgEl("title", {}, `${point.tag} — drag to move the label\n${sigs.map((s) => s.name).join(", ")}`));
    flag.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      sel = { type: "splice", id: point.key };
      if (mode === "splice") { setMode("select"); }
      drag = { kind: "label", key: point.key, h, snap: Model.snapshot(), moved: false, baseX: cx, baseY: cy };
      const cur = Model.labelOffsets(h)[point.key];
      if (!cur) Model.labelOffsets(h)[point.key] = { dx: off.dx, dy: off.dy };
      renderSidebar();
      render();
    });
    g.appendChild(flag);
    world.appendChild(g);
  }

  function fitView() {
    const h = Main.currentHarness();
    if (!h || !h.nodes.length || !svg.clientWidth) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const c = (x, y) => {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    };
    h.nodes.forEach((n) => c(n.x, n.y));
    // connector blocks sit out beyond the points, so allow for them all round
    h.connectors.forEach((cn) => {
      const n = nodeById(h, cn.nodeId);
      if (!n) return;
      c(n.x - 230, n.y - 150);
      c(n.x + 230, n.y + 150);
    });
    const pad = 90;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    scale = Math.min(2, svg.clientWidth / (maxX - minX), svg.clientHeight / (maxY - minY));
    panX = (svg.clientWidth - (maxX - minX) * scale) / 2 - minX * scale;
    panY = (svg.clientHeight - (maxY - minY) * scale) / 2 - minY * scale;
    applyTransform();
  }

  let cache = null;

  /* ---------- sidebar ---------- */

  function renderSidebar() {
    if (!sidebar) return;
    const top = sidebar.scrollTop;
    sidebar.innerHTML = "";
    const h = Main.currentHarness();
    if (!h) return;

    if (sel && sel.type === "splice" && cache && cache.geo) {
      const point = cache.geo.info.points.find((p) => p.key === sel.id);
      if (point) {
        SpliceEdit.panel(sidebar, h, point, { onDeleted: () => { sel = null; } });
        sidebar.appendChild(el("button", {
          class: "icon-btn", style: { marginTop: "6px" },
          onclick: () => { delete Model.labelOffsets(h)[sel.id]; Model.changed(); },
        }, "Reset tag position"));
      }
    } else if (sel && sel.type === "conn") {
      const conn = h.connectors.find((c) => c.id === sel.id);
      if (conn) connectorPanel(h, conn);
    } else if (sel && sel.type === "node") {
      const node = nodeById(h, sel.id);
      if (node) {
        sidebar.appendChild(el("h3", {}, "Harness point"));
        sidebar.appendChild(el("div", { class: "muted small" }, Routing.nodeName(h, node.id, true)));
        sidebar.appendChild(el("div", { class: "hint-box" },
          "Drag it to pull the point clear of the bundle — this moves the real harness point, so the Layout tab follows. ",
          "Use the Splice tool and click it to choose what splices here."));
        sidebar.appendChild(el("button", {
          onclick: () => spliceOnNode(h, node),
        }, "🔀 Splice signals here"));
      }
    }

    sidebar.appendChild(el("h4", {}, "Highlight a signal"));
    const sigs = Model.get().signals
      .map((s) => ({ sig: s, n: new Set(Model.signalUses(s.id).filter((u) => u.harness.id === h.id).map((u) => u.conn.id)).size }))
      .filter((r) => r.n);
    if (highlightSig) {
      sidebar.appendChild(el("button", {
        class: "icon-btn", style: { marginBottom: "6px" },
        onclick: () => { highlightSig = null; render(); renderSidebar(); },
      }, "✕ Clear highlight"));
    }
    const box = el("div", {});
    const fill = (q) => {
      box.innerHTML = "";
      const qq = (q || "").trim().toLowerCase();
      for (const { sig, n } of sigs) {
        if (qq && !(sig.name + " " + (sig.type || "")).toLowerCase().includes(qq)) continue;
        box.appendChild(el("div", {
          class: "sig-row" + (highlightSig === sig.id ? " active" : ""),
          onclick: () => { highlightSig = highlightSig === sig.id ? null : sig.id; render(); renderSidebar(); },
        }, UI.swatch(sig.color), el("span", { class: "name" }, sig.name), el("span", { class: "uses" }, `${n} conn`)));
      }
    };
    if (sigs.length > 8) {
      sidebar.appendChild(el("input", {
        placeholder: "Filter signals…", style: { width: "100%", marginBottom: "6px" },
        oninput: (e) => fill(e.target.value),
      }));
    }
    fill("");
    sidebar.appendChild(box);
    sidebar.scrollTop = top;
  }

  /* Same connector detail as the Layout tab: every pin with its signal,
   * colour and gauge, and a click to highlight where that wire runs. */
  function connectorPanel(h, conn) {
    const spec = Model.connSpec(conn);
    sidebar.appendChild(el("h3", {}, "Connector"));
    sidebar.appendChild(el("div", { class: "side-row" },
      el("label", {}, "Label"),
      el("input", {
        value: conn.label, style: { flex: 1 },
        onchange: (e) => { conn.label = e.target.value.trim() || conn.label; Model.changed(); },
      })));
    sidebar.appendChild(el("div", { class: "muted small" },
      `${spec.name} — ${Model.assignedPins(conn).length}/${spec.pinCount} pins assigned`));

    const mate = Model.mateFor(conn.id);
    if (mate) {
      const st = Model.mateStatus(mate);
      const other = Model.findConnector(mate.a === conn.id ? mate.b : mate.a);
      sidebar.appendChild(el("div", { class: st.ok ? "hint-box" : "warn-box" },
        st.ok ? "✓ Mated to " : "⚠ Pinout mismatch with ",
        other ? `"${other.conn.label}" (${other.harness.name})` : "(deleted connector)"));
    }

    sidebar.appendChild(el("h4", {}, "Wires at this connector"));
    const list = el("div", { class: "pin-list" });
    for (let p = 1; p <= spec.pinCount; p++) {
      const pa = conn.pins && conn.pins[p];
      const sig = pa && pa.signalId ? Model.signal(pa.signalId) : null;
      list.appendChild(el("div", {
        class: "pin-line" + (sig ? "" : " empty") + (sig && highlightSig === sig.id ? " hl" : ""),
        title: sig ? `Click to highlight "${sig.name}"` : "Unassigned pin",
        onclick: sig ? () => {
          highlightSig = highlightSig === sig.id ? null : sig.id;
          renderAll();
        } : null,
      },
        el("span", { class: "pin-no" }, Model.pinLabel(spec, p)),
        sig ? UI.swatch(sig.color) : el("span", { class: "swatch empty-swatch" }),
        el("span", { class: "pin-sig" + (sig ? "" : " muted") }, sig ? sig.name : "—"),
        sig && sig.gauge ? el("span", { class: "muted small" }, sig.gauge) : null));
    }
    sidebar.appendChild(list);
    sidebar.appendChild(el("div", { class: "side-row" },
      el("button", { class: "primary", onclick: () => PinoutView.open(conn.id) }, "Edit pinout"),
      el("button", {
        class: "icon-btn",
        onclick: () => { delete Model.blockOffsets(h)[conn.id]; Model.changed(); },
      }, "Reset position")));
    sidebar.appendChild(el("div", { class: "hint-box" },
      "Drag the block to move it clear of the wires. To move the harness point it hangs off, drag the point itself."));
  }

  function renderAll() { render(); renderSidebar(); }

  function onHarnessSwitched() { sel = null; highlightSig = null; inited = false; renderAll(); }

  return { init, render: renderAll, fit: fitView, setMode, escape, onHarnessSwitched };
})();
