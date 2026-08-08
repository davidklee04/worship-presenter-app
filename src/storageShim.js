// Polyfills the window.storage API that Claude artifacts provide, using the
// browser's localStorage instead. This means the app code itself needs zero
// changes — it still calls window.storage.get/set/delete/list exactly as
// before.
//
// IMPORTANT: localStorage is per-browser, per-device. Setting `shared: true`
// here does NOT make the library visible to other people the way it did
// inside Claude — it's still just your own browser's storage. If you want a
// real shared library across your team, see the Supabase notes in README.md
// and swap this file for a networked version.

const PREFIX = "worship-slide-library";

function fullKey(key, shared) {
  return `${PREFIX}:${shared ? "shared" : "personal"}:${key}`;
}

function stripPrefix(fullKeyStr, shared) {
  return fullKeyStr.slice(`${PREFIX}:${shared ? "shared" : "personal"}:`.length);
}

window.storage = {
  async get(key, shared = false) {
    const raw = localStorage.getItem(fullKey(key, shared));
    if (raw === null) {
      throw new Error(`Key not found: ${key}`);
    }
    return { key, value: raw, shared };
  },

  async set(key, value, shared = false) {
    localStorage.setItem(fullKey(key, shared), value);
    return { key, value, shared };
  },

  async delete(key, shared = false) {
    localStorage.removeItem(fullKey(key, shared));
    return { key, deleted: true, shared };
  },

  async list(prefix = "", shared = false) {
    const wantedPrefix = fullKey(prefix, shared);
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(wantedPrefix)) {
        keys.push(stripPrefix(k, shared));
      }
    }
    return { keys, prefix, shared };
  },
};
