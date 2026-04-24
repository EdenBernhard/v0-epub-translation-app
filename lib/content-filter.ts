/**
 * Content Filter — identifies and removes non-content sections from books
 *
 * Two-layer detection:
 *  1. Title-based: matches chapter title against known patterns (TOC, Copyright,
 *     About the Author, Dedication, Foreword, etc.)
 *  2. Content-based: if the title doesn't match (common when heading tags are
 *     missing from front-matter pages), inspects the chapter body for
 *     telltale patterns.
 *
 * The content-based layer is essential for publisher EPUBs where the
 * dedication/TOC/about-author pages are styled with CSS classes on plain <p>
 * elements rather than proper <h1>/<h2> headings.
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
      savedPercent:
        totalChars > 0 ? Math.round((savedChars / totalChars) * 100) : 0,
    },
  }
}

/**
 * Filters EPUB spine entries by filename/path before content extraction.
 */
export function shouldSkipSpineFile(filePath: string): string | null {
  const lower = filePath.toLowerCase()
  const filename = lower.split("/").pop() || lower

  if (/^cover\.(x?html?|xhtml)$/.test(filename)) return "cover page"
  if (filename.includes("cover") && !filename.includes("discover"))
    return "cover page"

  if (/^title(page)?\.(x?html?|xhtml)$/.test(filename)) return "title page"

  if (/^(toc|contents|table.?of.?contents)\.(x?html?|xhtml)$/.test(filename))
    return "table of contents"
  if (filename.startsWith("nav.")) return "navigation"

  if (/^(copyright|legal|rights|imprint|impressum)\.(x?html?|xhtml)$/.test(filename))
    return "copyright"

  if (/^(dedication|widmung)\.(x?html?|xhtml)$/.test(filename))
    return "dedication"

  if (/^colophon\.(x?html?|xhtml)$/.test(filename)) return "colophon"

  if (/^(about.?(the.?)?author|about.?me|biography|biografie|vita)\.(x?html?|xhtml)$/.test(filename))
    return "about the author"

  if (/^(acknowledg(e)?ments?|danksagung)\.(x?html?|xhtml)$/.test(filename))
    return "acknowledgements"

  return null
}

// ---------------------------------------------------------------------------
// Internal — removal reason detection
// ---------------------------------------------------------------------------

type ChapterPosition = "start" | "middle" | "end"

function getChapterPosition(index: number, total: number): ChapterPosition {
  // First ~20% of chapters (covers cover + copyright + dedication + foreword)
  if (index < Math.max(3, Math.ceil(total * 0.2))) return "start"
  // Last ~15% of chapters
  if (index >= total - Math.max(2, Math.ceil(total * 0.15))) return "end"
  return "middle"
}

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

  // Normalize titles like "Chapter 1: About the Author" → "about the author"
  const titleForMatch = titleLower
    .replace(/^(chapter|kapitel)\s*\d+\s*[:\-–—.]\s*/i, "")
    .trim()

  // ── 1. Content-shape detection for TOC ────────────────────────────────
  // Works even when heading tags are missing on the TOC page.
  if (position === "start" && isTableOfContents(content)) {
    return "table of contents (content-detected)"
  }

  // ── 2. Title-based filtering (applies regardless of position) ─────────

  if (
    matchesPattern(titleLower, TOC_PATTERNS) ||
    matchesPattern(titleForMatch, TOC_PATTERNS)
  ) {
    return "table of contents"
  }

  if (
    matchesPattern(titleLower, COPYRIGHT_PATTERNS) ||
    matchesPattern(titleForMatch, COPYRIGHT_PATTERNS)
  ) {
    return "copyright notice"
  }

  // ── 3. Title-based filtering (only start/end positions) ───────────────

  if (position !== "middle") {
    if (
      position === "start" &&
      (matchesPattern(titleLower, FOREWORD_PATTERNS) ||
        matchesPattern(titleForMatch, FOREWORD_PATTERNS))
    ) {
      // Introduction is ambiguous: can be real first chapter in non-fiction.
      // Accept it as front-matter only if short-ish OR has "by <editor>" tell.
      if (titleForMatch === "introduction" || titleLower === "introduction") {
        if (contentLength < 8000 || hasEditorForewordSignals(contentLower)) {
          return "foreword/introduction"
        }
        // Otherwise treat as real content and keep.
      } else {
        return "foreword/preface"
      }
    }

    if (
      position === "start" &&
      (matchesPattern(titleLower, DEDICATION_PATTERNS) ||
        matchesPattern(titleForMatch, DEDICATION_PATTERNS))
    ) {
      return "dedication"
    }

    if (
      position === "start" &&
      (matchesPattern(titleLower, EPIGRAPH_PATTERNS) ||
        matchesPattern(titleForMatch, EPIGRAPH_PATTERNS))
    ) {
      return "epigraph"
    }

    if (
      position === "start" &&
      (matchesPattern(titleLower, PRAISE_PATTERNS) ||
        matchesPattern(titleForMatch, PRAISE_PATTERNS))
    ) {
      return "praise/reviews"
    }

    if (
      position === "start" &&
      (matchesPattern(titleLower, ABOUT_BOOK_PATTERNS) ||
        matchesPattern(titleForMatch, ABOUT_BOOK_PATTERNS))
    ) {
      return "about the book"
    }

    if (
      matchesPattern(titleLower, ABOUT_AUTHOR_PATTERNS) ||
      matchesPattern(titleForMatch, ABOUT_AUTHOR_PATTERNS)
    ) {
      return "about the author"
    }

    if (
      matchesPattern(titleLower, ACKNOWLEDGEMENT_PATTERNS) ||
      matchesPattern(titleForMatch, ACKNOWLEDGEMENT_PATTERNS)
    ) {
      return "acknowledgements"
    }

    if (
      matchesPattern(titleLower, PREVIEW_PATTERNS) ||
      matchesPattern(titleForMatch, PREVIEW_PATTERNS)
    ) {
      return "book preview"
    }

    if (
      matchesPattern(titleLower, ALSO_BY_PATTERNS) ||
      matchesPattern(titleForMatch, ALSO_BY_PATTERNS)
    ) {
      return "book suggestions"
    }

    if (
      matchesPattern(titleLower, GLOSSARY_PATTERNS) ||
      matchesPattern(titleForMatch, GLOSSARY_PATTERNS)
    ) {
      return "glossary"
    }

    if (
      position === "end" &&
      /^(index|register|stichwortverzeichnis|namensverzeichnis)$/i.test(
        titleForMatch || titleLower,
      )
    ) {
      return "index"
    }

    if (
      position === "end" &&
      /^(bibliograph(y|ie)|references|quellen(verzeichnis)?|literatur(verzeichnis)?)$/i.test(
        titleForMatch || titleLower,
      )
    ) {
      return "bibliography"
    }

    if (
      position === "start" &&
      (matchesPattern(titleLower, COVER_PATTERNS) ||
        matchesPattern(titleForMatch, COVER_PATTERNS))
    ) {
      return "cover/title page"
    }
  }

  // ── 4. Content-based filtering (only start/end, to avoid false positives) ─

  if (position !== "middle") {
    // Very short "chapters" at the edges (< 200 chars) — likely boilerplate
    if (contentLength < 200 && totalChapters > 5) {
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

    if (position === "end" && isBookList(contentLower)) {
      return "book list/advertisements"
    }

    if (position === "end" && isPreviewContent(contentLower)) {
      return "book preview (content-detected)"
    }

    if (
      position === "start" &&
      contentLength < 1500 &&
      isCopyrightContent(contentLower)
    ) {
      return "copyright (content-detected)"
    }

    // Dedication detection — short page with "For ..." / "To ..." / "In memory of"
    if (
      position === "start" &&
      contentLength < 600 &&
      isDedicationContent(content)
    ) {
      return "dedication (content-detected)"
    }

    // Epigraph — short quoted text with attribution (— Author)
    if (
      position === "start" &&
      contentLength < 1500 &&
      isEpigraphContent(content)
    ) {
      return "epigraph (content-detected)"
    }

    // Author bio — short chapter with biographical markers
    if (contentLength < 2500 && isAuthorBioContent(contentLower)) {
      return "about the author (content-detected)"
    }

    // Acknowledgements — starts with "I would like to thank" / "Thanks to"
    if (contentLength < 4000 && isAcknowledgementsContent(contentLower)) {
      return "acknowledgements (content-detected)"
    }
  }

  // ── 5. Keep everything else ───────────────────────────────────────────
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
  /^(foreword|preface|prologue|preamble)$/,
  /^(vorwort|einleitung|einführung|geleitwort|prolog)$/,
  /^(author'?s?\s*note|note\s*(from|by)\s*(the\s*)?author)$/,
  /^(anmerkung(en)?\s*de[sr]\s*autors?)$/,
  /^introduction$/,
]

const DEDICATION_PATTERNS = [
  /^(dedication|widmung)$/,
  /^(für|for)\s+/,
  /^to\s+(my|the)\s+/,
  /^in\s+memory\s+of/,
]

const EPIGRAPH_PATTERNS = [
  /^epigraph$/,
  /^motto$/,
  /^(zitat|quote)$/,
]

const PRAISE_PATTERNS = [
  /^praise\s*(for\s*)?/,
  /^(reviews?|acclaim)$/,
  /^(pressestimmen|stimmen\s*zum?\s*(buch|roman))/,
  /^(what\s+(people|critics|readers)\s+are\s+saying)/,
]

const ABOUT_BOOK_PATTERNS = [
  /^about\s*(this\s*)?(the\s*)?book/,
  /^über\s*(dieses|das)\s*buch/,
  /^(klappentext|buchbeschreibung)$/,
  /^(synopsis|zusammenfassung)$/,
  /^(book|buch)\s*description$/,
]

const ABOUT_AUTHOR_PATTERNS = [
  /^about\s*(the\s*)?author/,
  /^about\s*(me|the\s*writer)/,
  /^meet\s*(the\s*)?author/,
  /^über\s*(den|die|dem?)\s*autor/,
  /^(der|die)\s*autor(in)?$/,
  /^(author|autor(in)?)\s*(bio(graphy|grafie)?)?$/,
  /^(biographical\s*note|biographische?r?\s*(anmerkung|hinweis))/,
  /^vita$/,
  /^zur?\s*person/,
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
  /^(abkürzungsverzeichnis|abbreviations?)$/,
]

const COVER_PATTERNS = [
  /^cover$/,
  /^(title\s*page|titelseite|titelblatt)$/,
  /^(half\s*title|schmutztitel)$/,
  /^(front\s*matter|vorsatz)$/,
  /^frontispiece$/,
]

// ---------------------------------------------------------------------------
// Content analysis helpers
// ---------------------------------------------------------------------------

function matchesPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text))
}

function isTableOfContents(content: string): boolean {
  const trimmed = content.trim()
  if (trimmed.length < 50) return false
  if (trimmed.length > 3000) return false

  const lines = trimmed
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  if (lines.length < 3) return false

  const shortLines = lines.filter((l) => l.length < 80).length
  const shortLineRatio = shortLines / lines.length

  let tocLikeLines = 0
  for (const line of lines) {
    if (
      /^(chapter|kapitel|part|teil)\s+[ivxlcdm\d]+/i.test(line) ||
      /^[ivxlcdm]+\.\s+\S/i.test(line) ||
      /^\d+\.?\s+\S/.test(line) ||
      /\s+\d{1,4}\s*$/.test(line) ||
      /^\S.{0,60}\.{3,}/.test(line) ||
      /^(prologue|epilogue|foreword|preface|introduction|acknowledgements?|appendix|index|prolog|epilog|vorwort|einleitung|anhang|register)$/i.test(
        line,
      )
    ) {
      tocLikeLines++
    }
  }

  const tocLikeRatio = tocLikeLines / lines.length

  return shortLineRatio > 0.6 && tocLikeRatio > 0.4
}

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
      l.match(/\d{3}-\d/) ||
      l.match(
        /^(auch\s*(als|bei|von|erhältlich)|available|erhältlich|erscheint|erschienen)/i,
      ) ||
      l.match(
        /^(taschenbuch|hardcover|paperback|ebook|e-book|hörbuch|audiobook)/i,
      )
    ) {
      bookishLines++
    }
  }

  return bookishLines / lines.length > 0.3
}

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
    /^(kapitel|chapter)\s*1\b/i.test(firstParagraph)
  )
}

function isCopyrightContent(content: string): boolean {
  const lower = content.toLowerCase()
  let signals = 0
  if (lower.includes("all rights reserved")) signals++
  if (lower.includes("alle rechte vorbehalten")) signals++
  if (lower.includes("isbn")) signals++
  if (lower.match(/copyright\s*[©(]/)) signals++
  if (lower.includes("published by") || lower.includes("verlag")) signals++
  if (lower.match(/\b(20\d{2}|19\d{2})\b.*publish/)) signals++
  return signals >= 2
}

/**
 * Detects author bio — short chapter with biographical markers.
 */
function isAuthorBioContent(content: string): boolean {
  const lower = content.toLowerCase()
  let signals = 0

  if (
    /\b(is the author of|is the bestselling author|is the (award.?winning|#1|new york times)\s+\w+\s*author|ist (der )?autor(in)?)/i.test(
      lower,
    )
  )
    signals++
  if (/\b(lives in|lebt in|resides in|wohnt in)\b/i.test(lower)) signals++
  if (
    /\b(was born|born in|geboren (in|am)|is a graduate of|studierte|graduated from)\b/i.test(
      lower,
    )
  )
    signals++
  if (
    /\b(her|his|ihr|sein)\s+(previous|first|latest|new|next|nächste[sr]?|letzte[sr]?)\s+(book|novel|roman|buch)/i.test(
      lower,
    )
  )
    signals++
  if (/\bvisit\s+(his|her|their|the\s+author'?s)\s+(website|online|at)/i.test(lower))
    signals++
  if (/\b(follow\s+(him|her|them|the\s+author)\s+on|twitter\.com|@\w+)/i.test(lower))
    signals++
  if (/\b(he|she|they|er|sie)\s+(currently\s+)?(lives|teaches|works|writes)\b/i.test(lower))
    signals++

  return signals >= 2
}

/**
 * Detects dedication pages — very short, "For X" / "To X" structure.
 */
function isDedicationContent(content: string): boolean {
  const trimmed = content.trim()
  if (trimmed.length > 500) return false

  // Short, few lines, starts with a dedication marker
  const lines = trimmed.split(/\n+/).filter((l) => l.trim().length > 0)
  if (lines.length > 10) return false

  const first = lines[0]?.toLowerCase() ?? ""
  return (
    /^(for\s+my\s+|for\s+the\s+|to\s+my\s+|to\s+the\s+|in\s+memory\s+of|dedicated\s+to|für\s+|for\s+\w+\s*,)/i.test(
      first,
    ) || /^in\s+loving\s+memory/i.test(first)
  )
}

/**
 * Detects epigraph — short quoted text with attribution dash.
 */
function isEpigraphContent(content: string): boolean {
  const trimmed = content.trim()
  if (trimmed.length > 1200 || trimmed.length < 30) return false

  // An attribution line with an em-dash, en-dash, or double-hyphen near the end
  // e.g. "— Oscar Wilde" or "-- Unknown"
  const hasAttribution = /[\n\s](—|–|--)\s*[A-ZÄÖÜ][^\n]{2,50}\s*$/m.test(trimmed)
  if (!hasAttribution) return false

  // Must contain quotation marks OR be short and have attribution
  const hasQuotes = /["“”„‘’«»].+["“”„‘’«»]/.test(trimmed)
  return hasQuotes || trimmed.length < 400
}

/**
 * Detects acknowledgements — page starting with "I would like to thank",
 * "My thanks go to", "Dank gebührt", etc.
 */
function isAcknowledgementsContent(content: string): boolean {
  const firstChunk = content.substring(0, 800).toLowerCase()

  const thankSignals =
    /\b(i\s+would\s+like\s+to\s+thank|i\s+want\s+to\s+thank|my\s+thanks\s+(go|to)|thanks\s+to|i('| a)m\s+grateful\s+to|ich\s+möchte\s+(mich\s+)?bedanken|mein\s+dank\s+(geht|gilt)|danke?\s+an)/i

  if (!thankSignals.test(firstChunk)) return false

  // Additional signal: lots of names or "without whom" phrasing
  const hasNameList = /(,\s*[A-ZÄÖÜ][a-zäöüß]+\s+[A-ZÄÖÜ][a-zäöüß]+){2,}/.test(content)
  const hasWithoutWhom = /without\s+(whom|whose)|ohne\s+(den|die)/i.test(firstChunk)

  return hasNameList || hasWithoutWhom || thankSignals.test(firstChunk)
}

/**
 * Detects if an "Introduction" is actually an editor's foreword (remove)
 * vs. a real non-fiction introductory chapter (keep).
 *
 * Editor forewords typically reference "the author" in third person.
 */
function hasEditorForewordSignals(content: string): boolean {
  const firstChunk = content.substring(0, 1500).toLowerCase()

  // References to "the author" as a third party
  if (/\bthe\s+author('s)?\b/i.test(firstChunk)) return true
  // "in this book", "this volume", classic foreword phrases
  if (/\bin\s+this\s+(book|volume|work)/.test(firstChunk)) return true
  // Editor's signature block at end
  const lastChunk = content.substring(Math.max(0, content.length - 500)).toLowerCase()
  if (/\b(editor|translator|herausgeber|übersetzer)\b/.test(lastChunk)) return true

  return false
}