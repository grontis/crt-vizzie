// v2/bg-folder.js — V2BgFolder
// Wraps the File System Access API to give the bg layer streaming, on-demand
// access to local media files without staging them through HTTP. The granted
// directory handle is persisted in IndexedDB so subsequent boots restore it
// silently when the underlying permission is still granted.
//
// Usage:
//   const folder = new V2BgFolder()
//   if (await folder.tryRestoreSilent()) { ... }              // no UI
//   else if (await folder.requestPermissionAndScan()) { ... } // user gesture
//   else if (await folder.pickFolder()) { ... }                // user gesture
//
//   const file = await folder.getFile(idx)
//   bgLayer.loadFromFile(file)
//
// Load order: after config.js, before sketch.js.

'use strict';

class V2BgFolder {

  static EXTENSIONS = new Set([
    'jpg', 'jpeg', 'png', 'gif', 'webp',
    'mp4', 'webm', 'mov', 'mkv', 'm4v',
  ]);

  static IDB_NAME  = 'crt-vizzie-bg';
  static IDB_STORE = 'handles';
  static IDB_KEY   = 'dirHandle';

  constructor() {
    this._handle  = null;   // FileSystemDirectoryHandle
    this._entries = [];     // Array<FileSystemFileHandle>, sorted by name
  }

  // ── Public ─────────────────────────────────────────────────────────────────

  static isSupported() {
    return typeof window.showDirectoryPicker === 'function';
  }

  get count() { return this._entries.length; }

  get folderName() { return this._handle ? this._handle.name : ''; }

  /**
   * @param {number} idx
   * @returns {string} filename or '' if out of range
   */
  nameAt(idx) {
    return (idx >= 0 && idx < this._entries.length) ? this._entries[idx].name : '';
  }

  /**
   * Resolve a fresh File reference for the entry at idx. The File is a
   * lazy handle into the underlying OS file — no bytes are read until the
   * consumer (e.g. <video src=blobURL>) requests them.
   * @param {number} idx
   * @returns {Promise<File|null>}
   */
  async getFile(idx) {
    const handle = this._entries[idx];
    if (!handle) return null;
    try {
      return await handle.getFile();
    } catch (e) {
      console.warn('[V2BgFolder] getFile failed for', handle.name, e);
      return null;
    }
  }

  /**
   * Restore a previously granted handle from IndexedDB without showing UI.
   * Returns true only when the handle exists AND the permission is still
   * 'granted'. Never prompts the user.
   * @returns {Promise<boolean>}
   */
  async tryRestoreSilent() {
    if (!V2BgFolder.isSupported()) return false;
    const handle = await this._loadHandle();
    if (!handle) return false;
    try {
      const perm = await handle.queryPermission({ mode: 'read' });
      if (perm !== 'granted') {
        // Stash the handle so requestPermissionAndScan() can use it later
        // without another IDB round-trip.
        this._handle = handle;
        return false;
      }
      this._handle = handle;
      await this._scan();
      return true;
    } catch (e) {
      console.warn('[V2BgFolder] silent restore failed:', e);
      return false;
    }
  }

  /**
   * True when a stored handle exists but is currently 'prompt' (i.e. silent
   * restore failed only because the permission needs to be re-granted).
   * Use this to decide whether the next user gesture should attempt a silent
   * permission upgrade.
   */
  get hasPendingHandle() {
    return this._handle !== null && this._entries.length === 0;
  }

  /**
   * Use a previously stored handle and ask the browser to upgrade its
   * permission to 'granted'. MUST be invoked from a user gesture.
   * @returns {Promise<boolean>}
   */
  async requestPermissionAndScan() {
    if (!V2BgFolder.isSupported()) return false;
    const handle = this._handle || (await this._loadHandle());
    if (!handle) return false;
    try {
      const perm = await handle.requestPermission({ mode: 'read' });
      if (perm !== 'granted') return false;
      this._handle = handle;
      await this._scan();
      return true;
    } catch (e) {
      console.warn('[V2BgFolder] requestPermission failed:', e);
      return false;
    }
  }

  /**
   * Show the directory picker and persist the chosen handle. MUST be invoked
   * from a user gesture. Returns false if the user cancels or the API is
   * unavailable.
   * @returns {Promise<boolean>}
   */
  async pickFolder() {
    if (!V2BgFolder.isSupported()) return false;
    let handle;
    try {
      handle = await window.showDirectoryPicker({
        id:      'crt-vizzie-bg', // browser remembers last-used location per id
        mode:    'read',
        startIn: 'videos',
      });
    } catch (e) {
      // AbortError = user cancelled the picker — not really an error
      if (e && e.name !== 'AbortError') {
        console.warn('[V2BgFolder] showDirectoryPicker failed:', e);
      }
      return false;
    }
    this._handle = handle;
    await this._saveHandle(handle);
    await this._scan();
    return true;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Enumerate the directory handle for supported media files. Sorts results
   * by name (case-insensitive) so cycling order is stable.
   */
  async _scan() {
    const out = [];
    try {
      for await (const entry of this._handle.values()) {
        if (entry.kind !== 'file') continue;
        const dot = entry.name.lastIndexOf('.');
        if (dot < 0) continue;
        const ext = entry.name.slice(dot + 1).toLowerCase();
        if (!V2BgFolder.EXTENSIONS.has(ext)) continue;
        out.push(entry);
      }
    } catch (e) {
      console.warn('[V2BgFolder] directory scan failed:', e);
      this._entries = [];
      return;
    }
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    this._entries = out;
  }

  // IndexedDB is the only structured-clone-capable store available to a page,
  // and FileSystemDirectoryHandle is structured-cloneable — so this small
  // 1-table schema is enough to persist the handle across reloads.

  _openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(V2BgFolder.IDB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(V2BgFolder.IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  async _loadHandle() {
    let db;
    try { db = await this._openDb(); } catch { return null; }
    return new Promise((resolve) => {
      try {
        const tx    = db.transaction(V2BgFolder.IDB_STORE, 'readonly');
        const store = tx.objectStore(V2BgFolder.IDB_STORE);
        const req   = store.get(V2BgFolder.IDB_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror   = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async _saveHandle(handle) {
    let db;
    try { db = await this._openDb(); } catch { return; }
    return new Promise((resolve) => {
      try {
        const tx    = db.transaction(V2BgFolder.IDB_STORE, 'readwrite');
        const store = tx.objectStore(V2BgFolder.IDB_STORE);
        const req   = store.put(handle, V2BgFolder.IDB_KEY);
        req.onsuccess = () => resolve();
        req.onerror   = () => resolve(); // non-fatal; in-memory handle still works
      } catch {
        resolve();
      }
    });
  }

}
