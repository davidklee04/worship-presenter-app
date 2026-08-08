// Polyfills the window.storage API that Claude artifacts provide, backed by
// Supabase Postgres instead of localStorage, so the library is shared across
// everyone who opens the app (see README.md for the Supabase setup steps).
//
// Requires VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your .env file.

import { createClient } from "@supabase/supabase-js";

const PREFIX = "worship-slide-library";

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

function fullKey(key, shared) {
  return `${PREFIX}:${shared ? "shared" : "personal"}:${key}`;
}

function stripPrefix(fullKeyStr, shared) {
  return fullKeyStr.slice(`${PREFIX}:${shared ? "shared" : "personal"}:`.length);
}

window.storage = {
  async get(key, shared = false) {
    const { data, error } = await supabase
      .from("song_storage")
      .select("value")
      .eq("key", fullKey(key, shared))
      .single();
    if (error || !data) throw new Error(`Key not found: ${key}`);
    return { key, value: data.value, shared };
  },

  async set(key, value, shared = false) {
    const { error } = await supabase
      .from("song_storage")
      .upsert({ key: fullKey(key, shared), value });
    if (error) throw new Error(error.message);
    return { key, value, shared };
  },

  async delete(key, shared = false) {
    const { error } = await supabase
      .from("song_storage")
      .delete()
      .eq("key", fullKey(key, shared));
    if (error) throw new Error(error.message);
    return { key, deleted: true, shared };
  },

  async list(prefix = "", shared = false) {
    const wantedPrefix = fullKey(prefix, shared);
    const { data, error } = await supabase
      .from("song_storage")
      .select("key")
      .like("key", `${wantedPrefix}%`);
    if (error) throw new Error(error.message);
    return { keys: (data || []).map((r) => stripPrefix(r.key, shared)), prefix, shared };
  },
};
