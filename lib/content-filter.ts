/**
 * Content Filter — identifies and removes non-content sections from books
 *
 * Filters out:
 * - Table of contents / Inhaltsverzeichnis
 * - Foreword / Vorwort / Preface / Introduction by editors
 * - Copyright / Legal notices / Impressum
 * - Dedication pages
 * - Book previews / Leseproben / "Also by this author"
 * - Book suggestions / recommendations / advertisements
 * - Acknowledgements / Danksagung
 * - About the author / Über den Autor
 * - Appendix / Anhang (optional — sometimes useful)
 * - Endnotes / Footnotes pages (the inline ones stay)
 * - Cover page / Title page
 * - Colophon
 * - Blurbs / Reviews
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FilteredChapter {
  title: string
  content: string
  /** Why this chapter was kept or removed */
  filterReason?: string
}

export interface FilterResult {
  /** Chapters that passed the filter (actual book content) */
  chapters: FilteredChapter[]
  /** Chapters that were removed */
  removed: FilteredChapter[]
  /** Stats for logging */
  stats: {
    totalChapters: number
    keptChapters: number
    removedChapters: number
    originalCharCount: number
    filteredCharCount: number
    savedCharCount: number
    savedPercent: number
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Filters chapters to keep only actual book content.
 * Works for both EPUB and MOBI parsed chapters.
 */
export function filterBookContent(
  chapters: Array<{ title: string; content: string }>,
): FilterResult {
  const kept: FilteredChapter[] = []
  const removed: FilteredChapter[] = []

  const totalChars = chapters.reduce((sum, ch) => sum + ch.content.length, 0)

  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i]
    const position = getChapterPosition(i, chapters.length)
    const reason = getRemovalReason(chapter, position, chapters.length)

    if (reason) {
      removed.push({ ...chapter, filterReason: reason })
    } else {
      kept.push({ ...chapter })
    }
  }

  const filteredChars = kept.reduce((sum, ch) => sum + ch.content.length, 0)
  const savedChars = totalChars - filteredChars

  return {
    chapters: kept,
    removed,
    stats: {
      totalChapters: chapters.length,
      keptChapters: kept.length,
      removedChapters: removed.length,
      originalCharCount: totalChars,
      filteredCharCount: filteredChars,
      savedCharCount: savedChars,
      savedPercent: totalChars > 0 ? Math.round((savedChars / totalChars) * 100) : 0,
    },
  }
}

/**
 * Filters EPUB spine entries by filename/path before content extraction.
 * This is more efficient — we skip parsing HTML files we'll discard anyway.
 */
export function shouldSkipSpineFile(filePath: string): string | null {
  const lower = filePath.toLowerCase()
  const filename = lower.split("/").pop() || lower

  // Cover pages
  if (/^cover\.(x?html?|xhtml)$/.test(filename)) return "cover page"
  if (filename.includes("cover") && !filename.includes("discover")) return "cover page"

  // Title pages
  if (/^title(page)?\.(x?html?|xhtml)$/.test(filename)) return "title page"

  // Table of contents
  if (/^(toc|contents|table.?of.?contents)\.(x?html?|xhtml)$/.test(filename)) return "table of contents"
  if (filename.startsWith("nav.")) return "navigation"

  // Copyright / legal
  if (/^(copyright|legal|rights|imprint|impressum)\.(x?html?|xhtml)$/.test(filename)) return "copyright"

  // Dedication
  if (/^(dedication|widmung)\.(x?html?|xhtml)$/.test(filename)) return "dedication"

  // Colophon
  if (/^colophon\.(x?html?|xhtml)$/.test(filename)) return "colophon"

  return null
}

// ---------------------------------------------------------------------------
// Internal — removal reason detection
// ---------------------------------------------------------------------------

type ChapterPosition = "start" | "middle" | "end"

function getChapterPosition(index: number, total: number): ChapterPosition {
  // First ~15% of chapters
  if (index < Math.max(2, Math.ceil(total * 0.15))) return "start"
  // Last ~15% of chapters
  if (index >= total - Math.max(2, Math.ceil(total * 0.15))) return "end"
  return "middle"
}

/**
 * Returns a reason string if the chapter should be removed, or null if it should be kept.
 *
 * Strategy:
 * 1. Check title against known patterns
 * 2. Check content for telltale patterns (only for start/end chapters)
 * 3. Very short chapters at start/end are suspicious
 * 4. Middle chapters are almost always real content — keep them
 */
function getRemovalReason(
  chapter: { title: string; content: string },
  position: ChapterPosition,
  totalChapters: number,
): string | null {
  const title = chapter.title.trim()
  const titleLower = title.toLowerCase()
  const content = chapter.content
  const contentLower = content.toLowerCase()
  const contentLength = content.trim().length

  // ── 1. Title-based filtering (applies regardless of position) ─────────

  // Table of contents
  if (matchesPattern(titleLower, TOC_PATTERNS)) {
    return "table of contents"
  }

  // Copyright / Legal
  if (matchesPattern(titleLower, COPYRIGHT_PATTERNS)) {
    return "copyright notice"
  }

  // ── 2. Title-based filtering (only start/end positions) ───────────────

  if (position !== "middle") {
    // Foreword / Preface / Introduction (only at start)
    if (position === "start" && matchesPattern(titleLower, FOREWORD_PATTERNS)) {
      return "foreword/preface"
    }

    // Dedication
    if (position === "start" && matchesPattern(titleLower, DEDICATION_PATTERNS)) {
      return "dedication"
    }

    // Epigraph (short quote at start)
    if (position === "start" && matchesPattern(titleLower, EPIGRAPH_PATTERNS)) {
      return "epigraph"
    }

    // About the author
    if (matchesPattern(titleLower, ABOUT_AUTHOR_PATTERNS)) {
      return "about the author"
    }

    // Acknowledgements
    if (matchesPattern(titleLower, ACKNOWLEDGEMENT_PATTERNS)) {
      return "acknowledgements"
    }

    // Book previews / Leseprobe
    if (matchesPattern(titleLower, PREVIEW_PATTERNS)) {
      return "book preview/Leseprobe"
    }

    // Also by this author / book suggestions
    if (matchesPattern(titleLower, ALSO_BY_PATTERNS)) {
      return "book suggestions"
    }

    // Glossary
    if (matchesPattern(titleLower, GLOSSARY_PATTERNS)) {
      return "glossary"
    }

    // Index
    if (position === "end" && /^(index|register|stichwortverzeichnis)$/i.test(titleLower)) {
      return "index"
    }

    // Cover / Title page
    if (position === "start" && matchesPattern(titleLower, COVER_PATTERNS)) {
      return "cover/title page"
    }
  }

  // ── 3. Content-based filtering (only start/end, to avoid false positives) ─

  if (position !== "middle") {
    // Very short "chapters" at the edges (< 200 chars) — likely boilerplate
    if (contentLength < 200 && totalChapters > 5) {
      // Check if it's just a cover, title, or publisher info
      if (
        contentLower.includes("all rights reserved") ||
        contentLower.includes("alle rechte vorbehalten") ||
        contentLower.includes("isbn") ||
        contentLower.includes("published by") ||
        contentLower.includes("copyright ©") ||
        contentLower.includes("copyright (c)")
      ) {
        return "copyright/publisher info (short)"
      }
    }

    // Content that's mostly a list of other books
    if (position === "end" && isBookList(contentLower)) {
      return "book list/advertisements"
    }

    // Preview chapter detection by content
    if (position === "end" && isPreviewContent(contentLower)) {
      return "book preview (content-detected)"
    }

    // Copyright page detection by content (even if title doesn't match)
    if (position === "start" && contentLength < 1500 && isCopyrightContent(contentLower)) {
      return "copyright (content-detected)"
    }
  }

  // ── 4. Keep everything else ───────────────────────────────────────────
  return null
}

// ---------------------------------------------------------------------------
// Pattern lists — EN + DE
// ---------------------------------------------------------------------------

const TOC_PATTERNS = [
  /^(table of contents|contents|toc)$/,
  /^inhalts?(verzeichnis)?$/,
  /^inhalt$/,
  /^übersicht$/,
]

const COPYRIGHT_PATTERNS = [
  /^copyright/,
  /^legal\s*(notice|info)?$/,
  /^(impressum|imprint)$/,
  /^rights?\s*(info|notice|page)?$/,
  /^(urheberrecht|rechtshinweis)$/,
  /^colophon$/,
]

const FOREWORD_PATTERNS = [
  /^(foreword|preface|prologue|introduction|preamble)$/,
  /^(vorwort|einleitung|einführung|geleitwort|prolog)$/,
  /^(author'?s?\s*note|note\s*(from|by)\s*(the\s*)?author)$/,
  /^(anmerkung(en)?\s*de[sr]\s*autors?)$/,
]

const DEDICATION_PATTERNS = [
  /^(dedication|widmung)$/,
  /^(für|for)\s+/,
]

const EPIGRAPH_PATTERNS = [
  /^epigraph$/,
  /^motto$/,
]

const ABOUT_AUTHOR_PATTERNS = [
  /^about\s*(the\s*)?author/,
  /^über\s*(den|die)\s*autor/,
  /^(der|die)\s*autor/,
  /^(author|autor)\s*(bio(graphy|grafie)?)?$/,
  /^vita$/,
]

const ACKNOWLEDGEMENT_PATTERNS = [
  /^(acknowledgements?|acknowledgments?)$/,
  /^(danksagung|dank|dankeswort)$/,
  /^(thanks|thank\s*you)$/,
]

const PREVIEW_PATTERNS = [
  /leseprobe/,
  /^(preview|excerpt|sneak\s*peek|sample)/,
  /^(auszug|textprobe|vorabdruck)/,
  /^(read\s*(an?\s*)?excerpt)/,
  /^(lesen\s*sie\s*(auch|mehr))/,
]

const ALSO_BY_PATTERNS = [
  /^also\s*by/,
  /^(other|more)\s*(books?\s*)?by/,
  /^(weitere\s*)?(bücher|werke|romane|titel)\s*(von|des|der)/,
  /^(vom\s*selben|von\s*der?\s*(gleichen|selben))\s*autor/,
  /^(books?\s*by\s*(this|the)\s*author)/,
  /^bibliography$/,
  /^(empfehlung|buchempfehlung)/,
  /^(weitere\s*)?veröffentlichung/,
]

const GLOSSARY_PATTERNS = [
  /^(glossary|glossar)$/,
  /^(begriffserklärung|wörterverzeichnis)$/,
]

const COVER_PATTERNS = [
  /^cover$/,
  /^(title\s*page|titelseite|titelblatt)$/,
  /^(half\s*title|schmutztitel)$/,
  /^(front\s*matter|vorsatz)$/,
]

// ---------------------------------------------------------------------------
// Content analysis helpers
// ---------------------------------------------------------------------------

function matchesPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text))
}

/**
 * Detects if content is primarily a list of book titles/recommendations.
 * Heuristic: many lines starting with caps, containing ISBN, "by", or prices.
 */
function isBookList(content: string): boolean {
  const lines = content.split("\n").filter((l) => l.trim().length > 0)
  if (lines.length < 3) return false

  let bookishLines = 0
  for (const line of lines) {
    const l = line.trim().toLowerCase()
    if (
      l.includes("isbn") ||
      l.includes("€") ||
      l.includes("$") ||
      l.match(/\d{3}-\d/) || // ISBN-like pattern
      l.match(/^(auch\s*(als|bei|von|erhältlich)|available|erhältlich|erscheint|erschienen)/i) ||
      l.match(/^(taschenbuch|hardcover|paperback|ebook|e-book|hörbuch|audiobook)/i)
    ) {
      bookishLines++
    }
  }

  // If more than 30% of lines look like book listings
  return bookishLines / lines.length > 0.3
}

/**
 * Detects preview/excerpt content at the end of a book.
 * Common patterns: "Leseprobe aus...", "Read an excerpt from...", "Coming soon..."
 */
function isPreviewContent(content: string): boolean {
  const firstParagraph = content.substring(0, 500).toLowerCase()

  return (
    firstParagraph.includes("leseprobe") ||
    firstParagraph.includes("lesen sie auch") ||
    firstParagraph.includes("read an excerpt") ||
    firstParagraph.includes("sneak peek") ||
    firstParagraph.includes("coming soon") ||
    firstParagraph.includes("erscheint demnächst") ||
    firstParagraph.includes("preview of") ||
    firstParagraph.includes("auszug aus") ||
    firstParagraph.includes("vorabdruck") ||
    /^(kapitel|chapter)\s*1\b/i.test(firstParagraph) // Preview starting with "Chapter 1"
  )
}

/**
 * Detects copyright/publisher content by keywords in the body.
 */
function isCopyrightContent(content: string): boolean {
  const markers = [
    "all rights reserved",
    "alle rechte vorbehalten",
    "published by",
    "copyright ©",
    "copyright (c)",
    "isbn",
    "printed in",
    "gedruckt in",
    "verlag",
    "publisher",
    "first edition",
    "erste auflage",
    "originalausgabe",
    "original edition",
    "library of congress",
  ]

  let hits = 0
  for (const marker of markers) {
    if (content.includes(marker)) hits++
  }

  // 2+ copyright markers in a short text = likely copyright page
  return hits >= 2
}