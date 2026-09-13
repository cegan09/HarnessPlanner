"use strict";
/*
 * Shared harness routing: works out the individual physical wires implied by
 * the signal assignments, where they splice, and how long they are. Used by
 * both the Layout canvas (to draw them) and the Build Sheet (to list them),
 * so the drawing and the cut list can never disagree.
 *
 * MODEL
 * Every pin carrying a signal is a terminal. For each signal we take the
 * smallest sub-network of the harness connecting its terminals, then place a
 * splice at every point where that sub-network branches — because that is
 * physically what has to happen. A wire is then one hop between two adjacent
 * "special" points (a pin or a splice), so each leg carries exactly ONE wire
 * per signal instead of one per endpoint pair.
 *
 * Splices come from three places:
 *   - automatic, at any junction where the signal's destinations diverge
 *   - automatic, where two or more pins of the signal share one point
 *   - explicit, placed by the user at a junction or along a leg
 * and can be individually suppressed ("route through here as separate wires")
 * via a splice record's `exclude` list.
 *
 * Node keys used internally:
 *   "<nodeId>"                real harness point
 *   "pin:<connId>:<pin>"      one terminal (pin) — attached by a zero-length
 *                             tail whose length is the connector's lead
 *   "sp:<spliceId>"           an explicit splice sitting part-way along a leg
 */
const Routing = (() => {

  const pinKey = (connId, pin) => `pin:${connId}:${pin}`;
  const spKey = (spliceId) => `sp:${spliceId}`;
  const isPinKey = (k) => k.startsWith("pin:");
  const isSpKey = (k) => k.startsWith("sp:");

  /* ---------- base graph ---------- */

  function baseAdj(h) {
    const adj = {};
    h.nodes.forEach((n) => { adj[n.id] = []; });
    h.segments.forEach((s) => {
      if (adj[s.a] && adj[s.b]) {
        adj[s.a].push({ to: s.b, segId: s.id });
        adj[s.b].push({ to: s.a, segId: s.id });
      }
    });
    return adj;
  }

  function bfsTree(adj, src) {
    const prev = {}, prevSeg = {}, dist = { [src]: 0 };
    const q = [src];
    while (q.length) {
      const u = q.shift();
      for (const e of adj[u] || []) {
        if (dist[e.to] != null) continue;
        dist[e.to] = dist[u] + 1;
        prev[e.to] = u;
        prevSeg[e.to] = e.segId;
        q.push(e.to);
      }
    }
    return { prev, prevSeg, dist };
  }

  /* ---------- per-signal wire decomposition ---------- */

  function signalTerminals(h, sig) {
    const out = [];
    for (const c of h.connectors) {
      for (const [pin, pa] of Object.entries(c.pins || {})) {
        if (pa && pa.signalId === sig.id) out.push({ conn: c, pin: Number(pin) });
      }
    }
    return out;
  }

  // Segments making up the smallest sub-network linking every terminal.
  function steinerSegments(h, adj, nodeIds) {
    const segs = new Set();
    if (nodeIds.length < 2) return segs;
    const root = nodeIds[0];
    const { prev, prevSeg, dist } = bfsTree(adj, root);
    for (const n of nodeIds.slice(1)) {
      if (dist[n] == null) continue;          // unreachable — different island
      let u = n, guard = 0;
      while (u !== root && prev[u] != null && guard++ < 5000) {
        segs.add(prevSeg[u]);
        u = prev[u];
      }
    }
    return segs;
  }

  function buildSignalGraph(h, sig, terminals, splices) {
    const adj = baseAdj(h);
    const nodeIds = [...new Set(terminals.map((t) => t.conn.nodeId))].filter((id) => adj[id]);
    const segIds = steinerSegments(h, adj, nodeIds);

    const aug = {};
    const add = (a, b, edge) => {
      (aug[a] = aug[a] || []).push({ to: b, ...edge });
      (aug[b] = aug[b] || []).push({ to: a, ...edge, t0: edge.t1, t1: edge.t0 });
    };

    // legs, split by any explicit part-way splices that apply to this signal
    const midSplices = splices.filter((sp) => sp.segId && !sp.nodeId && (sp.signalIds || []).includes(sig.id));
    for (const segId of segIds) {
      const seg = h.segments.find((s) => s.id === segId);
      if (!seg) continue;
      const onThis = midSplices.filter((sp) => sp.segId === segId).sort((a, b) => a.t - b.t);
      let cursorKey = seg.a, cursorT = 0;
      for (const sp of onThis) {
        add(cursorKey, spKey(sp.id), { segId, t0: cursorT, t1: sp.t });
        cursorKey = spKey(sp.id);
        cursorT = sp.t;
      }
      add(cursorKey, seg.b, { segId, t0: cursorT, t1: 1 });
    }

    // pin tails
    for (const t of terminals) {
      const k = pinKey(t.conn.id, t.pin);
      if (!aug[t.conn.nodeId] && !nodeIds.includes(t.conn.nodeId)) continue;
      add(t.conn.nodeId, k, { segId: null, lead: Number(t.conn.lead) || 0, connId: t.conn.id, pin: t.pin });
    }

    return { aug, segIds };
  }

  function specialSet(h, sig, aug, splices) {
    const nodeSplices = splices.filter((sp) => sp.nodeId && (sp.signalIds || []).includes(sig.id));
    const excluded = new Set(
      splices.filter((sp) => (sp.exclude || []).includes(sig.id))
        .map((sp) => (sp.nodeId ? sp.nodeId : spKey(sp.id))));

    const special = new Set();
    const autoAt = new Set();
    for (const key of Object.keys(aug)) {
      if (isPinKey(key)) { special.add(key); continue; }     // terminals always end a wire
      if (isSpKey(key)) { special.add(key); continue; }      // explicit part-way splice
      const deg = aug[key].length;
      if (nodeSplices.some((sp) => sp.nodeId === key)) { special.add(key); continue; }
      if (deg >= 3 && !excluded.has(key)) { special.add(key); autoAt.add(key); }
    }
    return { special, autoAt, excluded };
  }

  // Wires = maximal hops between adjacent special points.
  function decompose(aug, special, root) {
    const parent = {}, parentEdge = {}, seen = { [root]: true };
    const stack = [root];
    while (stack.length) {
      const u = stack.pop();
      for (const e of aug[u] || []) {
        if (seen[e.to]) continue;
        seen[e.to] = true;
        parent[e.to] = u;
        parentEdge[e.to] = e;
        stack.push(e.to);
      }
    }
    const wires = [];
    for (const x of Object.keys(seen)) {
      if (x === root || !special.has(x)) continue;
      const steps = [];
      let u = x, guard = 0;
      while (guard++ < 10000) {
        const e = parentEdge[u];
        if (!e) break;
        // travelling from u up to its parent means reversing the stored edge
        steps.push({ segId: e.segId, t0: e.t1, t1: e.t0, lead: e.lead, connId: e.connId, pin: e.pin });
        u = parent[u];
        if (special.has(u)) break;
      }
      if (steps.length) wires.push({ fromKey: x, toKey: u, steps });
    }
    return wires;
  }

  /* ---------- public: every wire in a harness ---------- */

  function computeRuns(h) {
    const splices = Model.splicesOf(h);
    const wires = [];
    const singles = [];
    const warnings = [];
    const points = {};   // key -> {key, kind, nodeId|splice, segId, t, signals:[{sig, auto}]}
    const reach = {};    // signal id -> Set of node ids the signal runs through

    const notePoint = (key, info, sig, auto) => {
      const p = points[key] || (points[key] = { key, signals: [], ...info });
      if (!p.signals.some((s) => s.sig.id === sig.id)) p.signals.push({ sig, auto });
    };

    for (const sig of Model.get().signals) {
      const terminals = signalTerminals(h, sig);
      if (!terminals.length) continue;
      if (terminals.length === 1) { singles.push({ sig, use: terminals[0] }); continue; }

      const { aug, segIds } = buildSignalGraph(h, sig, terminals, splices);
      const { special, autoAt } = specialSet(h, sig, aug, splices);
      reach[sig.id] = new Set(Object.keys(aug).filter((k) => !isPinKey(k) && !isSpKey(k)));

      // root the walk at an explicit splice when there is one, else a terminal
      const keys = Object.keys(aug);
      const explicitRoot = keys.find((k) => isSpKey(k) && special.has(k))
        || keys.find((k) => !isPinKey(k) && !isSpKey(k) && special.has(k) && !autoAt.has(k));
      const root = explicitRoot || pinKey(terminals[0].conn.id, terminals[0].pin);
      if (!aug[root]) continue;

      for (const w of decompose(aug, special, root)) {
        wires.push({ sig, ...w });
      }

      // record splice points for the UI
      for (const key of special) {
        if (isPinKey(key)) continue;
        if (isSpKey(key)) {
          const sp = splices.find((s) => spKey(s.id) === key);
          if (sp) notePoint(key, { kind: "mid", splice: sp, segId: sp.segId, t: sp.t }, sig, false);
        } else {
          const sp = splices.find((s) => s.nodeId === key && (s.signalIds || []).includes(sig.id));
          notePoint(key, { kind: "node", nodeId: key, splice: sp || null }, sig, !sp);
        }
      }

      // explicit splices that don't actually sit on this signal's path
      for (const sp of splices) {
        if (!(sp.signalIds || []).includes(sig.id)) continue;
        const onPath = sp.nodeId ? !!aug[sp.nodeId] : segIds.has(sp.segId);
        if (!onPath) warnings.push(`${spliceName(sp)}: ${sig.name} doesn't run through this point.`);
      }
    }

    // stable global ordering, so a wire keeps its lane the whole way along
    wires.forEach((w, i) => { w.idx = i; });
    wires.slice()
      .sort((a, b) => a.sig.name.localeCompare(b.sig.name) || a.idx - b.idx)
      .forEach((w, i) => { w.rank = i; });

    return { wires, runs: wires, points: Object.values(points), reach, splices, singles, warnings };
  }

  /* ---------- lengths ---------- */

  function runLength(h, wire) {
    let total = 0, incomplete = false;
    for (const st of wire.steps) {
      if (!st.segId) { total += st.lead || 0; continue; }
      const seg = h.segments.find((s) => s.id === st.segId);
      if (!seg || seg.length == null || seg.length === "") { incomplete = true; continue; }
      total += Math.abs(st.t1 - st.t0) * (Number(seg.length) || 0);
    }
    return { length: total, incomplete };
  }

  function splicePosition(h, sp) {
    if (!sp.segId) return null;
    const seg = h.segments.find((s) => s.id === sp.segId);
    if (!seg || seg.length == null || seg.length === "") return null;
    const L = Number(seg.length) || 0;
    return { seg, fromA: L * sp.t, fromB: L * (1 - sp.t), total: L };
  }

  /* ---------- naming ---------- */

  function spliceName(sp) {
    if (sp.label) return sp.label;
    const names = (sp.signalIds || []).map((id) => (Model.signal(id) || {}).name).filter(Boolean);
    if (!names.length) return "Splice";
    return (names.length === 1 ? names[0] : names[0] + ` +${names.length - 1}`) + " splice";
  }

  function nodeName(h, nodeId) {
    const cs = h.connectors.filter((c) => c.nodeId === nodeId);
    if (cs.length) return cs.map((c) => c.label).join(" / ");
    const deg = h.segments.filter((s) => s.a === nodeId || s.b === nodeId).length;
    return deg >= 2 ? "junction" : "open end";
  }

  function pointName(h, point) {
    if (point.kind === "mid") return spliceName(point.splice);
    if (point.splice) return spliceName(point.splice);
    return `splice @ ${nodeName(h, point.nodeId)}`;
  }

  // Describe one end of a wire for the build sheet / tooltips.
  function endInfo(h, key, sig) {
    if (isPinKey(key)) {
      const [, connId, pin] = key.split(":");
      const found = Model.findConnector(connId);
      if (!found) return { kind: "pin", name: "(deleted)", pin: "—" };
      return {
        kind: "pin", conn: found.conn, pinNo: Number(pin),
        name: found.conn.label,
        pin: Model.pinLabel(Model.connSpec(found.conn), Number(pin)),
      };
    }
    if (isSpKey(key)) {
      const sp = Model.splicesOf(h).find((s) => spKey(s.id) === key);
      return { kind: "splice", name: sp ? spliceName(sp) : "splice", pin: "—", splice: sp };
    }
    const sp = Model.splicesOf(h).find((s) => s.nodeId === key && (s.signalIds || []).includes(sig.id));
    return {
      kind: "splice",
      name: sp ? spliceName(sp) : `${sig.name} splice @ ${nodeName(h, key)}`,
      pin: "—", nodeId: key, auto: !sp,
    };
  }

  const endName = (h, end) => (end && end.name) || "?";
  const endPin = (end) => (end && end.pin) || "—";

  return {
    computeRuns, runLength, splicePosition, spliceName, nodeName, pointName,
    endInfo, endName, endPin, pinKey, spKey, isPinKey, isSpKey,
  };
})();
