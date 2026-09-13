"use strict";
/* Local-disk project storage.
 *
 * A project lives in a real .json file on your disk, opened through the
 * File System Access API. The handle to the last file used is kept in
 * IndexedDB (handles can't be stringified, so localStorage can't hold them)
 * so the app can reopen that same file on the next launch.
 *
 * Browsers without the API (Firefox, Safari, and any non-secure context)
 * fall back to download/upload, handled by the caller.
 */
const Storage = (() => {
  const DB_NAME = "wiringTool";
  const STORE = "handles";
  const HANDLE_KEY = "lastProjectFile";

  const FILE_TYPES = [{
    description: "Harness Planner project",
    accept: { "application/json": [".json"] },
  }];

  const supported = () =>
    typeof window.showSaveFilePicker === "function" && typeof indexedDB !== "undefined";

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(mode, run) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  const rememberHandle = (h) => tx("readwrite", (s) => s.put(h, HANDLE_KEY)).catch(() => {});
  const forgetHandle = () => tx("readwrite", (s) => s.delete(HANDLE_KEY)).catch(() => {});
  const recallHandle = () => tx("readonly", (s) => s.get(HANDLE_KEY)).catch(() => null);

  // Chrome can persist read/write permission across launches, but when it
  // doesn't, requesting it again only works inside a user gesture.
  async function permission(handle, request) {
    if (!handle) return "denied";
    const opts = { mode: "readwrite" };
    try {
      let state = await handle.queryPermission(opts);
      if (state !== "granted" && request) state = await handle.requestPermission(opts);
      return state;
    } catch (e) {
      return "denied";
    }
  }

  async function pickSave(suggestedName) {
    return window.showSaveFilePicker({ suggestedName, types: FILE_TYPES });
  }

  async function pickOpen() {
    const [handle] = await window.showOpenFilePicker({ types: FILE_TYPES, multiple: false });
    return handle;
  }

  // createWritable() writes to a swap file and swaps it in on close, so a
  // failed or interrupted save leaves the previous file intact.
  async function write(handle, text) {
    const w = await handle.createWritable();
    try {
      await w.write(text);
    } catch (e) {
      await w.abort().catch(() => {});
      throw e;
    }
    await w.close();
  }

  async function read(handle) {
    const file = await handle.getFile();
    return file.text();
  }

  return { supported, pickSave, pickOpen, read, write, permission, rememberHandle, forgetHandle, recallHandle };
})();
