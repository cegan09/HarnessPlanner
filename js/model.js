"use strict";
/*
 * Project data model + persistence + undo.
 *
 * project = {
 *   version, name, unit,
 *   library:   [{id, name, type, pinCount, rows, cols, numbering, imageData, notes}],
 *   signals:   [{id, name, gauge, color: {style:'solid'|'striped', base, stripe}}],
 *   harnesses: [{id, name,
 *                nodes:      [{id, x, y}],
 *                segments:   [{id, a, b, length}],          // a/b = node ids
 *                connectors: [{id, nodeId, libId|null, termType|null, label,
 *                              dx, dy,                       // manual placement offset (optional)
 *                              pins: { "1": {signalId}, ... } }]}],
 *   mates: [{id, a, b}]   // connector ids, assumed pin-1-to-pin-1 mating
 * }
 *
 * Signals act like ECAD nets: color lives on the signal, so every wire
 * carrying that signal automatically has the same color everywhere.
 */
const Model = (() => {
  const LS_KEY = "wiringTool.project.v1";   // crash-recovery copy only
  const PREFS_KEY = "wiringTool.prefs.v1";

  const TERMINAL_TYPES = [
    "Ring terminal", "Spade terminal", "Blade (male)", "Blade (female)",
    "Bullet (male)", "Bullet (female)", "Butt splice", "Bare / tinned wire", "Board pin",
  ];

  let project = null;
  let prefs = { invertZoom: false };
  let lastSnap = null;
  const undoStack = [];
  const redoStack = [];
  let saveTimer = null;
  const listeners = [];
  const statusListeners = [];

  const uid = (p) => p + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function newHarness(name) {
    return { id: uid("h"), name, nodes: [], segments: [], connectors: [], splices: [] };
  }

  /* splices: [{id, label, signalIds:[], exclude:[], segId?, t?, nodeId?}]
   * A splice point either sits part-way along a leg (segId + t) or at a
   * harness point (nodeId). `signalIds` are spliced here explicitly;
   * `exclude` suppresses the automatic splice that would otherwise happen
   * here, so those signals run through as separate wires instead. */
  const splicesOf = (h) => (h.splices = h.splices || []);

  // Older files stored one signal per splice as `signalId`.
  function migrate(p) {
    for (const h of p.harnesses || []) {
      for (const sp of splicesOf(h)) {
        if (sp.signalId && !sp.signalIds) sp.signalIds = [sp.signalId];
        delete sp.signalId;
        sp.signalIds = sp.signalIds || [];
        sp.exclude = sp.exclude || [];
      }
    }
    return p;
  }

  function blankProject() {
    return {
      version: 1,
      name: "My Wiring Project",
      unit: "in",
      library: [],
      signals: [],
      mates: [],
      harnesses: [newHarness("Harness 1")],
    };
  }

  /* ---------- persistence ---------- */

  /* The project file on disk is the master copy: every change is written back
   * to it a moment later. localStorage only keeps a recovery copy, for when
   * the browser can't reach the disk (no File System Access API, permission
   * not re-granted yet, or no file chosen yet) or the tab dies between saves.
   *
   * saveState is one of:
   *   "saved"     - on disk and up to date
   *   "saving"    - write in flight
   *   "nofile"    - no file chosen; only the browser recovery copy exists
   *   "reconnect" - a file is remembered but needs a click to re-grant access
   *   "error"     - the last write failed
   *   "download"  - no File System Access API here; saving means downloading
   */
  let fileHandle = null;
  let saveState = "nofile";
  let writing = false;
  let writeAgain = false;
  let recoveryText = null;   // the browser copy as found at launch

  function setState(state) {
    if (saveState === state) return;
    saveState = state;
    statusListeners.forEach((f) => f());
  }

  const status = () => ({
    state: saveState,
    fileName: fileHandle ? fileHandle.name : null,
  });

  const onStatus = (f) => statusListeners.push(f);

  const serialize = () => JSON.stringify(project, null, 2);

  function cacheLocally() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(project));
    } catch (e) {
      console.warn("Recovery copy failed (project may be too large for browser storage):", e);
    }
  }

  // Writes are serialised: a change made mid-write queues one more write.
  async function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    cacheLocally();
    if (!fileHandle) {
      setState(Storage.supported() ? "nofile" : "download");
      return false;
    }
    if (writing) { writeAgain = true; return false; }
    writing = true;
    setState("saving");
    let ok = false;
    try {
      await Storage.write(fileHandle, serialize());
      ok = true;
      setState("saved");
    } catch (e) {
      console.warn("Save to disk failed:", e);
      setState(e && e.name === "NotAllowedError" ? "reconnect" : "error");
    }
    writing = false;
    if (writeAgain) { writeAgain = false; return flush(); }
    return ok;
  }

  function scheduleSave() {
    if (saveState === "saved") setState("saving");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 600);
  }

  // Adopt a project without touching the file or the undo history.
  function adopt(p) {
    project = migrate(p);
    lastSnap = JSON.stringify(project);
    undoStack.length = 0;
    redoStack.length = 0;
  }

  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) { project = JSON.parse(raw); recoveryText = raw; }
    } catch (e) {
      console.warn("Could not load recovery copy:", e);
    }
    if (!project || !Array.isArray(project.harnesses) || !project.harnesses.length) {
      project = blankProject();
      recoveryText = null;
    }
    migrate(project);
    lastSnap = JSON.stringify(project);
    recoveryText = recoveryText && lastSnap;
    saveState = Storage.supported() ? "nofile" : "download";
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (raw) Object.assign(prefs, JSON.parse(raw));
    } catch (e) { /* preferences are optional */ }
  }

  /* Reopen the file used last time. Resolves to:
   *   "loaded"    - the file was read and is now the live project
   *   "differs"   - loaded, but the browser copy didn't match the file, so a
   *                 previous session may have died before its last save
   *   "reconnect" - remembered, but the user must click to re-grant access
   *   null        - nothing remembered (or this browser can't do files) */
  async function reopenLastFile() {
    if (!Storage.supported()) { setState("download"); return null; }
    const handle = await Storage.recallHandle();
    if (!handle) { setState("nofile"); return null; }
    fileHandle = handle;
    if (await Storage.permission(handle, false) !== "granted") {
      setState("reconnect");
      return "reconnect";
    }
    const before = recoveryText;
    if (!(await readFromFile())) return null;
    if (before && before !== JSON.stringify(project)) return "differs";
    recoveryText = null;
    return "loaded";
  }

  const recoveredCopy = () => (recoveryText ? JSON.parse(recoveryText) : null);

  // Pull the file's contents in as the live project. Assumes access is granted.
  async function readFromFile() {
    try {
      const p = JSON.parse(await Storage.read(fileHandle));
      if (!p || !Array.isArray(p.harnesses)) throw new Error("not a harness project");
      adopt(p);
      cacheLocally();
      setState("saved");
      notify();
      return true;
    } catch (e) {
      console.warn("Could not read project file:", e);
      setState("error");
      return false;
    }
  }

  // Call from a click: re-grants access to the remembered file and loads it.
  async function reconnectFile() {
    if (!(await grantAccess())) return false;
    return readFromFile();
  }

  // Re-requesting access only works inside a user gesture.
  async function grantAccess() {
    if (!fileHandle) return false;
    const ok = (await Storage.permission(fileHandle, true)) === "granted";
    if (!ok) setState("reconnect");
    return ok;
  }

  // Attach a file handle and make it the master copy from now on.
  async function useFile(handle, { read: readIt } = {}) {
    const prev = fileHandle, prevState = saveState;
    fileHandle = handle;
    if (readIt && !(await readFromFile())) {
      fileHandle = prev;
      setState(prevState);
      return false;
    }
    Storage.rememberHandle(handle);
    if (!readIt) await flush();
    return true;
  }

  const hasFile = () => !!fileHandle;

  function detachFile() {
    fileHandle = null;
    Storage.forgetHandle();
    setState(Storage.supported() ? "nofile" : "download");
  }

  /* ---------- preferences (UI-only, not part of the project file) ---------- */

  const getPrefs = () => prefs;

  function setPref(key, value) {
    prefs[key] = value;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch (e) { /* non-fatal */ }
    notify();
  }

  function notify() { listeners.forEach((f) => f()); }
  function onChange(f) { listeners.push(f); }

  /* ---------- undo / redo ---------- */

  // Call after mutating `project` directly.
  function changed() { commitFrom(lastSnap); }

  // For drag operations: capture snapshot() before the drag, mutate freely
  // during it, then commitFrom(snap) once on release.
  function snapshot() { return JSON.stringify(project); }

  function commitFrom(snap) {
    undoStack.push(snap);
    if (undoStack.length > 80) undoStack.shift();
    redoStack.length = 0;
    lastSnap = JSON.stringify(project);
    scheduleSave();
    notify();
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(project));
    project = JSON.parse(undoStack.pop());
    lastSnap = JSON.stringify(project);
    scheduleSave();
    notify();
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(project));
    project = JSON.parse(redoStack.pop());
    lastSnap = JSON.stringify(project);
    scheduleSave();
    notify();
  }

  const canUndo = () => undoStack.length > 0;
  const canRedo = () => redoStack.length > 0;

  function replace(p) {
    adopt(p);
    scheduleSave();
    notify();
  }

  /* ---------- shared connector libraries / signal lists ----------
   *
   * Both lists can be saved to a file of their own and pulled into another
   * project. Incoming entries always get fresh ids so nothing in this project
   * can be re-pointed by the import, and entries whose name is already taken
   * are skipped — names are how both lists are identified by the user. */

  // Accepts a side-file, a whole project file, or a bare array.
  const listFrom = (data, key) =>
    (Array.isArray(data) ? data : (data && Array.isArray(data[key]) ? data[key] : null));

  function mergeNamed(list, incoming, build) {
    const taken = new Set(list.map((x) => x.name.trim().toLowerCase()));
    let added = 0, skipped = 0;
    for (const item of incoming) {
      const name = item && typeof item.name === "string" ? item.name.trim() : "";
      if (!name || taken.has(name.toLowerCase())) { skipped++; continue; }
      taken.add(name.toLowerCase());
      list.push(build(item, name));
      added++;
    }
    return { added, skipped };
  }

  const mergeLibrary = (items) => mergeNamed(project.library, items, (item, name) =>
    Object.assign({}, item, { id: uid("lib"), name, pinCount: Math.max(1, item.pinCount | 0) }));

  const mergeSignals = (sigs) => mergeNamed(project.signals, sigs, (sig, name) => {
    const color = (sig.color && typeof sig.color === "object") ? sig.color : {};
    return {
      id: uid("sig"), name, gauge: sig.gauge || "", type: sig.type || "",
      color: {
        style: color.style === "striped" ? "striped" : "solid",
        base: color.base || "#8a94a6",
        stripe: color.stripe || "#ffffff",
      },
    };
  });

  /* ---------- queries ---------- */

  const get = () => project;
  const harness = (id) => project.harnesses.find((h) => h.id === id);
  const libItem = (id) => project.library.find((l) => l.id === id);
  const signal = (id) => project.signals.find((s) => s.id === id);

  function findConnector(connId) {
    for (const h of project.harnesses) {
      const conn = h.connectors.find((c) => c.id === connId);
      if (conn) return { harness: h, conn };
    }
    return null;
  }

  // Effective pin layout for a connector instance (library item or loose terminal).
  function connSpec(conn) {
    if (conn.libId) {
      const li = libItem(conn.libId);
      if (li) {
        return {
          name: li.name, pinCount: li.pinCount, imageData: li.imageData,
          layout: li.layout || "grid",
          rows: li.rows || 1, cols: li.cols || 1, numbering: li.numbering || "row",
          blocked: li.blocked || [], pinLabels: li.pinLabels || {},
          rings: li.rings || 1, centerPin: li.centerPin || "none",
          direction: li.direction || "cw", startPos: li.startPos || "top",
          ringOrder: li.ringOrder || "in",
        };
      }
      return { name: "(missing library item)", pinCount: 1, layout: "grid", rows: 1, cols: 1, numbering: "row" };
    }
    return { name: conn.termType || "Terminal", pinCount: 1, layout: "grid", rows: 1, cols: 1, numbering: "row" };
  }

  // Grid cells in the order the numbering scheme walks them.
  function gridCells(spec) {
    const rows = Math.max(1, spec.rows | 0), cols = Math.max(1, spec.cols | 0);
    const cells = [];
    if (spec.numbering === "col") {
      for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) cells.push([r, c]);
    } else if (spec.numbering === "serp") {
      for (let r = 0; r < rows; r++) {
        if (r % 2 === 1) for (let c = cols - 1; c >= 0; c--) cells.push([r, c]);
        else for (let c = 0; c < cols; c++) cells.push([r, c]);
      }
    } else {
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push([r, c]);
    }
    return cells;
  }

  // Grid positions for each pin number. Unpopulated cells (spec.blocked,
  // as r*cols+c indices) are skipped, so e.g. a relay socket is a 3x3 grid
  // with the four corners blocked.
  function pinPositions(spec) {
    const cols = Math.max(1, spec.cols | 0);
    const blocked = new Set(spec.blocked || []);
    const out = [];
    let n = 1;
    for (const [r, c] of gridCells(spec)) {
      if (blocked.has(r * cols + c)) continue;
      if (n > spec.pinCount) break;
      out.push({ pin: n++, row: r, col: c });
    }
    return out;
  }

  // Display label for a pin: custom label ("85", "87a"...) or the position
  // number. Purely cosmetic — assignments and mate checks use the number.
  function pinLabel(spec, pin) {
    return (spec.pinLabels && spec.pinLabels[pin]) || String(pin);
  }

  // Pixel positions for every pin of a spec (grid or circular layout).
  // Returns { shape:'rect'|'circle', w, h, bodyR?, points:[{pin, x, y}] }.
  function pinPoints(spec, cell) {
    const pad = 15;
    if ((spec.layout || "grid") !== "circle") {
      const points = pinPositions(spec).map((p) => ({
        pin: p.pin,
        x: pad + p.col * cell + cell / 2,
        y: pad + p.row * cell + cell / 2,
      }));
      return { shape: "rect", w: spec.cols * cell + pad * 2, h: spec.rows * cell + pad * 2, points };
    }

    /* circular: pins on 1..4 concentric rings, optional center pin */
    const n = Math.max(1, spec.pinCount | 0);
    const hasCenter = spec.centerPin === "first" || spec.centerPin === "last";
    const ringPinTotal = Math.max(0, n - (hasCenter ? 1 : 0));
    const rings = Math.min(Math.max(1, spec.rings | 0 || 1), 4);
    // distribute pins across rings, outer rings holding proportionally more
    const weights = [];
    let wsum = 0;
    for (let k = 1; k <= rings; k++) { weights.push(k); wsum += k; }
    const counts = weights.map((w) => Math.floor(ringPinTotal * w / wsum));
    let rem = ringPinTotal - counts.reduce((a, b) => a + b, 0);
    for (let k = rings - 1; rem > 0; k = (k - 1 + rings) % rings) { counts[k]++; rem--; }
    // radii: big enough for pin spacing, always growing outward
    const radii = [];
    for (let k = 0; k < rings; k++) {
      const fit = counts[k] > 1 ? (counts[k] * cell * 1.02) / (2 * Math.PI) : 0;
      const base = (hasCenter ? cell : cell * 0.62) + k * cell;
      radii[k] = Math.max(base, fit, k > 0 ? radii[k - 1] + cell * 0.95 : 0);
    }
    const bodyR = radii[rings - 1] + cell * 0.58;
    const size = bodyR * 2 + pad * 2;
    const cx0 = size / 2, cy0 = size / 2;
    const startAngle = { top: -90, right: 0, bottom: 90, left: 180 }[spec.startPos || "top"] * Math.PI / 180;
    const dir = (spec.direction || "cw") === "cw" ? 1 : -1;

    const points = [];
    let pinNo = spec.centerPin === "first" ? 2 : 1;
    const ringIdxs = (spec.ringOrder || "in") === "in"
      ? [...Array(rings).keys()]
      : [...Array(rings).keys()].reverse();
    for (const k of ringIdxs) {
      const c = counts[k];
      for (let i = 0; i < c; i++) {
        const ang = startAngle + dir * (i * 2 * Math.PI / c);
        points.push({ pin: pinNo++, x: cx0 + Math.cos(ang) * radii[k], y: cy0 + Math.sin(ang) * radii[k] });
      }
    }
    if (hasCenter) {
      points.push({ pin: spec.centerPin === "first" ? 1 : n, x: cx0, y: cy0 });
    }
    return { shape: "circle", w: size, h: size, bodyR, points };
  }

  function assignedPins(conn) {
    return Object.keys(conn.pins || {})
      .filter((p) => conn.pins[p] && conn.pins[p].signalId)
      .map(Number)
      .sort((a, b) => a - b);
  }

  // Everywhere a signal is used: [{harness, conn, pin}]
  function signalUses(sigId) {
    const out = [];
    for (const h of project.harnesses) {
      for (const c of h.connectors) {
        for (const [pin, pa] of Object.entries(c.pins || {})) {
          if (pa && pa.signalId === sigId) out.push({ harness: h, conn: c, pin: Number(pin) });
        }
      }
    }
    return out;
  }

  /* ---------- mate (linked connector) checking ---------- */

  // Compares two mated connectors pin-for-pin. Match = same signal on the
  // same pin number of both sides.
  function mateStatus(mate) {
    const A = findConnector(mate.a);
    const B = findConnector(mate.b);
    if (!A || !B) return { ok: false, orphaned: true, rows: [], A, B };
    const specA = connSpec(A.conn), specB = connSpec(B.conn);
    const n = Math.max(specA.pinCount, specB.pinCount);
    const rows = [];
    let ok = true;
    for (let p = 1; p <= n; p++) {
      const sa = (A.conn.pins && A.conn.pins[p] && A.conn.pins[p].signalId) || null;
      const sb = (B.conn.pins && B.conn.pins[p] && B.conn.pins[p].signalId) || null;
      let status;
      if (p > specA.pinCount || p > specB.pinCount) status = (sa || sb) ? "mismatch" : "nopin";
      else if (sa !== sb) status = "mismatch";
      else status = sa ? "ok" : "empty";
      if (status === "mismatch") ok = false;
      rows.push({ pin: p, a: sa, b: sb, status });
    }
    return { ok, rows, A, B };
  }

  function mateFor(connId) {
    return project.mates.find((m) => m.a === connId || m.b === connId);
  }

  /* ---------- cleanup helpers ---------- */

  function removeConnector(h, connId) {
    h.connectors = h.connectors.filter((c) => c.id !== connId);
    project.mates = project.mates.filter((m) => m.a !== connId && m.b !== connId);
  }

  function removeSegment(h, segId) {
    h.segments = h.segments.filter((s) => s.id !== segId);
    h.splices = splicesOf(h).filter((sp) => sp.segId !== segId);
  }

  function removeNode(h, nodeId) {
    h.nodes = h.nodes.filter((n) => n.id !== nodeId);
    for (const s of h.segments.filter((s) => s.a === nodeId || s.b === nodeId)) removeSegment(h, s.id);
    for (const c of h.connectors.filter((c) => c.nodeId === nodeId)) removeConnector(h, c.id);
    h.splices = splicesOf(h).filter((sp) => sp.nodeId !== nodeId);
  }

  function removeSignal(sigId) {
    for (const u of signalUses(sigId)) delete u.conn.pins[u.pin];
    for (const h of project.harnesses) {
      for (const sp of splicesOf(h)) {
        sp.signalIds = (sp.signalIds || []).filter((id) => id !== sigId);
        sp.exclude = (sp.exclude || []).filter((id) => id !== sigId);
      }
      h.splices = splicesOf(h).filter((sp) => sp.signalIds.length || sp.exclude.length);
    }
    project.signals = project.signals.filter((s) => s.id !== sigId);
  }

  function removeHarness(hId) {
    const h = harness(hId);
    if (!h) return;
    const connIds = new Set(h.connectors.map((c) => c.id));
    project.mates = project.mates.filter((m) => !connIds.has(m.a) && !connIds.has(m.b));
    project.harnesses = project.harnesses.filter((x) => x.id !== hId);
  }

  return {
    TERMINAL_TYPES, uid, load, get, replace, blankProject, newHarness,
    getPrefs, setPref,
    status, onStatus, flush, reopenLastFile, reconnectFile, grantAccess, useFile, hasFile, detachFile, serialize, recoveredCopy,
    listFrom, mergeLibrary, mergeSignals,
    changed, snapshot, commitFrom, undo, redo, canUndo, canRedo, onChange,
    harness, libItem, signal, findConnector, connSpec, pinPositions, pinPoints, pinLabel,
    splicesOf, migrate, assignedPins, signalUses, mateStatus, mateFor,
    removeConnector, removeNode, removeSegment, removeSignal, removeHarness,
  };
})();
