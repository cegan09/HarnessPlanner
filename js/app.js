"use strict";
/* App shell: tabs, top bar, harness management, project files, keyboard,
 * and the cross-harness mate alert. */
const Main = (() => {
  const { el } = UI;
  let currentHarnessId = null;
  let printRestore = null;
  let mateIssueSet = new Set();
  let badMates = [];

  function currentHarness() {
    return Model.harness(currentHarnessId) || Model.get().harnesses[0];
  }

  function setHarness(id, opts = {}) {
    currentHarnessId = id;
    if (!opts.skipRender) {
      LayoutView.onHarnessSwitched();
      WireDiagram.onHarnessSwitched();
      renderAll();
    }
  }

  function mateIssues() { return mateIssueSet; }

  function computeMateIssues() {
    mateIssueSet = new Set();
    badMates = [];
    for (const mate of Model.get().mates) {
      const st = Model.mateStatus(mate);
      if (!st.ok) {
        badMates.push(mate);
        mateIssueSet.add(mate.a);
        mateIssueSet.add(mate.b);
      }
    }
  }

  /* ---------- tabs ---------- */

  function showTab(name) {
    document.querySelectorAll("#tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
    if (name === "layout") LayoutView.render();
    if (name === "wires") WireDiagram.render();
  }

  function activeTab() {
    const t = document.querySelector("#tabs .tab.active");
    return t ? t.dataset.tab : "layout";
  }

  /* ---------- top bar ---------- */

  function setTheme(t) {
    const applied = UI.setTheme(t);
    const btn = document.getElementById("btnTheme");
    if (btn) {
      btn.textContent = applied === "dark" ? "◐" : "◑";
      btn.title = applied === "dark"
        ? "Dark theme — switch to light (light prints properly)"
        : "Light theme — switch back to dark";
    }
    return applied;
  }

  function renderTopbar() {
    const p = Model.get();
    if (!Model.harness(currentHarnessId)) currentHarnessId = p.harnesses[0].id;

    const nameInput = document.getElementById("projectName");
    if (document.activeElement !== nameInput) nameInput.value = p.name;

    const hSel = document.getElementById("harnessSelect");
    hSel.innerHTML = "";
    for (const h of p.harnesses) hSel.appendChild(el("option", { value: h.id }, h.name));
    hSel.value = currentHarnessId;

    document.getElementById("unitSelect").value = p.unit;
    document.getElementById("btnUndo").disabled = !Model.canUndo();
    document.getElementById("btnRedo").disabled = !Model.canRedo();

    const alert = document.getElementById("mateAlert");
    if (badMates.length) {
      alert.textContent = `⚠ ${badMates.length} mated connector pair${badMates.length === 1 ? " needs" : "s need"} review`;
      alert.classList.remove("hidden");
    } else {
      alert.classList.add("hidden");
    }
    renderSaveStatus();

    const badge = document.getElementById("compareBadge");
    if (badMates.length) {
      badge.textContent = String(badMates.length);
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }

  function bindTopbar() {
    document.getElementById("projectName").addEventListener("change", (e) => {
      Model.get().name = e.target.value.trim() || Model.get().name;
      Model.changed();
    });
    document.getElementById("harnessSelect").addEventListener("change", (e) => setHarness(e.target.value));
    document.getElementById("btnAddHarness").addEventListener("click", () => {
      UI.promptText("New harness name", "Harness " + (Model.get().harnesses.length + 1), (name) => {
        const h = Model.newHarness(name);
        Model.get().harnesses.push(h);
        currentHarnessId = h.id;
        Model.changed();
        LayoutView.onHarnessSwitched();
        WireDiagram.onHarnessSwitched();
      });
    });
    document.getElementById("btnRenameHarness").addEventListener("click", () => {
      const h = currentHarness();
      UI.promptText("Rename harness", h.name, (name) => { h.name = name; Model.changed(); });
    });
    document.getElementById("btnDeleteHarness").addEventListener("click", () => {
      const p = Model.get();
      if (p.harnesses.length <= 1) {
        UI.modal("Can't delete", el("div", {}, "A project needs at least one harness. Use “New” in the top bar to start a fresh project."), [{ label: "OK", primary: true }]);
        return;
      }
      const h = currentHarness();
      UI.confirmBox(`Delete harness "${h.name}" and everything in it?`, () => {
        Model.removeHarness(h.id);
        currentHarnessId = p.harnesses[0].id;
        Model.changed();
        LayoutView.onHarnessSwitched();
        WireDiagram.onHarnessSwitched();
      });
    });
    document.getElementById("unitSelect").addEventListener("change", (e) => {
      Model.get().unit = e.target.value;
      Model.changed();
    });
    document.getElementById("btnTheme").addEventListener("click", () => {
      setTheme(UI.getTheme() === "dark" ? "light" : "dark");
      Model.setPref("theme", UI.getTheme());
    });

    /* Printing on the dark theme wastes a cartridge and reads badly, so swap
     * to light for the duration and put it back afterwards. The canvases are
     * SVG built in JS, so they need a re-render to pick the new colours up. */
    window.addEventListener("beforeprint", () => {
      printRestore = UI.getTheme();
      if (printRestore === "dark") { setTheme("light"); renderAll(); }
      if (activeTab() === "wires") WireDiagram.fit();
      else if (activeTab() === "layout") LayoutView.fit();
    });
    window.addEventListener("afterprint", () => {
      if (printRestore && printRestore !== UI.getTheme()) { setTheme(printRestore); renderAll(); }
      printRestore = null;
    });

    document.getElementById("btnUndo").addEventListener("click", () => Model.undo());
    document.getElementById("btnRedo").addEventListener("click", () => Model.redo());
    document.getElementById("mateAlert").addEventListener("click", () => {
      if (badMates.length) CompareView.openMate(badMates[0]);
    });

    document.getElementById("btnSave").addEventListener("click", () => save());
    document.getElementById("btnSaveAs").addEventListener("click", () => saveAs());
    document.getElementById("btnOpen").addEventListener("click", () => openProject());
    document.getElementById("saveStatus").addEventListener("click", () => statusAction());
    document.getElementById("importFile").addEventListener("change", (e) => {
      const f = e.target.files[0];
      e.target.value = "";
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const p = parseProject(reader.result);
          UI.confirmBox(`Replace the current project with "${p.name || f.name}"?`, () => {
            Model.replace(p);
            afterProjectSwap();
          });
        } catch (err) {
          fileError("Open failed", "That file doesn't look like a Harness Planner project: " + err.message);
        }
      };
      reader.readAsText(f);
    });
    document.getElementById("btnNew").addEventListener("click", () => {
      confirmDiscard("Start a blank project? The current project will be replaced.", () => {
        Model.detachFile();
        Model.replace(Model.blankProject());
        afterProjectSwap();
        saveAs();
      });
    });
  }

  /* ---------- project files ----------
   *
   * The project file on disk is the master copy; Model autosaves to it after
   * every change. Browsers without the File System Access API fall back to
   * download/upload, so the same three buttons work everywhere. */

  function suggestedFileName() {
    const base = (Model.get().name || "harness-project")
      .replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-");
    return (base || "harness-project") + ".json";
  }

  function parseProject(text) {
    const p = JSON.parse(text);
    if (!p || !Array.isArray(p.harnesses) || !Array.isArray(p.signals)) throw new Error("not a harness project");
    return p;
  }

  function fileError(title, err) {
    UI.modal(title, el("div", {}, typeof err === "string" ? err : String((err && err.message) || err)),
      [{ label: "OK", primary: true }]);
  }

  function afterProjectSwap() {
    const p = Model.get();
    currentHarnessId = p.harnesses[0] ? p.harnesses[0].id : null;
    LayoutView.onHarnessSwitched();
    WireDiagram.onHarnessSwitched();
    renderAll();
  }

  // Warn before throwing away work that never made it to a file.
  function confirmDiscard(question, onYes) {
    const st = Model.status();
    const extra = st.state === "saved" ? "" : " The current project isn't saved to a file yet.";
    UI.confirmBox(question + extra, onYes);
  }

  async function saveAs() {
    if (!Storage.supported()) { UI.download(suggestedFileName(), Model.serialize()); return; }
    try {
      await Model.useFile(await Storage.pickSave(suggestedFileName()));
    } catch (e) {
      if (e && e.name !== "AbortError") fileError("Save failed", e);
    }
  }

  async function save() {
    if (!Storage.supported()) { UI.download(suggestedFileName(), Model.serialize()); return; }
    if (!Model.hasFile()) return saveAs();
    if (Model.status().state === "reconnect" && !(await Model.grantAccess())) return;
    await Model.flush();
  }

  async function openProject() {
    if (!Storage.supported()) { document.getElementById("importFile").click(); return; }
    let handle;
    try {
      handle = await Storage.pickOpen();
    } catch (e) {
      if (e && e.name !== "AbortError") fileError("Open failed", e);
      return;
    }
    confirmDiscard(`Open "${handle.name}"? It replaces the project you have open.`, async () => {
      if ((await Model.useFile(handle, { read: true })) === false) {
        fileError("Open failed", "That file doesn't look like a Harness Planner project.");
        return;
      }
      afterProjectSwap();
    });
  }

  /* The remembered file usually reopens silently, but Chrome may drop the
   * permission between launches; then we're running off the browser recovery
   * copy and need a click to reconnect. */
  function reconnect() {
    const name = Model.status().fileName;
    const overwrite = async () => { if (await Model.grantAccess()) await Model.flush(); };
    const load = async () => { if (await Model.reconnectFile()) afterProjectSwap(); };
    if (!Model.canUndo()) { load(); return; }
    UI.modal("Reconnect project file",
      el("div", {}, `You've made changes since this tab opened, and "${name}" on disk may be different. Which copy wins?`),
      [
        { label: "Keep my changes (overwrite file)", primary: true, onClick: overwrite },
        { label: "Load the file (discard changes)", onClick: load },
        { label: "Cancel" },
      ]);
  }

  function statusAction() {
    switch (Model.status().state) {
      case "nofile": case "download": saveAs(); break;
      case "reconnect": reconnect(); break;
      case "error": save(); break;
    }
  }

  let askedForFile = false;
  let nudgePending = false;

  // Ask once, the first time real work exists with nowhere to put it. Deferred
  // so it can't wipe a modal that's open (or closing) right now.
  function nudgeForFile() {
    if (askedForFile || nudgePending) return;
    nudgePending = true;
    setTimeout(() => {
      nudgePending = false;
      if (askedForFile || document.querySelector(".modal")) return;
      askedForFile = true;
      UI.modal("Save this project to a file?",
        el("div", {}, "Your work is only in this browser's storage right now. Pick a file on disk and it will autosave there from now on."),
        [{ label: "Choose file…", primary: true, onClick: saveAs }, { label: "Not now" }]);
    }, 0);
  }

  function renderSaveStatus() {
    const st = Model.status();
    const btn = document.getElementById("saveStatus");
    const view = {
      saved: { text: `💾 ${st.fileName}`, title: `Autosaving to ${st.fileName}`, cls: "ok" },
      saving: { text: `💾 ${st.fileName || "…"} — saving`, title: "Writing to disk", cls: "ok" },
      nofile: { text: "⚠ Not saved to a file", title: "Click to choose a file on disk to autosave into", cls: "warn" },
      reconnect: { text: `⚠ Reconnect ${st.fileName}`, title: "Click to restore access to your project file", cls: "warn" },
      error: { text: "⚠ Save failed", title: "Click to retry saving to disk", cls: "warn" },
      download: { text: "⚠ No autosave in this browser", title: "This browser can't write files directly — use Save to download a copy", cls: "warn" },
    }[st.state];
    btn.textContent = view.text;
    btn.title = view.title;
    btn.className = "save-status " + view.cls;
    btn.disabled = st.state === "saved" || st.state === "saving";

    if (st.state === "nofile" && Model.canUndo()) nudgeForFile();
  }

  /* ---------- keyboard ---------- */

  function bindKeys() {
    window.addEventListener("keydown", (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        if (!typing) { e.preventDefault(); Model.undo(); }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
        if (!typing) { e.preventDefault(); Model.redo(); }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
        return;
      }
      if (typing) return;
      if (activeTab() === "wires") {
        switch (e.key) {
          case "v": case "V": WireDiagram.setMode("select"); break;
          case "s": case "S": WireDiagram.setMode("splice"); break;
          case "Escape": WireDiagram.escape(); break;
          case "f": case "F": WireDiagram.fit(); break;
        }
        return;
      }
      if (activeTab() !== "layout") return;
      switch (e.key) {
        case "v": case "V": LayoutView.setMode("select"); break;
        case "a": case "A": LayoutView.setMode("point"); break;
        case "c": case "C": LayoutView.setMode("connect"); break;
        case "j": case "J": LayoutView.setMode("jog"); break;
        case "x": case "X": LayoutView.setMode("delete"); break;
        case "Delete": case "Backspace": LayoutView.deleteSelection(); break;
        case "Escape": LayoutView.escape(); break;
        case "f": case "F": LayoutView.fit(); break;
      }
    });
  }

  function bindUnload() {
    // Don't sit on pending edits while the tab is hidden or about to close.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") Model.flush();
    });
    window.addEventListener("beforeunload", (e) => {
      // Only nag when there's work that never reached a file.
      if (Model.status().state === "saved" || !Model.canUndo()) return;
      Model.flush();
      e.preventDefault();
      e.returnValue = "";
    });
  }

  /* ---------- boot ---------- */

  function renderAll() {
    computeMateIssues();
    renderTopbar();
    LibraryView.render();
    PinoutView.render();
    BuildSheetView.render();
    CompareView.render();
    LayoutView.render();
    WireDiagram.render();
  }

  function init() {
    Model.load();
    setTheme(Model.getPrefs().theme || "dark");
    currentHarnessId = Model.get().harnesses[0].id;
    bindTopbar();
    bindKeys();
    bindUnload();
    for (const t of document.querySelectorAll("#tabs .tab")) {
      t.addEventListener("click", () => showTab(t.dataset.tab));
    }
    LayoutView.init();
    WireDiagram.init();
    Model.onChange(renderAll);
    Model.onStatus(renderSaveStatus);
    renderAll();

    // The file from last session reopens on its own when the browser still
    // remembers permission; otherwise the status button asks for a click.
    Model.reopenLastFile().then((res) => {
      if (res !== "loaded" && res !== "differs") return;
      afterProjectSwap();
      if (res === "differs") offerRecovery();
    });
  }

  /* The browser's recovery copy didn't match the file — most likely a previous
   * session was closed before its last save reached disk. */
  function offerRecovery() {
    const recovered = Model.recoveredCopy();
    if (!recovered) return;
    UI.modal("Unsaved changes found",
      el("div", {}, `The copy kept in this browser doesn't match "${Model.status().fileName}" on disk. `
        + "The file has been loaded. If your last session ended before it could save, restore that copy instead."),
      [
        { label: "Keep the file", primary: true },
        { label: "Restore unsaved changes", onClick: () => { Model.replace(recovered); afterProjectSwap(); } },
      ]);
  }

  window.addEventListener("DOMContentLoaded", init);

  return { currentHarness, setHarness, showTab, mateIssues, renderAll };
})();
