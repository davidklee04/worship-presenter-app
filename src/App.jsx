import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  Search,
  Plus,
  Music4,
  Copy,
  Pencil,
  Trash2,
  X,
  Check,
  ChevronLeft,
  Loader2,
  Upload,
  Download,
  Users,
  ArrowUp,
  ArrowDown,
  FileText,
  ChevronDown,
  ChevronUp,
  GripVertical,
} from "lucide-react";

// ---------- Chord-sheet parsing ----------

// Standard letter chords — covers extended/altered chords too:
// C, G#m7, D/F#, Bm7b5, Fmaj7#11, Gsus4(no3), Cadd9/E, ...
const QUALITY = "(?:maj|min|dim|aug|sus|add|m|\\([^()]*\\)|[#b+-])";
const CHORD_TOKEN = new RegExp(`^[A-G](?:#|b)?(?:${QUALITY}|\\d{1,2})*(?:/(?:#|b)?[A-G](?:#|b)?\\d*)?$`, "i");
// Nashville number system — same extended/altered coverage: 1, 5/4, 2m7, 1maj7/5, 3sus/7, 5m/b7, ...
const NASHVILLE_TOKEN = new RegExp(`^[1-7](?:${QUALITY}|\\d{1,2})*(?:/(?:#|b)?[1-7](?:#|b)?\\d*)?$`, "i");

// Trailing "\d*[a-z]?" also matches sub-labeled sections like "Verse1B" or
// "Chorus 2a" — the number/letter is only ever a variant/take marker, not
// something worth keeping on the slide, so it's dropped in the label below.
const SECTION_WORDS = /^(verse|chorus|pre-chorus|prechorus|bridge|intro|outro|tag|interlude|ending|refrain|instrumental|instr)\s*\d*[a-z]?\s*:?\s*$/i;

// Non-lyric notation that shows up as its own line — repeat/performance directions,
// not something to ever show on a slide.
const DIRECTIVE_LINE_RE = /^\(?\s*(repeat(\s+(chorus|verse|bridge|x?\d+))?|instrumental(\s+x?\d+)?|interlude|tacet|vamp|fine|coda|to\s*coda|d\.?\s*s\.?\s*(al\s*coda)?|capo\s*\d*|play(\s+\w+)*|x\s*\d+)\s*\)?$/i;
// Same directions, but tacked onto the end of a chord line rather than on their own,
// e.g. "(1/3) 2m7 (1) (Last x)" or "4 1/3 2m (To Ch.)" — strip before classifying.
const DIRECTIVE_INLINE_RE = /\(\s*(to\s*(ch\.?|chorus|v\d*|verse\s*\d*|coda)|last\s*x?\d*|repeat(\s+x?\d+)?|x\d+)\s*\)/gi;

function isChordyToken(t) {
  if (/^\|+$/.test(t)) return true; // barline
  if (/^x\s*\d+$/i.test(t)) return true; // repeat marker: x2, x4
  if (/^n\.?\s*c\.?$/i.test(t)) return true; // "No Chord"
  if (t === "%" || t === "/" || t === "-" || t === "--") return true; // rhythm/slash notation
  if (/^\(.+\)$/.test(t)) return isChordyToken(t.slice(1, -1)); // (1/3), (4), (2m7) chord alternates
  // A slash-bass fragment on its own, e.g. "/1" or "/G" — PDF extraction
  // sometimes splits "4/1" into separate "4" and "/1" tokens.
  if (/^\/(?:#|b)?[A-G1-7](?:#|b)?\d*$/i.test(t)) return true;
  return CHORD_TOKEN.test(t) || NASHVILLE_TOKEN.test(t);
}

function isChordLine(trimmed) {
  if (!trimmed) return false;
  // Collapse spaces *inside* parens first, so a chord-alternative group like
  // "(4 2m7)" is judged as one token instead of two broken fragments.
  const forCheck = trimmed.replace(/\(([^()]*)\)/g, (m, inner) => "(" + inner.replace(/\s+/g, "") + ")");
  const tokens = forCheck.split(/\s+/);
  const chordy = tokens.filter(isChordyToken).length;
  return chordy / tokens.length >= 0.8;
}

function stripInlineChords(line) {
  // [G] [Am7] [Verse note] — bracketed content is always chord/annotation, strip unconditionally
  let out = line.replace(/\[[^\]]*\]/g, "");
  // Any parenthetical content — chords like "(G)", ad-libs like "(oh, oh, oh)",
  // repeat markers like "(2x)" — all stripped, not just chord-shaped ones.
  out = out.replace(/\([^)]*\)/g, "");
  out = out.replace(/[ \t]{2,}/g, " ");
  return rejoinHyphenatedSyllables(out);
}

// Chord sheets often hyphenate words to show syllable/note breaks (e.g.
// "af - ter", "fore-ver", or a melisma stretched out as "Glo-- -----ria")
// — column extraction from the PDF also tends to add stray spacing around
// the hyphen. Rejoin these into normal words for the slide text.
//
// Only joins when the fragment right before the dash is short (<=4 chars):
// that reliably matches real syllable fragments ("af", "fore", "spir")
// without also swallowing a real short word followed by a dash used as a
// stylistic pause between two separate phrases (e.g. "Thee - God of glory"
// stays untouched, since "Thee" reads as a complete word either way).
// Applied repeatedly so multi-hyphen chains fully resolve, e.g.
// "sat-is-fy" -> "satis-fy" -> "satisfy".
function rejoinHyphenatedSyllables(text) {
  const pass = (s) =>
    s.replace(/([A-Za-z]+)((?:\s*-+\s*)+)([A-Za-z]+)/g, (m, before, dashes, after) =>
      before.length <= 4 ? before + after : m
    );
  let out = text;
  let next = pass(out);
  let guard = 0;
  while (next !== out && guard++ < 5) {
    out = next;
    next = pass(out);
  }
  return out;
}

function titleCase(s) {
  return s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function parseChordSheet(text) {
  const lines = (text || "").replace(/\r/g, "").split("\n");
  const sections = [];
  let current = { label: "Verse", lines: [] };

  for (let raw of lines) {
    raw = raw.replace(DIRECTIVE_INLINE_RE, "");
    // Chord sheets use a leading *, **, *** etc. to mark alternate/repeat
    // takes of a section — strip it so it doesn't show up as literal text,
    // and so a line that's otherwise just chords (e.g. "* | 5 | 4 |") still
    // gets correctly classified as a chord line below instead of a lyric.
    raw = raw.replace(/^\s*\*+\s*/, "");
    const trimmed = raw.trim();
    const bracketMatch = trimmed.match(/^\[([^\]]+)\]$/);
    let headerText = null;

    if (bracketMatch && SECTION_WORDS.test(bracketMatch[1])) {
      headerText = bracketMatch[1].match(SECTION_WORDS)[1];
    } else if (SECTION_WORDS.test(trimmed)) {
      headerText = trimmed.match(SECTION_WORDS)[1];
    }

    if (headerText) {
      if (current.lines.length) sections.push(current);
      current = { label: titleCase(headerText), lines: [] };
      continue;
    }

    if (trimmed === "") {
      if (current.lines.length && current.lines[current.lines.length - 1] !== null) {
        current.lines.push(null);
      }
      continue;
    }

    if (DIRECTIVE_LINE_RE.test(trimmed)) continue;
    if (isChordLine(trimmed)) continue;

    const lyric = stripInlineChords(raw).trim();
    if (lyric) current.lines.push(lyric);
  }
  if (current.lines.length) sections.push(current);

  sections.forEach((s) => {
    s.lines = s.lines.filter(
      (l, i, arr) => !(l === null && (i === 0 || i === arr.length - 1 || arr[i - 1] === null))
    );
  });

  return sections.filter((s) => s.lines.length);
}

function chunkSection(lines, perSlide) {
  const slides = [];
  let buffer = [];
  for (const l of lines) {
    if (l === null) {
      if (buffer.length) {
        slides.push(buffer);
        buffer = [];
      }
      continue;
    }
    buffer.push(l);
    if (buffer.length >= perSlide) {
      slides.push(buffer);
      buffer = [];
    }
  }
  if (buffer.length) slides.push(buffer);
  return slides;
}

function buildSlides(song) {
  const sections = parseChordSheet(song.rawText);
  const perSlide = song.linesPerSlide || 2;
  const slides = [];
  sections.forEach((s) => {
    chunkSection(s.lines, perSlide).forEach((lines) => {
      slides.push({ section: s.label, lines });
    });
  });
  return slides;
}

function exportText(song) {
  const text = buildSlides(song)
    .map((s) => s.lines.join("\n"))
    .join("\n\n");
  return song.allCaps ? text.toUpperCase() : text;
}

// Rebuilds a plain lyric sheet (section labels + clean lyric lines only,
// chords/directives/asterisks/etc already stripped by parseChordSheet) so
// the editor shows exactly what the slides show, not the raw pasted-in
// chord sheet. Blank lines inside a section (used to force a slide break)
// are preserved as real blank lines.
function toLyricSheetText(rawText) {
  const sections = parseChordSheet(rawText || "");
  return sections
    .map((s) => `${s.label}\n${s.lines.map((l) => (l === null ? "" : l)).join("\n")}`)
    .join("\n\n");
}

// ---------- Shared CDN script loader ----------
// Caches the in-flight/loaded promise on window so repeat calls don't
// re-inject the script — but a failed load clears its own cache entry, so
// the next attempt actually retries instead of replaying the same
// rejection forever (a real problem: without this, one transient network
// blip permanently breaks that export type until the page is reloaded).
function loadScriptOnce(cacheKey, src, getGlobal, errorMessage, onReady) {
  if (window[cacheKey]) return window[cacheKey];

  const promise = new Promise((resolve, reject) => {
    const finish = (value) => {
      try {
        resolve(onReady ? onReady(value) : value);
      } catch (e) {
        reject(e);
      }
    };

    const existing = getGlobal();
    if (existing) {
      finish(existing);
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => {
      const loaded = getGlobal();
      if (!loaded) {
        reject(new Error(errorMessage));
        return;
      }
      finish(loaded);
    };
    script.onerror = () => reject(new Error(errorMessage));
    document.head.appendChild(script);
  });

  promise.catch(() => {
    if (window[cacheKey] === promise) window[cacheKey] = null;
  });

  window[cacheKey] = promise;
  return promise;
}

// ---------- PDF import (client-side, via pdf.js) ----------

const PDFJS_SCRIPT = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

function loadPdfJs() {
  return loadScriptOnce(
    "__pdfjsLoadPromise",
    PDFJS_SCRIPT,
    () => window.pdfjsLib,
    "Couldn't load the PDF reader library.",
    (lib) => {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return lib;
    }
  );
}

function joinRowItems(its) {
  let text = "";
  let prevEnd = null;
  for (const it of its) {
    if (prevEnd !== null && it.x - prevEnd > 1.5) text += " ";
    text += it.str;
    prevEnd = it.x + it.width;
  }
  return cleanExtractedText(text.trim());
}

// Some embedded PDF fonts map ligature glyphs (fi, fl) to control characters
// or drop them entirely instead of proper Unicode — clean up what we can.
function cleanExtractedText(s) {
  return s
    .replace(/\uFB00/g, "ff")
    .replace(/\uFB01/g, "fi")
    .replace(/\uFB02/g, "fl")
    .replace(/\uFB03/g, "ffi")
    .replace(/\uFB04/g, "ffl")
    .replace(/[\u0000-\u001F\u007F]/g, "");
}

// Finds the true gutter between two columns by locating the largest empty
// gap in item x-start positions near the middle of the page — far more
// reliable than assuming a fixed midpoint, since real column starts vary
// (a right column can start well left or right of the page's exact center).
function detectColumnBoundary(items, pageWidth) {
  const loBound = pageWidth * 0.25;
  const hiBound = pageWidth * 0.75;
  const xs = [...new Set(items.map((it) => Math.round(it.x)))].sort((a, b) => a - b);
  let bestGap = 0;
  let boundary = null;
  for (let i = 1; i < xs.length; i++) {
    const mid = (xs[i - 1] + xs[i]) / 2;
    if (mid < loBound || mid > hiBound) continue;
    const gap = xs[i] - xs[i - 1];
    if (gap > bestGap) {
      bestGap = gap;
      boundary = mid;
    }
  }
  // Require a real gutter (not just sparse sampling) before trusting a two-column split
  return bestGap >= pageWidth * 0.03 ? boundary : null;
}

// Groups text items into visual rows, then — if the page is genuinely two
// columns — routes each row's content to the left or right stream based on
// which side of the real gutter it falls on. Streams are concatenated
// left-then-right at the end, so reading order comes out correct even when
// the two columns have a different number of lines (most of the time).
function reconstructColumns(items, pageWidth) {
  // Wide enough to fold superscript chord extensions (maj7, sus4, etc. set
  // a few points above the baseline) back onto their base chord's row,
  // while staying well under the ~10-14pt gap between genuinely different
  // rows (a chord line and the lyric line under it).
  const Y_TOL = 4.5;
  const boundary = detectColumnBoundary(items, pageWidth);

  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const it of sorted) {
    let row = rows.find((r) => Math.abs(r.y - it.y) <= Y_TOL);
    if (!row) {
      row = { y: it.y, items: [] };
      rows.push(row);
    }
    row.items.push(it);
  }
  rows.sort((a, b) => b.y - a.y);

  if (boundary === null) {
    // No confident two-column split — treat the whole page as one column,
    // simple top-to-bottom order.
    const single = rows
      .map((row) => joinRowItems([...row.items].sort((a, c) => a.x - c.x)))
      .filter(Boolean);
    return { left: single, right: [] };
  }

  const left = [];
  const right = [];

  for (const row of rows) {
    const its = [...row.items].sort((a, c) => a.x - c.x);
    const leftPart = its.filter((it) => it.x < boundary);
    const rightPart = its.filter((it) => it.x >= boundary);
    if (leftPart.length) left.push(joinRowItems(leftPart));
    if (rightPart.length) right.push(joinRowItems(rightPart));
  }

  return { left: left.filter(Boolean), right: right.filter(Boolean) };
}

const PDF_FOOTER_RE = /©|publishing|ccli|integrity'?s hosanna|leadworship|lensongs|songselect|copyright|all rights reserved|for use solely/i;
const PDF_META_RE = /^(key|tempo|time)\s*-/i;
// Subtitle line some charts add under the writer credits, e.g.
// "(based on the recording by Elevation Worship, feat. Bella Cordero)"
const PDF_SUBTITLE_RE = /^\(\s*(based on|as recorded by|as performed by)\b/i;

async function extractChordSheetFromPdf(pdfjsLib, arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let allLines = [];
  let hadText = false;

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items
      .map((it) => ({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
        width: it.width || 0,
      }))
      .filter((it) => it.str.trim() !== "");

    if (items.length === 0) continue;
    hadText = true;

    const { left, right } = reconstructColumns(items, viewport.width);
    allLines.push(...left, ...right);
  }

  if (!hadText) return { hadText: false };

  const cleaned = allLines
    .map((l) => l.trim())
    .filter(
      (l) =>
        l &&
        !PDF_FOOTER_RE.test(l) &&
        !PDF_META_RE.test(l) &&
        !PDF_SUBTITLE_RE.test(l) &&
        !/^CCLI Song #/i.test(l)
    );

  let title = "";
  let artist = "";
  let bodyStart = 0;

  if (cleaned.length) {
    title = cleaned[0];
    bodyStart = 1;
    const next = cleaned[1];
    if (next && !SECTION_WORDS.test(next)) {
      const sectionComingNext = cleaned[2] && SECTION_WORDS.test(cleaned[2]);
      const looksLikeAttribution = next.includes("|");
      if (sectionComingNext || looksLikeAttribution) {
        artist = next;
        bodyStart = 2;
      }
    }
  }

  const rawText = cleaned.slice(bodyStart).join("\n");
  return { hadText: true, title, artist, rawText };
}

function loadPptxGenJs() {
  return loadScriptOnce(
    "__pptxgenjsLoadPromise",
    "https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js",
    () => window.PptxGenJS,
    "Couldn't load the slide export library."
  );
}

const PPTX_BG = "10151C";
const PPTX_TEXT = "F2F6FA";
const PPTX_MUTED = "8A96A6";

function addSongToPresentation(pres, song) {
  const fontOpt = FONT_OPTIONS.find((f) => f.value === song.fontFamily) || FONT_OPTIONS[0];
  const FONT = fontOpt.pptxName;
  const slides = buildSlides(song);
  const caseText = (t) => (song.allCaps ? t.toUpperCase() : t);

  const title = pres.addSlide();
  title.background = { color: PPTX_BG };
  title.addText(caseText(song.title), {
    x: 0.8, y: 3.05, w: 11.7, h: 1.4,
    fontFace: FONT, fontSize: 44, bold: true, color: PPTX_TEXT, align: "center", margin: 0,
  });

  slides.forEach((s, i) => {
    const slide = pres.addSlide();
    slide.background = { color: PPTX_BG };

    if (song.showLabels === true) {
      slide.addText(`${s.section.toUpperCase()}  ·  ${i + 1}/${slides.length}`, {
        x: 0.6, y: 0.4, w: 8, h: 0.4,
        fontFace: "Courier New", fontSize: 11, color: PPTX_MUTED, charSpacing: 2, margin: 0,
      });
    }

    const lineText = s.lines.map((l, idx) => ({
      text: caseText(l),
      options: idx < s.lines.length - 1 ? { breakLine: true } : {},
    }));

    slide.addText(lineText, {
      x: 0.8, y: 0, w: 11.7, h: 7.5,
      fontFace: FONT,
      fontSize: song.fontSize || DEFAULT_FONT_SIZE,
      bold: true,
      color: PPTX_TEXT,
      align: "center",
      valign: "middle",
      lineSpacingMultiple: 1.3,
      margin: 0,
    });
  });
}

function safeFileName(name, fallback) {
  return name.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "") || fallback;
}

async function downloadSongAsPptx(song) {
  const PptxGenJS = await loadPptxGenJs();
  const pres = new PptxGenJS();
  pres.layout = "LAYOUT_WIDE";
  addSongToPresentation(pres, song);
  await pres.writeFile({ fileName: `${safeFileName(song.title || "song", "song")}.pptx` });
}

async function downloadSetlistAsPptx(setlist, songs) {
  const PptxGenJS = await loadPptxGenJs();
  const pres = new PptxGenJS();
  pres.layout = "LAYOUT_WIDE";
  // A uniform format is applied only to this export — it never mutates the
  // song objects themselves, so each song's own settings in the library
  // (and in any other setlist) are untouched.
  songs.forEach((song) => {
    const exportSong = setlist.format ? { ...song, ...setlist.format } : song;
    addSongToPresentation(pres, exportSong);
  });
  await pres.writeFile({ fileName: `${safeFileName(setlist.name || "setlist", "setlist")}.pptx` });
}

// ---------- Chord sheet PDF export (via jsPDF, CDN-loaded) ----------

function loadJsPdf() {
  return loadScriptOnce(
    "__jspdfLoadPromise",
    "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
    () => window.jspdf,
    "Couldn't load the PDF export library."
  );
}

// Draws one song's typeset chord sheet (title + artist + rawText, wrapped
// and paginated) into a jsPDF document, starting at whatever page is
// currently active. Used both as the fallback for songs with no original
// PDF, and as the whole-library export for a single song's "text" version.
function drawChordSheetPages(doc, song) {
  const margin = 54;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const maxWidth = pageWidth - margin * 2;
  const lineHeight = 13;
  let y = margin;

  doc.setFont("courier", "bold");
  doc.setFontSize(16);
  doc.text(song.title || "Untitled", margin, y);
  y += 20;

  if (song.artist) {
    doc.setFont("courier", "normal");
    doc.setFontSize(11);
    doc.setTextColor(110, 110, 110);
    doc.text(song.artist, margin, y);
    doc.setTextColor(0, 0, 0);
    y += 22;
  } else {
    y += 10;
  }

  doc.setFont("courier", "normal");
  doc.setFontSize(10.5);
  const rawLines = (song.rawText || "").replace(/\r/g, "").split("\n");
  for (const line of rawLines) {
    const wrapped = doc.splitTextToSize(line.length ? line : " ", maxWidth);
    for (const w of wrapped) {
      if (y > pageHeight - margin) {
        doc.addPage();
        y = margin;
      }
      doc.text(w, margin, y);
      y += lineHeight;
    }
  }
}

async function buildTypesetChordSheetBytes(song) {
  const { jsPDF } = await loadJsPdf();
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  drawChordSheetPages(doc, song);
  return doc.output("arraybuffer");
}

// ---------- PDF merging (via pdf-lib, CDN-loaded) ----------

function loadPdfLib() {
  return loadScriptOnce(
    "__pdflibLoadPromise",
    "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js",
    () => window.PDFLib,
    "Couldn't load the PDF merge library."
  );
}

function downloadBytesAsFile(bytes, fileName) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Builds one combined PDF for the setlist: each song contributes its
// original chord-sheet PDF (as uploaded on import) where one exists, or a
// typeset fallback page built from its stored lyrics/chords otherwise —
// so every song in the setlist ends up in the download either way.
async function downloadSetlistChordSheetsAsPdf(setlist, songs) {
  const { PDFDocument } = await loadPdfLib();
  const merged = await PDFDocument.create();

  for (const song of songs) {
    let bytes;
    if (song.pdfPath) {
      const res = await fetch(pdfPublicUrl(song.pdfPath));
      if (!res.ok) throw new Error(`Couldn't fetch the original PDF for "${song.title}".`);
      bytes = await res.arrayBuffer();
    } else {
      bytes = await buildTypesetChordSheetBytes(song);
    }
    const srcDoc = await PDFDocument.load(bytes);
    const pages = await merged.copyPages(srcDoc, srcDoc.getPageIndices());
    pages.forEach((p) => merged.addPage(p));
  }

  const mergedBytes = await merged.save();
  downloadBytesAsFile(mergedBytes, `${safeFileName(setlist.name || "setlist", "setlist")}-chord-sheets.pdf`);
}

// ---------- Storage helpers ----------
// SHARED library: every song is stored with shared=true, so anyone using this
// artifact sees and can edit the same library, not a private copy per person.

async function listSongs() {
  const idx = await window.storage.list("songs:", true);
  if (!idx || !idx.keys || idx.keys.length === 0) return [];
  const out = [];
  for (const raw of idx.values) {
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw));
    } catch (e) {
      // skip unreadable entry
    }
  }
  out.sort((a, b) => a.title.localeCompare(b.title));
  return out;
}

async function saveSongToStorage(song) {
  await window.storage.set(`songs:${song.id}`, JSON.stringify(song), true);
}

async function deleteSongFromStorage(id) {
  await window.storage.delete(`songs:${id}`, true);
}

// A setlist is just { id, name, songIds } — an ordered list of song ids,
// resolved against the song library at render/export time.
async function listSetlists() {
  const idx = await window.storage.list("setlists:", true);
  if (!idx || !idx.keys || idx.keys.length === 0) return [];
  const out = [];
  for (const raw of idx.values) {
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw));
    } catch (e) {
      // skip unreadable entry
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function saveSetlistToStorage(setlist) {
  await window.storage.set(`setlists:${setlist.id}`, JSON.stringify(setlist), true);
}

async function deleteSetlistFromStorage(id) {
  await window.storage.delete(`setlists:${id}`, true);
}

function pdfPublicUrl(pdfPath) {
  return `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/${pdfPath}`;
}

// ---------- UI ----------

// Fraunces/Playfair Display/Bitter/Work Sans/Georgia/Verdana are no longer
// selectable (see FONT_OPTIONS below) but stay loaded here so any song that
// already had one of them picked keeps rendering the same way.
const FONTS = `
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;600&family=Montserrat:wght@600;700&family=Playfair+Display:wght@600;700&family=Bitter:wght@600;700&family=Poppins:wght@600;700&family=Work+Sans:wght@600;700&family=Barlow+Condensed:wght@600;700&display=swap');
`;

const FONT_OPTIONS = [
  { label: "Montserrat", value: "'Montserrat', sans-serif", pptxName: "Montserrat", safe: false },
  { label: "Bebas Neue", value: "'Bebas Neue', sans-serif", pptxName: "Bebas Neue", safe: false },
  { label: "Helvetica / Arial", value: "Helvetica, Arial, sans-serif", pptxName: "Arial", safe: true },
  { label: "Poppins", value: "'Poppins', sans-serif", pptxName: "Poppins", safe: false },
  { label: "Barlow Condensed", value: "'Barlow Condensed', sans-serif", pptxName: "Barlow Condensed", safe: false },
];

const DEFAULT_FONT_FAMILY = FONT_OPTIONS[0].value; // Georgia
const DEFAULT_FONT_SIZE = 28; // pt
// Preview cards are scaled-down stand-ins for the real slide, so preview px
// tracks the chosen point size proportionally.
const MAIN_PREVIEW_RATIO = 16 / 36;
const MINI_PREVIEW_RATIO = 10.5 / 36;

const TOKENS = {
  paper: "#EFF4F9",
  paperDeep: "#E1EAF4",
  ink: "#1E2B3A",
  inkSoft: "#5C6B7C",
  rule: "#C7D4E1",
  accent: "#2C5C8A",
  accentSoft: "#4A7CAA",
  screen: "#10151C",
  screenText: "#F2F6FA",
  danger: "#B0403A",
  info: "#3A6EA5",
  infoBg: "#DCE7F2",
};

function EmptyLibrary({ onAdd, onImport }) {
  return (
    <div style={{ padding: "48px 24px", textAlign: "center" }}>
      <Music4 size={28} color={TOKENS.inkSoft} strokeWidth={1.5} />
      <p style={{ fontFamily: "Inter", fontSize: 13, color: TOKENS.inkSoft, marginTop: 12, lineHeight: 1.6 }}>
        No songs yet. Paste a chord sheet or import a PDF to start your library.
      </p>
      <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 12, flexWrap: "wrap" }}>
        <button onClick={onAdd} style={styles.primaryBtnSmall}>
          <Plus size={14} /> Paste lyrics
        </button>
        <button onClick={onImport} style={styles.ghostBtnSmall}>
          <Upload size={13} /> Import PDF
        </button>
      </div>
    </div>
  );
}

function SongForm({ initial, onCancel, onSave, saving }) {
  const [title, setTitle] = useState(initial?.title || "");
  const [artist, setArtist] = useState(initial?.artist || "");
  const [rawText, setRawText] = useState(() => (initial?.rawText ? toLyricSheetText(initial.rawText) : ""));
  const [linesPerSlide, setLinesPerSlide] = useState(initial?.linesPerSlide || 2);
  const [fontFamily, setFontFamily] = useState(initial?.fontFamily || DEFAULT_FONT_FAMILY);
  const [fontSize, setFontSize] = useState(initial?.fontSize || DEFAULT_FONT_SIZE);
  const [showLabels, setShowLabels] = useState(initial?.showLabels === true);
  const [allCaps, setAllCaps] = useState(initial?.allCaps === true);
  const [copied, setCopied] = useState(false);
  const canSave = title.trim().length > 0 && rawText.trim().length > 0;

  const preview = useMemo(() => {
    if (!rawText.trim()) return [];
    return buildSlides({ rawText, linesPerSlide });
  }, [rawText, linesPerSlide]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(exportText({ rawText, linesPerSlide, allCaps }));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (e) {
      // clipboard blocked — no-op, button just won't confirm
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 720 }}>
      {initial?.__importNote && (
        <div style={styles.infoBanner}>{initial.__importNote}</div>
      )}

      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ flex: 2 }}>
          <label style={styles.label}>Title</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Amazing Grace"
            style={styles.input}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={styles.label}>Artist / origin</label>
          <input
            value={artist}
            onChange={(e) => setArtist(e.target.value)}
            placeholder="Traditional"
            style={styles.input}
          />
        </div>
      </div>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <label style={styles.label}>Lyric sheet</label>
          <span style={{ fontFamily: "Inter", fontSize: 11, color: TOKENS.inkSoft }}>
            Exactly what shows on your slides — chords get stripped automatically if you paste some in
          </span>
        </div>
        <textarea
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          placeholder={"Verse\nAmazing grace, how sweet the sound\n..."}
          style={styles.textarea}
          rows={12}
        />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <label style={styles.label}>Lines per slide</label>
        <NumberStepper value={linesPerSlide} onChange={setLinesPerSlide} min={1} max={8} />
        <span style={{ fontFamily: "Inter", fontSize: 12, color: TOKENS.inkSoft }}>
          {preview.length} slide{preview.length === 1 ? "" : "s"} at this setting
        </span>
      </div>
      <p style={{ fontFamily: "Inter", fontSize: 11.5, color: TOKENS.inkSoft, marginTop: -12, lineHeight: 1.5 }}>
        Tip: leave a blank line between phrases above to force a slide break there, no matter
        what number you set here — handy for one section that needs shorter slides than the rest.
      </p>

      <div style={{ display: "flex", alignItems: "flex-end", gap: 20, flexWrap: "wrap" }}>
        <div>
          <label style={styles.label}>Font</label>
          <select
            value={fontFamily}
            onChange={(e) => setFontFamily(e.target.value)}
            style={styles.select}
          >
            {FONT_OPTIONS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={styles.label}>Font size</label>
          <NumberStepper value={fontSize} onChange={setFontSize} min={20} max={60} step={2} />
        </div>
        <div>
          <label style={styles.label}>Section labels</label>
          <ToggleSwitch value={showLabels} onChange={setShowLabels} onLabel="Shown" offLabel="Hidden" />
        </div>
        <div>
          <label style={styles.label}>All caps</label>
          <ToggleSwitch value={allCaps} onChange={setAllCaps} onLabel="On" offLabel="Off" />
        </div>
      </div>

      {preview.length > 0 && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <label style={styles.label}>Live preview</label>
            <button onClick={handleCopy} style={styles.ghostBtnSmall}>
              <Copy size={13} /> {copied ? "Copied!" : "Copy as text"}
            </button>
          </div>
          <div style={styles.previewStrip}>
            {preview.slice(0, 6).map((s, i) => (
              <MiniScreen key={i} slide={s} fontFamily={fontFamily} fontSize={fontSize} showLabels={showLabels} allCaps={allCaps} />
            ))}
            {preview.length > 6 && (
              <div style={{ ...styles.screen, ...styles.screenSmall, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ fontFamily: "Inter", fontSize: 12, color: TOKENS.screenText, opacity: 0.6 }}>
                  +{preview.length - 6} more
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
        <button
          disabled={!canSave || saving}
          onClick={() =>
            onSave({
              title: title.trim(),
              artist: artist.trim(),
              rawText,
              linesPerSlide,
              fontFamily,
              fontSize,
              showLabels,
              allCaps,
            })
          }
          style={{ ...styles.primaryBtn, opacity: canSave && !saving ? 1 : 0.5 }}
        >
          {saving ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
          {saving ? "Saving…" : "Save song"}
        </button>
        <button onClick={onCancel} style={styles.ghostBtn}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function NumberStepper({ value, onChange, min = 1, max = 8, step = 1 }) {
  const clamp = (n) => Math.max(min, Math.min(max, n));
  return (
    <div style={styles.stepper}>
      <button
        onClick={() => onChange(clamp(value - step))}
        disabled={value <= min}
        style={{ ...styles.stepperBtn, opacity: value <= min ? 0.4 : 1 }}
      >
        −
      </button>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (!Number.isNaN(n)) onChange(clamp(n));
        }}
        style={styles.stepperInput}
      />
      <button
        onClick={() => onChange(clamp(value + step))}
        disabled={value >= max}
        style={{ ...styles.stepperBtn, opacity: value >= max ? 0.4 : 1 }}
      >
        +
      </button>
    </div>
  );
}

function ToggleSwitch({ value, onChange, onLabel = "On", offLabel = "Off" }) {
  return (
    <button
      role="switch"
      aria-checked={value}
      title={value ? onLabel : offLabel}
      onClick={() => onChange(!value)}
      style={{ ...styles.switchTrack, background: value ? TOKENS.accent : "#fff" }}
    >
      <span style={{ ...styles.switchKnob, left: value ? 22 : 2, background: value ? "#fff" : TOKENS.inkSoft }} />
    </button>
  );
}

function MiniScreen({ slide, fontFamily, fontSize, showLabels, allCaps }) {
  return (
    <div style={{ ...styles.screen, ...styles.screenSmall }}>
      {showLabels && <span style={styles.eyebrow}>{slide.section}</span>}
      <div
        style={{
          ...styles.screenLinesSmall,
          fontFamily: fontFamily || DEFAULT_FONT_FAMILY,
          fontSize: (fontSize || DEFAULT_FONT_SIZE) * MINI_PREVIEW_RATIO,
          textTransform: allCaps ? "uppercase" : "none",
        }}
      >
        {slide.lines.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </div>
    </div>
  );
}

function SongPreview({ song, onEdit, onDelete, onUpdateSettings, confirmingDelete, hideDelete = false }) {
  const slides = useMemo(() => buildSlides(song), [song]);
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(null);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(exportText(song));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (e) {
      // clipboard blocked — no-op, button just won't confirm
    }
  };

  const handleDownload = async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      await downloadSongAsPptx(song);
    } catch (e) {
      setDownloadError("Couldn't build the PowerPoint file. Try again.");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 4 }}>
        <div>
          <h2 style={styles.songTitle}>{song.title}</h2>
          {song.artist && <div style={styles.songArtist}>{song.artist}</div>}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onEdit} style={styles.iconBtn} title="Edit">
            <Pencil size={15} />
          </button>
          {!hideDelete && (
            <button
              onClick={onDelete}
              style={{ ...styles.iconBtn, ...(confirmingDelete ? styles.iconBtnDanger : {}) }}
              title="Delete"
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </div>
      {!hideDelete && confirmingDelete && (
        <div style={{ fontFamily: "Inter", fontSize: 12, color: TOKENS.danger, marginBottom: 12 }}>
          Click delete again to permanently remove this song.
        </div>
      )}

      <div style={{ display: "flex", alignItems: "flex-end", gap: 20, margin: "16px 0 12px", flexWrap: "wrap" }}>
        <div>
          <label style={styles.label}>Lines per slide</label>
          <NumberStepper
            value={song.linesPerSlide || 2}
            onChange={(n) => onUpdateSettings({ linesPerSlide: n })}
            min={1}
            max={8}
          />
        </div>
        <div>
          <label style={styles.label}>Font</label>
          <select
            value={song.fontFamily || DEFAULT_FONT_FAMILY}
            onChange={(e) => onUpdateSettings({ fontFamily: e.target.value })}
            style={styles.select}
          >
            {FONT_OPTIONS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={styles.label}>Font size</label>
          <NumberStepper
            value={song.fontSize || DEFAULT_FONT_SIZE}
            onChange={(n) => onUpdateSettings({ fontSize: n })}
            min={20}
            max={60}
            step={2}
          />
        </div>
        <div>
          <label style={styles.label}>Section labels</label>
          <ToggleSwitch
            value={song.showLabels === true}
            onChange={(v) => onUpdateSettings({ showLabels: v })}
            onLabel="Shown"
            offLabel="Hidden"
          />
        </div>
        <div>
          <label style={styles.label}>All caps</label>
          <ToggleSwitch
            value={song.allCaps === true}
            onChange={(v) => onUpdateSettings({ allCaps: v })}
            onLabel="On"
            offLabel="Off"
          />
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <span style={{ fontFamily: "Inter", fontSize: 12, color: TOKENS.inkSoft }}>
          {slides.length} slide{slides.length === 1 ? "" : "s"}
        </span>
        <div style={{ flex: 1 }} />
        {song.pdfPath && (
          <a
            href={pdfPublicUrl(song.pdfPath)}
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...styles.ghostBtnSmall, textDecoration: "none" }}
          >
            <FileText size={13} /> View original PDF
          </a>
        )}
        <button onClick={handleCopy} style={styles.ghostBtnSmall}>
          <Copy size={13} /> {copied ? "Copied!" : "Copy as text"}
        </button>
        <button onClick={handleDownload} disabled={downloading} style={{ ...styles.primaryBtnSmall, opacity: downloading ? 0.6 : 1 }}>
          {downloading ? <Loader2 size={13} className="spin" /> : <Download size={13} />}
          {downloading ? "Building…" : "Download .pptx"}
        </button>
      </div>
      {downloadError && (
        <div style={{ ...styles.errorBanner, marginTop: 0, marginBottom: 16 }}>{downloadError}</div>
      )}
      <div style={{ marginBottom: 12 }} />

      <div style={styles.screenGrid}>
        {slides.map((s, i) => (
          <div key={i} style={styles.screen}>
            {song.showLabels === true && (
              <span style={styles.eyebrow}>
                {s.section} · {i + 1}/{slides.length}
              </span>
            )}
            <div
              style={{
                ...styles.screenLines,
                fontFamily: song.fontFamily || DEFAULT_FONT_FAMILY,
                fontSize: (song.fontSize || DEFAULT_FONT_SIZE) * MAIN_PREVIEW_RATIO,
                textTransform: song.allCaps ? "uppercase" : "none",
              }}
            >
              {s.lines.map((l, j) => (
                <div key={j}>{l}</div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <p style={{ fontFamily: "Inter", fontSize: 11.5, color: TOKENS.inkSoft, marginTop: 20, lineHeight: 1.6 }}>
        "Download .pptx" builds a PowerPoint file right in your browser, matching this song's font,
        size, and label settings — no need to leave the app. "Copy as text" gives one slide per
        block for pasting into ProPresenter, EasyWorship, or similar.
      </p>
    </div>
  );
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function SetlistBuilder({ initial, allSongs, onCancel, onSave, onDelete, onUpdateSong, saving, confirmingDelete }) {
  const [name, setName] = useState(initial?.name || "");
  const [date, setDate] = useState(initial?.date || todayIsoDate());
  const [songIds, setSongIds] = useState(initial?.songIds || []);
  const [query, setQuery] = useState("");
  const [downloadingPptx, setDownloadingPptx] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [downloadError, setDownloadError] = useState(null);
  const [expandedSongId, setExpandedSongId] = useState(null);
  const [editingSongId, setEditingSongId] = useState(null);
  const [savingSongId, setSavingSongId] = useState(null);
  const [draggedIndex, setDraggedIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);

  const [useUniformFormat, setUseUniformFormat] = useState(!!initial?.format);
  const [formatFontFamily, setFormatFontFamily] = useState(initial?.format?.fontFamily || DEFAULT_FONT_FAMILY);
  const [formatFontSize, setFormatFontSize] = useState(initial?.format?.fontSize || DEFAULT_FONT_SIZE);
  const [formatShowLabels, setFormatShowLabels] = useState(initial?.format?.showLabels === true);
  const [formatAllCaps, setFormatAllCaps] = useState(initial?.format?.allCaps === true);
  const uniformFormat = useUniformFormat
    ? { fontFamily: formatFontFamily, fontSize: formatFontSize, showLabels: formatShowLabels, allCaps: formatAllCaps }
    : null;

  const songById = useMemo(() => {
    const m = new Map();
    allSongs.forEach((s) => m.set(s.id, s));
    return m;
  }, [allSongs]);

  const orderedSongs = songIds.map((id) => songById.get(id)).filter(Boolean);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return allSongs
      .filter((s) => !songIds.includes(s.id))
      .filter((s) => s.title.toLowerCase().includes(q) || (s.artist || "").toLowerCase().includes(q))
      .slice(0, 8);
  }, [query, allSongs, songIds]);

  const addSong = (id) => {
    setSongIds((prev) => [...prev, id]);
    setQuery("");
  };
  const removeSong = (id) => setSongIds((prev) => prev.filter((x) => x !== id));
  const moveSong = (index, dir) => {
    setSongIds((prev) => {
      const next = [...prev];
      const j = index + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });
  };
  const moveSongTo = (fromIndex, toIndex) => {
    if (fromIndex === toIndex) return;
    setSongIds((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  };

  const canSave = name.trim().length > 0 && songIds.length > 0;

  const toggleExpanded = (id) => {
    setEditingSongId(null);
    setExpandedSongId((prev) => (prev === id ? null : id));
  };

  const handleInlineSongSave = async (song, data) => {
    setSavingSongId(song.id);
    try {
      await onUpdateSong({ ...song, ...data });
      setEditingSongId(null);
    } finally {
      setSavingSongId(null);
    }
  };

  const handleInlineSongSettings = async (song, patch) => {
    await onUpdateSong({ ...song, ...patch });
  };

  const handleDownloadPptx = async () => {
    setDownloadingPptx(true);
    setDownloadError(null);
    try {
      await downloadSetlistAsPptx({ name: name.trim() || "setlist", format: uniformFormat }, orderedSongs);
    } catch (e) {
      setDownloadError("Couldn't build the PowerPoint file. Try again.");
    } finally {
      setDownloadingPptx(false);
    }
  };

  const handleDownloadPdf = async () => {
    setDownloadingPdf(true);
    setDownloadError(null);
    try {
      await downloadSetlistChordSheetsAsPdf({ name: name.trim() || "setlist" }, orderedSongs);
    } catch (e) {
      setDownloadError("Couldn't build the chord sheet PDF. Try again.");
    } finally {
      setDownloadingPdf(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 720 }}>
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ flex: 2 }}>
          <label style={styles.label}>Setlist name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Sunday service — Aug 9"
            style={styles.input}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={styles.label}>Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={styles.input} />
        </div>
      </div>

      <div>
        <label style={styles.label}>Add songs</label>
        <div style={styles.searchWrap}>
          <Search size={14} color={TOKENS.inkSoft} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title or artist"
            style={styles.searchInput}
          />
        </div>
        {results.length > 0 && (
          <div style={styles.setlistResults}>
            {results.map((s, i) => (
              <button
                key={s.id}
                onClick={() => addSong(s.id)}
                style={{
                  ...styles.setlistResultItem,
                  ...(i < results.length - 1 ? { borderBottom: `1px solid ${TOKENS.rule}` } : {}),
                }}
              >
                <div>
                  <div style={styles.songItemTitle}>{s.title}</div>
                  {s.artist && <div style={styles.songItemArtist}>{s.artist}</div>}
                </div>
                <Plus size={14} />
              </button>
            ))}
          </div>
        )}
      </div>

      <div>
        <label style={styles.label}>
          Order ({orderedSongs.length} song{orderedSongs.length === 1 ? "" : "s"})
        </label>
        {orderedSongs.length === 0 && (
          <p style={{ fontFamily: "Inter", fontSize: 12.5, color: TOKENS.inkSoft }}>
            Search above and add songs to build the order.
          </p>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {orderedSongs.map((s, i) => (
            <div
              key={s.id}
              draggable
              onDragStart={(e) => {
                setDraggedIndex(i);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (draggedIndex === null || draggedIndex === i) return;
                setDragOverIndex(i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (draggedIndex !== null && draggedIndex !== i) moveSongTo(draggedIndex, i);
                setDraggedIndex(null);
                setDragOverIndex(null);
              }}
              onDragEnd={() => {
                setDraggedIndex(null);
                setDragOverIndex(null);
              }}
              style={{ opacity: draggedIndex === i ? 0.4 : 1 }}
            >
              <div
                style={{
                  ...styles.setlistRow,
                  ...(dragOverIndex === i && draggedIndex !== i ? styles.setlistRowDragOver : {}),
                }}
              >
                <span style={styles.setlistDragHandle} title="Drag to reorder">
                  <GripVertical size={14} />
                </span>
                <span style={styles.setlistRowIndex}>{i + 1}</span>
                <button
                  onClick={() => toggleExpanded(s.id)}
                  style={{ ...styles.setlistRowTitle, flex: 1 }}
                  title="Preview slides"
                >
                  <div style={styles.songItemTitle}>{s.title}</div>
                  {s.artist && <div style={styles.songItemArtist}>{s.artist}</div>}
                </button>
                <button onClick={() => toggleExpanded(s.id)} style={styles.iconBtn} title="Preview slides">
                  {expandedSongId === s.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </button>
                <button
                  onClick={() => moveSong(i, -1)}
                  disabled={i === 0}
                  style={{ ...styles.iconBtn, opacity: i === 0 ? 0.4 : 1 }}
                  title="Move up"
                >
                  <ArrowUp size={13} />
                </button>
                <button
                  onClick={() => moveSong(i, 1)}
                  disabled={i === orderedSongs.length - 1}
                  style={{ ...styles.iconBtn, opacity: i === orderedSongs.length - 1 ? 0.4 : 1 }}
                  title="Move down"
                >
                  <ArrowDown size={13} />
                </button>
                <button onClick={() => removeSong(s.id)} style={styles.iconBtn} title="Remove">
                  <X size={13} />
                </button>
              </div>

              {expandedSongId === s.id && (
                <div style={styles.setlistExpanded}>
                  {editingSongId === s.id ? (
                    <SongForm
                      key={`inline-edit-${s.id}`}
                      initial={s}
                      onCancel={() => setEditingSongId(null)}
                      onSave={(data) => handleInlineSongSave(s, data)}
                      saving={savingSongId === s.id}
                    />
                  ) : (
                    <SongPreview
                      song={s}
                      onEdit={() => setEditingSongId(s.id)}
                      onUpdateSettings={(patch) => handleInlineSongSettings(s, patch)}
                      hideDelete
                    />
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <label style={styles.label}>Uniform PowerPoint format</label>
          <ToggleSwitch value={useUniformFormat} onChange={setUseUniformFormat} onLabel="On" offLabel="Off" />
        </div>
        {useUniformFormat ? (
          <div style={{ display: "flex", alignItems: "flex-end", gap: 20, flexWrap: "wrap", marginTop: 10 }}>
            <div>
              <label style={styles.label}>Font</label>
              <select
                value={formatFontFamily}
                onChange={(e) => setFormatFontFamily(e.target.value)}
                style={styles.select}
              >
                {FONT_OPTIONS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={styles.label}>Font size</label>
              <NumberStepper value={formatFontSize} onChange={setFormatFontSize} min={20} max={60} step={2} />
            </div>
            <div>
              <label style={styles.label}>Section labels</label>
              <ToggleSwitch value={formatShowLabels} onChange={setFormatShowLabels} onLabel="Shown" offLabel="Hidden" />
            </div>
            <div>
              <label style={styles.label}>All caps</label>
              <ToggleSwitch value={formatAllCaps} onChange={setFormatAllCaps} onLabel="On" offLabel="Off" />
            </div>
          </div>
        ) : (
          <p style={{ fontFamily: "Inter", fontSize: 11.5, color: TOKENS.inkSoft, marginTop: 6, lineHeight: 1.5 }}>
            Off — the combined .pptx uses each song's own font/size/label settings, so a mixed-format
            deck is possible. Turn this on to force one look across every slide for this setlist only;
            it never changes the songs' own settings in your library.
          </p>
        )}
      </div>

      {downloadError && <div style={{ ...styles.errorBanner, marginBottom: 0 }}>{downloadError}</div>}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button
          disabled={!canSave || saving}
          onClick={() => onSave({ name: name.trim(), date, songIds, format: uniformFormat })}
          style={{ ...styles.primaryBtn, opacity: canSave && !saving ? 1 : 0.5 }}
        >
          {saving ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
          {saving ? "Saving…" : "Save setlist"}
        </button>
        <button onClick={onCancel} style={styles.ghostBtn}>
          Cancel
        </button>
        {initial && (
          <button
            onClick={onDelete}
            style={{
              ...styles.ghostBtn,
              ...(confirmingDelete ? { borderColor: TOKENS.danger, color: TOKENS.danger } : {}),
            }}
          >
            {confirmingDelete ? "Click again to delete" : "Delete setlist"}
          </button>
        )}
      </div>

      {orderedSongs.length > 0 && (
        <div style={{ borderTop: `1px solid ${TOKENS.rule}`, paddingTop: 16, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            onClick={handleDownloadPptx}
            disabled={downloadingPptx}
            style={{ ...styles.primaryBtnSmall, opacity: downloadingPptx ? 0.6 : 1 }}
          >
            {downloadingPptx ? <Loader2 size={13} className="spin" /> : <Download size={13} />}
            {downloadingPptx ? "Building…" : "Download combined .pptx"}
          </button>
          <button
            onClick={handleDownloadPdf}
            disabled={downloadingPdf}
            style={{ ...styles.ghostBtnSmall, opacity: downloadingPdf ? 0.6 : 1 }}
          >
            {downloadingPdf ? <Loader2 size={13} className="spin" /> : <FileText size={13} />}
            {downloadingPdf ? "Building…" : "Download chord sheets .pdf"}
          </button>
        </div>
      )}

      <p style={{ fontFamily: "Inter", fontSize: 11.5, color: TOKENS.inkSoft, marginTop: 4, lineHeight: 1.6 }}>
        The combined .pptx has each song's title and lyric slides back to back, in this order —
        load it once for the whole service. The chord sheet PDF has one song's original
        chords-and-lyrics per page, for the band to read from.
      </p>
    </div>
  );
}

function formatHistoryDate(iso) {
  if (!iso) return "Never";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function HistoryView({ songs, setlists }) {
  const [sortMode, setSortMode] = useState("frequency"); // 'frequency' | 'recent'

  const stats = useMemo(() => {
    const usageBySongId = new Map();
    setlists.forEach((sl) => {
      (sl.songIds || []).forEach((id) => {
        if (!usageBySongId.has(id)) usageBySongId.set(id, []);
        usageBySongId.get(id).push(sl.date || null);
      });
    });

    return songs
      .map((s) => {
        const dates = (usageBySongId.get(s.id) || []).filter(Boolean).sort().reverse();
        return { song: s, count: usageBySongId.get(s.id)?.length || 0, lastUsed: dates[0] || null };
      })
      .sort((a, b) => {
        if (sortMode === "frequency") {
          if (b.count !== a.count) return b.count - a.count;
          return (b.lastUsed || "").localeCompare(a.lastUsed || "");
        }
        if (a.lastUsed && b.lastUsed) return b.lastUsed.localeCompare(a.lastUsed);
        if (a.lastUsed) return -1;
        if (b.lastUsed) return 1;
        return b.count - a.count;
      });
  }, [songs, setlists, sortMode]);

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <h2 style={styles.songTitle}>Song History</h2>
        <div style={styles.toggleGroup}>
          <button
            onClick={() => setSortMode("frequency")}
            style={{ ...styles.toggleBtn, ...(sortMode === "frequency" ? styles.toggleBtnActive : {}) }}
          >
            Most used
          </button>
          <button
            onClick={() => setSortMode("recent")}
            style={{ ...styles.toggleBtn, ...(sortMode === "recent" ? styles.toggleBtnActive : {}) }}
          >
            Most recent
          </button>
        </div>
      </div>

      {setlists.length === 0 ? (
        <p style={{ fontFamily: "Inter", fontSize: 13, color: TOKENS.inkSoft, lineHeight: 1.6 }}>
          No setlists saved yet — once you build and save dated setlists, this tracks how often
          and how recently each song's been used.
        </p>
      ) : (
        <div style={styles.historyList}>
          {stats.map(({ song, count, lastUsed }) => (
            <div key={song.id} style={styles.historyRow}>
              <div style={{ flex: 1 }}>
                <div style={styles.songItemTitle}>{song.title}</div>
                {song.artist && <div style={styles.songItemArtist}>{song.artist}</div>}
              </div>
              <div style={styles.historyStat}>
                <span style={styles.historyCount}>{count}</span>
                <span style={styles.historyCountLabel}>{count === 1 ? "time" : "times"}</span>
              </div>
              <div style={styles.historyLastUsed}>{formatHistoryDate(lastUsed)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Client-side gate only — a light deterrent so the link isn't wide open,
// not real security (anyone with devtools can read GATE_PASSWORD). Change
// it here whenever needed.
const GATE_PASSWORD = "romans12";
const GATE_STORAGE_KEY = "worship-slide-library:unlocked";

function PasswordGate({ onUnlock }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [shake, setShake] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (password === GATE_PASSWORD) {
      try {
        localStorage.setItem(GATE_STORAGE_KEY, "true");
      } catch (err) {
        // localStorage unavailable — unlock still works for this session
      }
      setLeaving(true);
      setTimeout(onUnlock, 320);
    } else {
      setError(true);
      setShake(true);
      setTimeout(() => setShake(false), 420);
    }
  };

  return (
    <div style={{ ...styles.gateWrap, opacity: leaving ? 0 : 1 }}>
      <style>{FONTS}{`
        * { box-sizing: border-box; }
        input::placeholder { color: ${TOKENS.inkSoft}; opacity: 0.55; }
        input:focus { outline: none; border-color: ${TOKENS.accentSoft}; }
        button { cursor: pointer; font-family: 'Inter', sans-serif; }
        @keyframes gateIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes gateShake {
          10%, 90% { transform: translateX(-2px); }
          20%, 80% { transform: translateX(4px); }
          30%, 50%, 70% { transform: translateX(-8px); }
          40%, 60% { transform: translateX(8px); }
        }
        .gate-card { animation: gateIn 0.55s cubic-bezier(0.16, 1, 0.3, 1) both; }
        .gate-card.shake { animation: gateShake 0.42s ease; }
      `}</style>
      <div className={`gate-card${shake ? " shake" : ""}`} style={styles.gateCard}>
        <Music4 size={26} color={TOKENS.accent} strokeWidth={2} />
        <h1 style={styles.gateTitle}>build your set</h1>
        <p style={styles.gateSubtitle}>
          for the last minute scramble. put together your setlist and presentation in seconds.
          <br />
          <small>note: when importing a new song, make sure the chords are numbers!</small>
        </p>
        <form onSubmit={handleSubmit} style={styles.gateForm}>
          <input
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(false);
            }}
            placeholder="Password"
            style={styles.gateInput}
            autoFocus
          />
          <button type="submit" style={styles.primaryBtn}>
            Enter
          </button>
        </form>
        {error && <p style={styles.gateError}>Incorrect password — try again.</p>}
      </div>
    </div>
  );
}

export default function WorshipSlideLibrary() {
  const [unlocked, setUnlocked] = useState(() => {
    try {
      return localStorage.getItem(GATE_STORAGE_KEY) === "true";
    } catch (e) {
      return false;
    }
  });
  const [songs, setSongs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState("title"); // 'title' | 'artist'
  const [sortDir, setSortDir] = useState("asc"); // 'asc' | 'desc'
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("preview"); // 'preview' | 'add' | 'edit'
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const [pendingImport, setPendingImport] = useState(null);
  const [pendingImportFile, setPendingImportFile] = useState(null);
  const [formKey, setFormKey] = useState(0);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState(null);
  const fileInputRef = useRef(null);

  const [view, setView] = useState("library"); // 'library' | 'setlists'
  const [setlists, setSetlists] = useState([]);
  const [setlistsLoading, setSetlistsLoading] = useState(true);
  const [selectedSetlistId, setSelectedSetlistId] = useState(null);
  const [creatingSetlist, setCreatingSetlist] = useState(false);
  const [savingSetlist, setSavingSetlist] = useState(false);
  const [confirmDeleteSetlistId, setConfirmDeleteSetlistId] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listSongs();
      setSongs(list);
    } catch (e) {
      setError("Couldn't load your library. Try refreshing.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const refreshSetlists = useCallback(async () => {
    setSetlistsLoading(true);
    try {
      const list = await listSetlists();
      setSetlists(list);
    } catch (e) {
      setError("Couldn't load your setlists. Try refreshing.");
    } finally {
      setSetlistsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshSetlists();
  }, [refreshSetlists]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = !q
      ? songs
      : songs.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            (s.artist || "").toLowerCase().includes(q) ||
            (s.rawText || "").toLowerCase().includes(q)
        );

    const sorted = [...matches].sort((a, b) => {
      const av = (sortBy === "artist" ? a.artist : a.title) || "";
      const bv = (sortBy === "artist" ? b.artist : b.title) || "";
      return av.localeCompare(bv);
    });
    if (sortDir === "desc") sorted.reverse();
    return sorted;
  }, [songs, query, sortBy, sortDir]);

  const selected = songs.find((s) => s.id === selectedId) || null;
  const selectedSetlist = setlists.find((s) => s.id === selectedSetlistId) || null;

  const startNewSetlist = () => {
    setSelectedSetlistId(null);
    setCreatingSetlist(true);
    setConfirmDeleteSetlistId(null);
  };

  const closeSetlistBuilder = () => {
    setSelectedSetlistId(null);
    setCreatingSetlist(false);
  };

  const handleSaveSetlist = async (data) => {
    setSavingSetlist(true);
    try {
      const setlist = creatingSetlist
        ? { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...data }
        : { ...selectedSetlist, ...data };
      await saveSetlistToStorage(setlist);
      await refreshSetlists();
      setSelectedSetlistId(setlist.id);
      setCreatingSetlist(false);
    } catch (e) {
      setError("Couldn't save that setlist. Try again.");
    } finally {
      setSavingSetlist(false);
    }
  };

  const handleDeleteSetlist = async (id) => {
    if (confirmDeleteSetlistId !== id) {
      setConfirmDeleteSetlistId(id);
      return;
    }
    try {
      await deleteSetlistFromStorage(id);
      setConfirmDeleteSetlistId(null);
      setSelectedSetlistId(null);
      await refreshSetlists();
    } catch (e) {
      setError("Couldn't delete that setlist. Try again.");
    }
  };

  const startBlankAdd = () => {
    setPendingImport(null);
    setPendingImportFile(null);
    setImportError(null);
    setFormKey((k) => k + 1);
    setMode("add");
    setSelectedId(null);
  };

  const startImportPdf = () => {
    setImportError(null);
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;

    setImporting(true);
    setImportError(null);
    try {
      const pdfjsLib = await loadPdfJs();
      const buf = await file.arrayBuffer();
      const result = await extractChordSheetFromPdf(pdfjsLib, buf);

      if (!result.hadText) {
        setImportError(
          "That PDF doesn't seem to contain selectable text — it may be a scanned image. Try uploading it in chat instead so it can be read visually, or paste the lyrics in manually."
        );
        return;
      }
      if (!result.rawText || !result.rawText.trim()) {
        setImportError(
          "The PDF loaded, but no lyric lines came through clearly. Try pasting the lyrics in manually below, or share it in chat."
        );
      }

      setPendingImport({
        title: result.title || file.name.replace(/\.pdf$/i, ""),
        artist: result.artist || "",
        rawText: result.rawText || "",
        linesPerSlide: 2,
        __importNote:
          "Imported from PDF — chord-stripping and column order are best-effort. Please review the lyrics below before saving.",
      });
      setPendingImportFile(file);
      setFormKey((k) => k + 1);
      setMode("add");
      setSelectedId(null);
    } catch (e) {
      setImportError("Couldn't read that PDF. " + (e?.message || "Try again, or paste the lyrics manually."));
    } finally {
      setImporting(false);
    }
  };

  const handleSaveNew = async (data) => {
    setSaving(true);
    try {
      const song = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...data };
      if (pendingImportFile) {
        try {
          const buf = await pendingImportFile.arrayBuffer();
          const uploaded = await window.storage.uploadFile("chord-sheets", `${song.id}.pdf`, buf, "application/pdf");
          song.pdfPath = uploaded.path;
        } catch (e) {
          // best-effort — the song still saves even if the original PDF fails to upload
        }
      }
      await saveSongToStorage(song);
      await refresh();
      setSelectedId(song.id);
      setPendingImport(null);
      setPendingImportFile(null);
      setMode("preview");
    } catch (e) {
      setError("Couldn't save that song. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveEdit = async (data) => {
    if (!selected) return;
    setSaving(true);
    try {
      const song = { ...selected, ...data };
      await saveSongToStorage(song);
      await refresh();
      setMode("preview");
    } catch (e) {
      setError("Couldn't save your changes. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    try {
      await deleteSongFromStorage(id);
      setConfirmDeleteId(null);
      setSelectedId(null);
      setMode("preview");
      await refresh();
    } catch (e) {
      setError("Couldn't delete that song. Try again.");
    }
  };

  const handleUpdateSongSettings = async (patch) => {
    if (!selected) return;
    const song = { ...selected, ...patch };
    setSongs((prev) => prev.map((s) => (s.id === song.id ? song : s)));
    try {
      await saveSongToStorage(song);
    } catch (e) {
      // best-effort, next refresh will reconcile
    }
  };

  // Used by the setlist builder's inline preview/edit — saves a full song
  // object (not just the currently-selected library song).
  const handleUpdateSong = async (song) => {
    setSongs((prev) => prev.map((s) => (s.id === song.id ? song : s)));
    try {
      await saveSongToStorage(song);
    } catch (e) {
      setError("Couldn't save that change. Try again.");
    }
  };

  if (!unlocked) {
    return <PasswordGate onUnlock={() => setUnlocked(true)} />;
  }

  return (
    <div style={styles.app}>
      <style>{FONTS}{`
        * { box-sizing: border-box; }
        input::placeholder, textarea::placeholder { color: ${TOKENS.inkSoft}; opacity: 0.55; }
        input:focus, textarea:focus { outline: none; border-color: ${TOKENS.accentSoft}; }
        input[type="number"]::-webkit-outer-spin-button,
        input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        button { cursor: pointer; font-family: 'Inter', sans-serif; }
        button:disabled { cursor: not-allowed; }
        .spin { animation: spin 0.8s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .view-fade { animation: viewFadeIn 0.45s cubic-bezier(0.16, 1, 0.3, 1) both; }
        @keyframes viewFadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        @media (max-width: 720px) {
          .wsl-shell { grid-template-columns: 1fr !important; }
          .wsl-sidebar { border-right: none !important; border-bottom: 1px solid ${TOKENS.rule}; }
        }
      `}</style>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf"
        style={{ display: "none" }}
        onChange={handleFileChange}
      />

      <div style={styles.appHeader}>
        <h1 style={styles.appTitle}>build your set</h1>
        <p style={styles.appSubtitle}>
          for the last minute scramble. put together your setlist and presentation in seconds.
          <br />
          <small>note: when importing a new song, make sure the chords are numbers!</small>
        </p>
      </div>

      <div className="wsl-shell" style={styles.shell}>
        <div className="wsl-sidebar" style={styles.sidebar}>
          <div style={styles.sidebarHeader}>
            <div style={styles.brand}>
              <Music4 size={16} color={TOKENS.accent} strokeWidth={2} />
              <span>{view === "library" ? "Song Library" : view === "setlists" ? "Setlists" : "History"}</span>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {view === "library" && (
                <>
                  <button
                    onClick={startImportPdf}
                    style={styles.addBtnGhost}
                    title="Import from PDF"
                    disabled={importing}
                  >
                    {importing ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
                  </button>
                  <button onClick={startBlankAdd} style={styles.addBtn} title="Add song">
                    <Plus size={16} />
                  </button>
                </>
              )}
              {view === "setlists" && (
                <button onClick={startNewSetlist} style={styles.addBtn} title="New setlist">
                  <Plus size={16} />
                </button>
              )}
            </div>
          </div>

          <div style={{ ...styles.toggleGroup, margin: "0 16px 12px" }}>
            {[
              { key: "library", label: "Library" },
              { key: "setlists", label: "Setlists" },
              { key: "history", label: "History" },
            ].map((t) => (
              <button
                key={t.key}
                onClick={() => setView(t.key)}
                style={{ ...styles.toggleBtn, flex: 1, ...(view === t.key ? styles.toggleBtnActive : {}) }}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div style={styles.sharedBadge}>
            <Users size={11} />
            <span>Shared library — visible to everyone with this link</span>
          </div>

          <div key={view} className="view-fade" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          {view === "library" && (
            <>
              <div style={styles.searchWrap}>
                <Search size={14} color={TOKENS.inkSoft} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search title, artist, or lyrics"
                  style={styles.searchInput}
                />
              </div>

              <div style={{ display: "flex", gap: 6, margin: "0 16px 12px" }}>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  style={{ ...styles.select, flex: 1, width: "100%" }}
                >
                  <option value="title">Sort by title</option>
                  <option value="artist">Sort by artist</option>
                </select>
                <button
                  onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                  style={styles.iconBtn}
                  title={sortDir === "asc" ? "A → Z (click for Z → A)" : "Z → A (click for A → Z)"}
                >
                  {sortDir === "asc" ? <ArrowDown size={13} /> : <ArrowUp size={13} />}
                </button>
              </div>

              <div style={styles.songList}>
                {loading && (
                  <div style={{ padding: 20, display: "flex", justifyContent: "center" }}>
                    <Loader2 size={18} className="spin" color={TOKENS.inkSoft} />
                  </div>
                )}
                {!loading && filtered.length === 0 && songs.length === 0 && (
                  <EmptyLibrary onAdd={startBlankAdd} onImport={startImportPdf} />
                )}
                {!loading && filtered.length === 0 && songs.length > 0 && (
                  <div style={{ padding: 20, fontFamily: "Inter", fontSize: 12.5, color: TOKENS.inkSoft }}>
                    No matches for "{query}"
                  </div>
                )}
                {!loading &&
                  filtered.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => {
                        setSelectedId(s.id);
                        setMode("preview");
                        setConfirmDeleteId(null);
                      }}
                      style={{
                        ...styles.songItem,
                        ...(s.id === selectedId ? styles.songItemActive : {}),
                      }}
                    >
                      <div style={styles.songItemTitle}>{s.title}</div>
                      {s.artist && <div style={styles.songItemArtist}>{s.artist}</div>}
                    </button>
                  ))}
              </div>
            </>
          )}

          {view === "setlists" && (
            <div style={styles.songList}>
              {setlistsLoading && (
                <div style={{ padding: 20, display: "flex", justifyContent: "center" }}>
                  <Loader2 size={18} className="spin" color={TOKENS.inkSoft} />
                </div>
              )}
              {!setlistsLoading && setlists.length === 0 && (
                <div style={{ padding: 20, fontFamily: "Inter", fontSize: 12.5, color: TOKENS.inkSoft, lineHeight: 1.6 }}>
                  No setlists yet. Create one to build a service order from your library.
                </div>
              )}
              {!setlistsLoading &&
                setlists.map((sl) => (
                  <button
                    key={sl.id}
                    onClick={() => {
                      setSelectedSetlistId(sl.id);
                      setCreatingSetlist(false);
                      setConfirmDeleteSetlistId(null);
                    }}
                    style={{
                      ...styles.songItem,
                      ...(sl.id === selectedSetlistId && !creatingSetlist ? styles.songItemActive : {}),
                    }}
                  >
                    <div style={styles.songItemTitle}>{sl.name}</div>
                    <div style={styles.songItemArtist}>
                      {sl.songIds.length} song{sl.songIds.length === 1 ? "" : "s"}
                    </div>
                  </button>
                ))}
            </div>
          )}
          </div>
        </div>

        <div style={styles.main}>
          {error && <div style={styles.errorBanner}>{error}</div>}

          <div key={view} className="view-fade">
          {view === "library" && (
            <>
              {importError && (
                <div style={styles.errorBanner}>
                  {importError}
                  <button
                    onClick={() => setImportError(null)}
                    style={{ float: "right", background: "none", border: "none", color: TOKENS.danger }}
                  >
                    <X size={13} />
                  </button>
                </div>
              )}
              {importing && (
                <div style={styles.infoBanner}>
                  <Loader2 size={13} className="spin" style={{ verticalAlign: "-2px", marginRight: 6 }} />
                  Reading PDF and reconstructing the lyric lines…
                </div>
              )}

              {mode === "add" && (
                <>
                  <BackRow onBack={() => setMode("preview")} label={pendingImport ? "Review import" : "New song"} />
                  <SongForm
                    key={`add-${formKey}`}
                    initial={pendingImport}
                    onCancel={() => {
                      setPendingImport(null);
                      setPendingImportFile(null);
                      setMode("preview");
                    }}
                    onSave={handleSaveNew}
                    saving={saving}
                  />
                </>
              )}

              {mode === "edit" && selected && (
                <>
                  <BackRow onBack={() => setMode("preview")} label={`Editing "${selected.title}"`} />
                  <SongForm
                    key={`edit-${selected.id}`}
                    initial={selected}
                    onCancel={() => setMode("preview")}
                    onSave={handleSaveEdit}
                    saving={saving}
                  />
                </>
              )}

              {mode === "preview" && selected && (
                <SongPreview
                  song={selected}
                  onEdit={() => setMode("edit")}
                  onDelete={() => handleDelete(selected.id)}
                  onUpdateSettings={handleUpdateSongSettings}
                  confirmingDelete={confirmDeleteId === selected.id}
                />
              )}

              {mode === "preview" && !selected && !loading && songs.length > 0 && (
                <div style={{ padding: "64px 24px", textAlign: "center" }}>
                  <p style={{ fontFamily: "Inter", fontSize: 13, color: TOKENS.inkSoft }}>
                    Select a song from the library, add a new one, or import a PDF.
                  </p>
                </div>
              )}
            </>
          )}

          {view === "setlists" && (creatingSetlist || selectedSetlist) && (
            <>
              <BackRow
                onBack={closeSetlistBuilder}
                label={creatingSetlist ? "New setlist" : `Editing "${selectedSetlist.name}"`}
              />
              <SetlistBuilder
                key={creatingSetlist ? "new-setlist" : selectedSetlist.id}
                initial={creatingSetlist ? null : selectedSetlist}
                allSongs={songs}
                onCancel={closeSetlistBuilder}
                onSave={handleSaveSetlist}
                onDelete={() => handleDeleteSetlist(selectedSetlist.id)}
                onUpdateSong={handleUpdateSong}
                saving={savingSetlist}
                confirmingDelete={confirmDeleteSetlistId === selectedSetlistId}
              />
            </>
          )}

          {view === "setlists" && !creatingSetlist && !selectedSetlist && !setlistsLoading && (
            <div style={{ padding: "64px 24px", textAlign: "center" }}>
              <p style={{ fontFamily: "Inter", fontSize: 13, color: TOKENS.inkSoft }}>
                {setlists.length > 0
                  ? "Select a setlist or create a new one."
                  : "Create your first setlist to build a service order from your library."}
              </p>
            </div>
          )}

          {view === "history" && <HistoryView songs={songs} setlists={setlists} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function BackRow({ onBack, label }) {
  return (
    <button onClick={onBack} style={styles.backRow}>
      <ChevronLeft size={14} />
      <span style={{ fontFamily: "Inter", fontSize: 12, color: TOKENS.inkSoft }}>{label}</span>
    </button>
  );
}

const styles = {
  app: {
    fontFamily: "'Inter', sans-serif",
    color: TOKENS.ink,
    background: TOKENS.paper,
    minHeight: "600px",
    borderRadius: 14,
    border: `1px solid ${TOKENS.rule}`,
    overflow: "hidden",
  },
  appHeader: {
    padding: "20px 24px 16px",
    borderBottom: `1px solid ${TOKENS.rule}`,
    background: TOKENS.paperDeep,
  },
  appTitle: {
    fontFamily: "'Fraunces', serif",
    fontWeight: 700,
    fontSize: 22,
    letterSpacing: "-0.01em",
    color: TOKENS.ink,
    margin: 0,
  },
  appSubtitle: {
    fontFamily: "'Inter', sans-serif",
    fontSize: 13,
    color: TOKENS.inkSoft,
    margin: "4px 0 0",
    lineHeight: 1.5,
  },
  gateWrap: {
    fontFamily: "'Inter', sans-serif",
    minHeight: "600px",
    borderRadius: 14,
    border: `1px solid ${TOKENS.rule}`,
    background: TOKENS.paper,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    transition: "opacity 0.3s ease",
  },
  gateCard: {
    maxWidth: 380,
    width: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
  },
  gateTitle: {
    fontFamily: "'Fraunces', serif",
    fontWeight: 700,
    fontSize: 32,
    color: TOKENS.ink,
    letterSpacing: "-0.01em",
    margin: "14px 0 0",
  },
  gateSubtitle: {
    fontFamily: "'Inter', sans-serif",
    fontSize: 13.5,
    color: TOKENS.inkSoft,
    lineHeight: 1.6,
    margin: "8px 0 24px",
  },
  gateForm: {
    display: "flex",
    gap: 8,
    width: "100%",
  },
  gateInput: {
    flex: 1,
    padding: "10px 14px",
    fontSize: 14,
    fontFamily: "'Inter', sans-serif",
    background: "#fff",
    border: `1px solid ${TOKENS.rule}`,
    borderRadius: 8,
    color: TOKENS.ink,
    minWidth: 0,
  },
  gateError: {
    fontFamily: "'Inter', sans-serif",
    fontSize: 12.5,
    color: TOKENS.danger,
    marginTop: 14,
  },
  shell: {
    display: "grid",
    gridTemplateColumns: "260px 1fr",
    minHeight: "600px",
  },
  sidebar: {
    borderRight: `1px solid ${TOKENS.rule}`,
    background: TOKENS.paperDeep,
    display: "flex",
    flexDirection: "column",
  },
  sidebarHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 16px 12px",
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontFamily: "'Fraunces', serif",
    fontWeight: 600,
    fontSize: 15,
    letterSpacing: "-0.01em",
  },
  addBtn: {
    background: TOKENS.accent,
    color: "#fff",
    border: "none",
    borderRadius: 7,
    width: 26,
    height: 26,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  addBtnGhost: {
    background: "#fff",
    color: TOKENS.accent,
    border: `1px solid ${TOKENS.rule}`,
    borderRadius: 7,
    width: 26,
    height: 26,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  searchWrap: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    margin: "0 16px 12px",
    padding: "7px 10px",
    background: TOKENS.paper,
    border: `1px solid ${TOKENS.rule}`,
    borderRadius: 8,
  },
  sharedBadge: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    margin: "0 16px 12px",
    padding: "6px 10px",
    background: TOKENS.infoBg,
    color: TOKENS.info,
    border: `1px solid ${TOKENS.rule}`,
    borderRadius: 7,
    fontFamily: "'Inter', sans-serif",
    fontSize: 10.5,
    lineHeight: 1.3,
  },
  searchInput: {
    border: "none",
    background: "transparent",
    fontSize: 12.5,
    fontFamily: "'Inter', sans-serif",
    color: TOKENS.ink,
    width: "100%",
  },
  songList: {
    overflowY: "auto",
    flex: 1,
    maxHeight: 440,
    paddingBottom: 12,
  },
  songItem: {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "9px 16px",
    background: "transparent",
    border: "none",
    borderLeft: "3px solid transparent",
  },
  songItemActive: {
    background: TOKENS.paper,
    borderLeft: `3px solid ${TOKENS.accent}`,
  },
  songItemTitle: {
    fontFamily: "'Fraunces', serif",
    fontSize: 13.5,
    fontWeight: 600,
    color: TOKENS.ink,
  },
  songItemArtist: {
    fontFamily: "'Inter', sans-serif",
    fontSize: 11,
    color: TOKENS.inkSoft,
    marginTop: 1,
  },
  setlistResults: {
    marginTop: 8,
    border: `1px solid ${TOKENS.rule}`,
    borderRadius: 8,
    overflow: "hidden",
    background: "#fff",
  },
  setlistResultItem: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    textAlign: "left",
    padding: "8px 12px",
    background: "transparent",
    border: "none",
    color: TOKENS.accent,
  },
  setlistRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 10px",
    background: "#fff",
    border: `1px solid ${TOKENS.rule}`,
    borderRadius: 8,
    transition: "border-color 0.15s ease, background 0.15s ease",
  },
  setlistRowDragOver: {
    borderColor: TOKENS.accent,
    background: TOKENS.infoBg,
  },
  setlistDragHandle: {
    display: "flex",
    alignItems: "center",
    color: TOKENS.inkSoft,
    cursor: "grab",
    flexShrink: 0,
  },
  setlistRowIndex: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: TOKENS.inkSoft,
    width: 18,
    textAlign: "center",
    flexShrink: 0,
  },
  setlistRowTitle: {
    display: "block",
    textAlign: "left",
    background: "transparent",
    border: "none",
    padding: 0,
  },
  setlistExpanded: {
    marginTop: 6,
    marginBottom: 6,
    padding: 16,
    background: TOKENS.paper,
    border: `1px solid ${TOKENS.rule}`,
    borderRadius: 8,
  },
  historyRow: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    padding: "10px 14px",
    background: "#fff",
    border: `1px solid ${TOKENS.rule}`,
    borderRadius: 8,
  },
  historyStat: {
    display: "flex",
    alignItems: "baseline",
    gap: 4,
    width: 70,
    flexShrink: 0,
  },
  historyCount: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 15,
    fontWeight: 600,
    color: TOKENS.accent,
  },
  historyCountLabel: {
    fontFamily: "'Inter', sans-serif",
    fontSize: 11,
    color: TOKENS.inkSoft,
  },
  historyLastUsed: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11.5,
    color: TOKENS.inkSoft,
    width: 100,
    flexShrink: 0,
    textAlign: "right",
  },
  historyList: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    maxHeight: 440,
    overflowY: "auto",
    paddingRight: 4,
  },
  main: {
    padding: "28px 32px",
    overflowY: "auto",
  },
  errorBanner: {
    background: "#F5DFDA",
    color: TOKENS.danger,
    fontSize: 12.5,
    padding: "8px 12px",
    borderRadius: 8,
    marginBottom: 16,
    fontFamily: "'Inter', sans-serif",
    lineHeight: 1.5,
  },
  infoBanner: {
    background: TOKENS.infoBg,
    color: TOKENS.info,
    fontSize: 12.5,
    padding: "8px 12px",
    borderRadius: 8,
    marginBottom: 16,
    fontFamily: "'Inter', sans-serif",
    lineHeight: 1.5,
  },
  backRow: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    background: "none",
    border: "none",
    padding: "0 0 16px",
    color: TOKENS.inkSoft,
  },
  label: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10.5,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: TOKENS.inkSoft,
    display: "block",
    marginBottom: 6,
  },
  input: {
    width: "100%",
    padding: "9px 11px",
    fontSize: 14,
    fontFamily: "'Inter', sans-serif",
    background: "#fff",
    border: `1px solid ${TOKENS.rule}`,
    borderRadius: 8,
    color: TOKENS.ink,
  },
  textarea: {
    width: "100%",
    padding: "12px",
    fontSize: 13,
    fontFamily: "'JetBrains Mono', monospace",
    lineHeight: 1.6,
    background: "#fff",
    border: `1px solid ${TOKENS.rule}`,
    borderRadius: 8,
    color: TOKENS.ink,
    resize: "vertical",
  },
  toggleGroup: {
    display: "flex",
    border: `1px solid ${TOKENS.rule}`,
    borderRadius: 7,
    overflow: "hidden",
  },
  toggleBtn: {
    padding: "5px 12px",
    fontSize: 12.5,
    background: "#fff",
    border: "none",
    color: TOKENS.inkSoft,
  },
  toggleBtnActive: {
    background: TOKENS.accent,
    color: "#fff",
  },
  switchTrack: {
    position: "relative",
    width: 44,
    height: 24,
    borderRadius: 12,
    border: `1px solid ${TOKENS.rule}`,
    padding: 0,
    transition: "background 0.38s ease",
    flexShrink: 0,
  },
  switchKnob: {
    position: "absolute",
    top: 1,
    width: 18,
    height: 18,
    borderRadius: "50%",
    boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
    transition: "left 0.38s cubic-bezier(0.34, 1.2, 0.4, 1), background 0.38s ease",
  },
  select: {
    padding: "6px 10px",
    fontSize: 12.5,
    fontFamily: "'Inter', sans-serif",
    background: "#fff",
    border: `1px solid ${TOKENS.rule}`,
    borderRadius: 7,
    color: TOKENS.ink,
    height: 28,
    width: 168,
  },
  stepper: {
    display: "inline-flex",
    alignItems: "center",
    border: `1px solid ${TOKENS.rule}`,
    borderRadius: 7,
    overflow: "hidden",
    background: "#fff",
  },
  stepperBtn: {
    width: 26,
    height: 28,
    background: TOKENS.paperDeep,
    border: "none",
    color: TOKENS.ink,
    fontSize: 15,
    lineHeight: 1,
  },
  stepperInput: {
    width: 38,
    height: 28,
    textAlign: "center",
    border: "none",
    borderLeft: `1px solid ${TOKENS.rule}`,
    borderRight: `1px solid ${TOKENS.rule}`,
    fontFamily: "'Inter', sans-serif",
    fontSize: 13,
    color: TOKENS.ink,
    MozAppearance: "textfield",
  },
  primaryBtn: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "9px 16px",
    fontSize: 13,
    fontWeight: 500,
    background: TOKENS.accent,
    color: "#fff",
    border: "none",
    borderRadius: 8,
  },
  primaryBtnSmall: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "7px 14px",
    fontSize: 12.5,
    background: TOKENS.accent,
    color: "#fff",
    border: "none",
    borderRadius: 7,
  },
  ghostBtn: {
    padding: "9px 16px",
    fontSize: 13,
    background: "transparent",
    color: TOKENS.inkSoft,
    border: `1px solid ${TOKENS.rule}`,
    borderRadius: 8,
  },
  ghostBtnSmall: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 12px",
    fontSize: 12,
    background: "transparent",
    color: TOKENS.accent,
    border: `1px solid ${TOKENS.rule}`,
    borderRadius: 7,
  },
  iconBtn: {
    width: 30,
    height: 30,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#fff",
    border: `1px solid ${TOKENS.rule}`,
    borderRadius: 7,
    color: TOKENS.inkSoft,
  },
  iconBtnDanger: {
    background: TOKENS.danger,
    color: "#fff",
    borderColor: TOKENS.danger,
  },
  songTitle: {
    fontFamily: "'Fraunces', serif",
    fontWeight: 700,
    fontSize: 26,
    margin: 0,
    letterSpacing: "-0.01em",
  },
  songArtist: {
    fontFamily: "'Inter', sans-serif",
    fontSize: 13,
    color: TOKENS.inkSoft,
    marginTop: 2,
  },
  screenGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
    gap: 14,
  },
  previewStrip: {
    display: "flex",
    gap: 10,
    overflowX: "auto",
    paddingBottom: 4,
  },
  screen: {
    background: TOKENS.screen,
    borderRadius: 10,
    aspectRatio: "16 / 9",
    padding: 16,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    position: "relative",
    textAlign: "center",
  },
  screenSmall: {
    minWidth: 150,
    width: 150,
    flexShrink: 0,
    padding: 10,
  },
  eyebrow: {
    position: "absolute",
    top: 10,
    left: 12,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 9,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: TOKENS.screenText,
    opacity: 0.5,
  },
  screenLines: {
    fontFamily: "'Fraunces', serif",
    fontWeight: 600,
    fontSize: 16,
    lineHeight: 1.4,
    color: TOKENS.screenText,
  },
  screenLinesSmall: {
    fontFamily: "'Fraunces', serif",
    fontWeight: 600,
    fontSize: 10.5,
    lineHeight: 1.35,
    color: TOKENS.screenText,
  },
};
