# Worship Song Slide Library — standalone app

This is the same app you've been using inside Claude, set up to run as a normal
website. It builds and runs cleanly (verified with `npm run build` before this
was handed to you).

## Run it locally

```
npm install
npm run dev
```

Then open the URL it prints (usually http://localhost:5173).

**Storage note:** `src/storageShim.js` replaces Claude's `window.storage` with
your browser's `localStorage`, so the app code (`src/App.jsx`) didn't need any
changes. This means your song library lives in *that one browser, on that one
computer* — it won't sync across devices and won't be shared with anyone else,
even though the app's code still says `shared: true` internally. Good for
trying it out or for genuinely single-person use.

## Deploy it so your team can use it

Two separate problems to solve: hosting the app, and giving it a real shared
backend (localStorage won't cut it once more than one person needs to see the
same library).

### 1. Host the app — easiest: Vercel or Netlify

1. Push this folder to a GitHub repo.
2. Go to vercel.com (or netlify.com) → New Project → import that repo.
3. Framework preset: Vite. Build command `npm run build`, output dir `dist`.
4. Deploy. You'll get a URL anyone can open.

This alone gets you a real, shareable link — but everyone who opens it still
gets their *own* localStorage, so they won't see each other's songs. For an
actually shared library, you need step 2.

### 2. Give it a real shared backend — easiest: Supabase

Supabase gives you a free hosted Postgres database with an API in a few
minutes, no server to manage.

1. Create a project at supabase.com.
2. In the SQL editor, create one table:
   ```sql
   create table song_storage (
     key text primary key,
     value text not null
   );
   alter table song_storage enable row level security;
   create policy "public read/write" on song_storage
     for all using (true) with check (true);
   ```
   (The open policy is fine for an internal tool behind a private link; lock
   it down further if this ever needs real access control.)
3. `npm install @supabase/supabase-js`
4. Replace `src/storageShim.js` with a version that talks to Supabase instead
   of localStorage — same four methods (`get`, `set`, `delete`, `list`), same
   shape of return values, so `App.jsx` still doesn't need to change:

   ```js
   import { createClient } from "@supabase/supabase-js";

   const supabase = createClient(
     "https://YOUR-PROJECT.supabase.co",
     "YOUR-PUBLIC-ANON-KEY"
   );

   window.storage = {
     async get(key) {
       const { data, error } = await supabase
         .from("song_storage")
         .select("value")
         .eq("key", key)
         .single();
       if (error || !data) throw new Error("Key not found: " + key);
       return { key, value: data.value, shared: true };
     },
     async set(key, value) {
       await supabase.from("song_storage").upsert({ key, value });
       return { key, value, shared: true };
     },
     async delete(key) {
       await supabase.from("song_storage").delete().eq("key", key);
       return { key, deleted: true, shared: true };
     },
     async list(prefix = "") {
       const { data } = await supabase
         .from("song_storage")
         .select("key")
         .like("key", `${prefix}%`);
       return { keys: (data || []).map((r) => r.key), prefix, shared: true };
     },
   };
   ```
5. Redeploy. Now everyone who opens the Vercel/Netlify link sees the same
   library, same as it worked inside Claude.

## Other things worth knowing

- **PDF import and PowerPoint export** already load their libraries (`pdf.js`,
  `pptxgenjs`) from a CDN at runtime, exactly like they did inside Claude —
  no extra setup needed for those to keep working.
- **Fonts** are pulled from Google Fonts via the `<style>` tag already in
  `App.jsx` — also needs no changes.
- If you ever want to edit the app further, `src/App.jsx` is the whole thing —
  same file you've been getting from Claude each time.
