import jsPDF from "jspdf"
import { normalizeForPdf } from "./text-normalizer"

/**
 * PDF Generator
 *
 * Renders a book as a multi-page A4 PDF using jsPDF + its default helvetica
 * font. All input text is run through `normalizeForPdf` so letter-spacing
 * artifacts, weird Unicode spaces, and un-renderable quote variants don't
 * break the output.
 *
 * Key behaviors:
 *  - Uniform body typography: before every paragraph we explicitly reset
 *    font, size, and color — otherwise jsPDF can carry over the bold/large
 *    state from the chapter heading into the first lines of body text.
 *  - Title deduplication: the first few lines of chapter.content are
 *    compared against chapter.title and "Chapter N"-style patterns, then
 *    dropped. That prevents the "Kapitel / Kapitel 12, Demon's Bluff /
 *    Kapitel / 12" stacking we saw in real-world EPUBs where the source
 *    HTML put the heading both in <h1> AND as a text node.
 *
 * Returns ArrayBuffer — no generic variants, no BodyInit ambiguity.
 */

// ---------------------------------------------------------------------------
// Typography constants — single source of truth
// ---------------------------------------------------------------------------

const TYPO = {
  // Body text
  bodySize: 11,
  bodyLineHeight: 6,
  paragraphGap: 4,

  // Chapter heading
  headingSize: 18,
  headingLineHeight: 9,
  headingGapAfter: 10,

  // Title page
  titleSize: 24,
  titleLineHeight: 12,
  authorSize: 14,
  metaSize: 10,

  // Footer
  footerSize: 8,
  footerColor: 150 as const,

  // Page layout
  margin: 20,
} as const

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface PDFOptions {
  title: string
  author: string
  content: string
  language: string
  chapters?: Array<{ title: string; content: string }>
}

export async function generatePDF(options: PDFOptions): Promise<ArrayBuffer> {
  // Defensive destructuring
  const title = String(options.title || "Untitled")
  const author = String(options.author || "Unknown Author")
  const language = String(options.language || "English")
  const rawContent = String(options.content || "")
  const rawChapters = Array.isArray(options.chapters) ? options.chapters : []

  // ── Normalize everything up front ───────────────────────────────────
  const safeTitle = normalizeForPdf(title).slice(0, 500) || "Untitled"
  const safeAuthor = normalizeForPdf(author).slice(0, 200) || "Unknown Author"
  const safeContent = normalizeForPdf(rawContent)

  const safeChapters = rawChapters
    .filter(
      (ch): ch is { title: string; content: string } =>
        !!ch &&
        typeof ch === "object" &&
        typeof (ch as any).content === "string",
    )
    .map((ch) => {
      const chTitle =
        normalizeForPdf(String(ch.title || "")) || "Untitled Chapter"
      let chContent = normalizeForPdf(String(ch.content || ""))
      // Strip any repeated title/chapter-marker lines from the start of
      // the content so the PDF shows the heading exactly once.
      chContent = stripLeadingTitleEchoes(chContent, chTitle)
      return { title: chTitle, content: chContent }
    })
    .filter((ch) => ch.content.trim().length > 0)

  // ── Set up document ─────────────────────────────────────────────────
  const doc = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4",
  })

  doc.setProperties({
    title: safeTitle,
    author: safeAuthor,
    subject: `EPUB Translation — ${language}`,
    creator: "EPUB Translation App",
  })

  const PAGE_W = doc.internal.pageSize.getWidth()
  const PAGE_H = doc.internal.pageSize.getHeight()
  const MAX_W = PAGE_W - 2 * TYPO.margin
  const FOOTER_Y = PAGE_H - 10

  let y = TYPO.margin
  let pageNum = 1

  // ── Style resets (centralized — always call before rendering) ───────
  const applyBodyStyle = () => {
    doc.setFont("helvetica", "normal")
    doc.setFontSize(TYPO.bodySize)
    doc.setTextColor(0)
  }

  const applyHeadingStyle = () => {
    doc.setFont("helvetica", "bold")
    doc.setFontSize(TYPO.headingSize)
    doc.setTextColor(0)
  }

  const applyFooterStyle = () => {
    doc.setFont("helvetica", "normal")
    doc.setFontSize(TYPO.footerSize)
    doc.setTextColor(TYPO.footerColor)
  }

  // ── Page management ─────────────────────────────────────────────────
  const addFooter = () => {
    applyFooterStyle()
    doc.text(`${pageNum}`, PAGE_W / 2, FOOTER_Y, { align: "center" })
    doc.setTextColor(0)
  }

  const newPage = () => {
    addFooter()
    doc.addPage()
    pageNum++
    y = TYPO.margin
  }

  const ensureSpace = (needed: number) => {
    if (y + needed > PAGE_H - TYPO.margin - 10) newPage()
  }

  // ── Paragraph renderer ──────────────────────────────────────────────
  // Always resets to body style at the start. Never assumes prior state.
  const renderParagraphs = (text: string) => {
    if (!text) return
    applyBodyStyle()

    const paragraphs = text.split(/\n+/)

    for (const paragraph of paragraphs) {
      const trimmed = paragraph.trim()
      if (!trimmed) continue

      // Re-apply body style every paragraph, just in case something
      // external changed it (paranoid but cheap).
      applyBodyStyle()

      let lines: string[]
      try {
        const result = doc.splitTextToSize(trimmed, MAX_W)
        lines = Array.isArray(result) ? result : [String(result)]
      } catch {
        console.warn(
          `[pdf-generator] splitTextToSize failed on paragraph (len=${trimmed.length}), falling back to raw split`,
        )
        lines = []
        for (let i = 0; i < trimmed.length; i += 90) {
          lines.push(trimmed.slice(i, i + 90))
        }
      }

      for (const line of lines) {
        ensureSpace(TYPO.bodyLineHeight + 2)
        doc.text(line, TYPO.margin, y)
        y += TYPO.bodyLineHeight
      }
      y += TYPO.paragraphGap
    }
  }

  // ── Chapter heading renderer ────────────────────────────────────────
  const renderChapterHeading = (chapterTitle: string) => {
    applyHeadingStyle()

    let lines: string[]
    try {
      const result = doc.splitTextToSize(chapterTitle, MAX_W)
      lines = Array.isArray(result) ? result : [String(result)]
    } catch {
      lines = [chapterTitle.slice(0, 100)]
    }

    ensureSpace(lines.length * TYPO.headingLineHeight + TYPO.headingGapAfter)
    doc.text(lines, TYPO.margin, y)
    y += lines.length * TYPO.headingLineHeight + TYPO.headingGapAfter
  }

  // ── Title page ──────────────────────────────────────────────────────
  y = PAGE_H / 3

  doc.setFont("helvetica", "bold")
  doc.setFontSize(TYPO.titleSize)
  doc.setTextColor(0)
  const titleLines = doc.splitTextToSize(safeTitle, MAX_W)
  doc.text(titleLines, PAGE_W / 2, y, { align: "center" })
  y += (Array.isArray(titleLines) ? titleLines.length : 1) * TYPO.titleLineHeight

  doc.setFont("helvetica", "italic")
  doc.setFontSize(TYPO.authorSize)
  doc.text(safeAuthor, PAGE_W / 2, y, { align: "center" })
  y += TYPO.titleLineHeight

  doc.setFont("helvetica", "normal")
  doc.setFontSize(TYPO.metaSize)
  doc.setTextColor(100)
  doc.text(`Language: ${language}`, PAGE_W / 2, y, { align: "center" })
  doc.setTextColor(0)

  addFooter()

  // ── Content ─────────────────────────────────────────────────────────
  if (safeChapters.length > 0) {
    for (const chapter of safeChapters) {
      newPage()
      renderChapterHeading(chapter.title)
      renderParagraphs(chapter.content)
    }
  } else if (safeContent) {
    newPage()
    renderParagraphs(safeContent)
  } else {
    newPage()
    applyBodyStyle()
    doc.setTextColor(150)
    doc.text("(No content available)", PAGE_W / 2, PAGE_H / 2, {
      align: "center",
    })
    doc.setTextColor(0)
  }

  addFooter()

  // ── Serialize ───────────────────────────────────────────────────────
  return doc.output("arraybuffer") as ArrayBuffer
}

// ---------------------------------------------------------------------------
// Title deduplication
// ---------------------------------------------------------------------------

/**
 * Removes leading lines from `content` that are repeating the chapter title
 * or generic chapter markers.
 *
 * Real-world example from a Kim Harrison EPUB where content started with:
 *
 *   Kapitel                       ← generic word
 *   Kapitel 12, Demon's Bluff     ← title repeat with book-name suffix
 *   Kapitel                       ← generic word
 *   12                            ← standalone number
 *   Ich schrie auf, als die ...   ← actual prose begins here
 *
 * Strategy: inspect up to the first 8 non-empty lines and drop any that
 * match one of the removable patterns. Stop as soon as a real prose line
 * is found. Cap total removed at 8 lines as a safety net.
 */
function stripLeadingTitleEchoes(content: string, chapterTitle: string): string {
  if (!content) return content

  const lines = content.split("\n")
  const titleNorm = normalizeForCompare(chapterTitle)

  // Pre-derive variants of the title that commonly appear as echoes
  const titleVariants = new Set<string>()
  titleVariants.add(titleNorm)

  // Strip trailing ", <book name>" — EPUBs often add this
  const beforeComma = titleNorm.split(",")[0].trim()
  if (beforeComma) titleVariants.add(beforeComma)

  // If the title is like "Kapitel 12" / "Chapter 12", also try just "12"
  const numMatch = titleNorm.match(/^(kapitel|chapter|teil|part)\s*(\d+)/)
  if (numMatch) {
    titleVariants.add(numMatch[2])
    titleVariants.add(numMatch[0])
  }

  let i = 0
  let removed = 0
  const MAX_REMOVE = 8
  const MAX_SCAN = 8

  // Walk through the first few lines
  while (i < lines.length && removed < MAX_REMOVE && i < MAX_SCAN + removed) {
    const original = lines[i]
    const stripped = original.trim()

    if (!stripped) {
      // Blank line — skip but don't count toward "removed"
      i++
      continue
    }

    if (looksLikeTitleEcho(stripped, titleVariants)) {
      lines[i] = "" // clear it; we'll re-join and trim later
      removed++
      i++
      continue
    }

    // First real prose line — stop here
    break
  }

  if (removed === 0) return content

  // Rejoin and strip any leading empty lines that resulted from clearing
  return lines.join("\n").replace(/^\s*\n+/, "")
}

/**
 * Checks if a line is a redundant repeat of the chapter title or a generic
 * chapter marker like "Kapitel", "Chapter 3", or just "12".
 */
function looksLikeTitleEcho(line: string, titleVariants: Set<string>): boolean {
  const normalized = normalizeForCompare(line)
  if (!normalized) return true // whitespace-only

  // Don't strip anything longer than ~120 chars — real prose is long
  if (line.length > 120) return false

  // Exact match against any title variant
  if (titleVariants.has(normalized)) return true

  // Generic standalone markers: "Kapitel", "Chapter", "Teil", "Part"
  if (/^(kapitel|chapter|teil|part|prolog|prologue|epilog|epilogue)$/.test(normalized))
    return true

  // "Chapter N" / "Kapitel N" by itself
  if (/^(kapitel|chapter|teil|part)\s*[\divxlcdm]+\.?$/.test(normalized)) return true

  // Pure number like "12" or roman "IV"
  if (/^\d{1,4}$/.test(normalized)) return true
  if (/^[ivxlcdm]+$/.test(normalized)) return true

  // "Chapter 12, <anything>" — title-with-book-suffix pattern
  if (/^(kapitel|chapter|teil|part)\s*\d+\s*[,:\-–—]/.test(normalized)) {
    // Make sure the first part overlaps with a known title variant
    for (const variant of titleVariants) {
      if (normalized.startsWith(variant) || variant.startsWith(normalized)) {
        return true
      }
    }
    // Even without variant match, "Chapter 12, <bookname>" is almost always
    // an echo when it appears in the first lines of content.
    return true
  }

  return false
}

/**
 * Lowercase, collapse whitespace, strip surrounding punctuation.
 * Used only for title-echo matching, not for display.
 */
function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/["'„‚“”‘’«»‹›()\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}