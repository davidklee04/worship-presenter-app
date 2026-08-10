# Worship Song Slide Library

**Live app:** https://worship-presenter-app.vercel.app/

A shared song library and slide generator for worship teams. Import chord
sheets, get clean lyric-only slides, and export ready-to-use PowerPoint
decks — no manual retyping, no chords accidentally left on screen.

---

## What it does

- **Shared song library.** Every song is stored centrally (Supabase), so
  anyone on the team who opens the app sees and can edit the same library —
  not a private copy per person.
- **Paste or import.** Add a song by pasting a chord sheet as text, or
  uploading a PDF directly (from SongSelect or similar) — the app strips
  chords and reconstructs clean lyrics automatically, including two-column
  layouts and Nashville Number System charts.
- **Bulk cloud import.** Point the app at a private Supabase Storage bucket
  full of chord-sheet PDFs and import all of them in one pass, with
  per-file progress and a summary of anything that failed to parse.
- **Per-song slide formatting.** Font, font size, lines per slide, and
  whether section labels (Verse/Chorus/etc.) are shown are all adjustable
  per song, with a live projector-style preview.
- **Export.** Copy slides as plain text (for ProPresenter, EasyWorship,
  etc.) or download a real `.pptx` file, generated right in the browser —
  no round-trip through any other tool.

## Known limitations

Worth knowing rather than being surprised by:

- **PDF chord-stripping is heuristic, not perfect.** It handles standard
  letter chords, Nashville numbers, altered/extended chords, and most
  two-column layouts correctly, but always glance over an imported song
  before trusting it, especially the first line or two of each section.
- **Some PDFs drop letters on import.** A handful of embedded PDF fonts
  encode ligatures (the "fi" in "fire," for example) as characters with no
  real text mapping — those letters are genuinely unrecoverable from the
  file itself, not a bug in the parser. If an imported song is missing a
  letter or two in an unexpected spot, this is usually why.
- **Chord sheets with more than two independent columns** (rare, but it
  happens) can come out with sections in the wrong order. Two clean columns
  read correctly; anything more complex is safer pasted in by hand.
- **Artist/songwriter data is a work in progress.** The library was
  originally imported with many songs missing correct artist credit or
  carrying garbled values (leftover chord notation that got misread as the
  artist field). Titles have all been normalized to Title Case, and a large
  ongoing cleanup pass has been identifying correct artists from each
  song's own lyrics (cross-checked against CCLI/publisher sources where
  possible) rather than guessing. Songs where that couldn't be confirmed
  are left with an empty artist field on purpose, rather than a wrong one —
  worth a look before relying on this data for CCLI reporting.

## Tech stack

- **Frontend:** React + Vite
- **Backend:** Supabase (Postgres for song data, Storage for source PDFs)
- **Hosting:** Vercel
- **PDF parsing:** pdf.js, loaded client-side
- **Slide export:** pptxgenjs, generated client-side
- **Fonts:** Google Fonts, loaded at runtime

## Data model

Two things live in Supabase:

**`song_storage` table** — one row per song, plus a couple of setlist rows:

```sql
create table song_storage (
  key text primary key,   -- e.g. "songs:above-all"
  value text not null     -- JSON: title, artist, rawText, linesPerSlide,
);                         --       fontFamily, fontSize, showLabels
```

**`chord-sheets` Storage bucket** — private bucket holding the raw PDF
chord charts used for bulk cloud import. "Private" here means not publicly
browsable, gated the same way the song table is (via the app's own
credentials) rather than per-user authentication — anyone with access to
the deployed app can read it.

## Local development

```
npm install
npm run dev
```

Requires a `.env.local` with:

```
VITE_SUPABASE_URL=your-project-url
VITE_SUPABASE_ANON_KEY=your-anon-key
```

## Status snapshot

As of this writing: 518 songs in the library. Titles are fully normalized.
Artist attribution cleanup is ongoing — several hundred songs have been
resolved so far, with the remainder tracked in a running list rather than
left silently wrong.
