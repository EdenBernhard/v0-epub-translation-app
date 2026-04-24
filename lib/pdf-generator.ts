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
 *  - Uniform body typography: an active style is tracked as a TS variable,
 *    and every utility that temporarily changes the style (footer writer,
 *    page-breaker) restores it before returning. This prevents the
 *    classic jsPDF bug where the first lines after a page break inherit
 *    the footer's 8pt grey style.
 *  - Title deduplication: the first few lines of chapter.content are
 *    compared against chapter.title and "Chapter N"-style patterns, then
 *    dropped. That prevents "Kapitel / Kapitel 12, Demon's Bluff /
 *    Kapitel / 12" stacking we saw in real-world EPUBs.
 *
 * Returns ArrayBuffer — no generic variants, no BodyInit ambiguity.
 */

// ---------------------------------------------------------------------------
// Typography constants — single source of truth
// ---------------------------------------------------------------------------

const TYPO = {
  bodySize: 11,
  bodyLineHeight: 6,
  paragraphGap: 4,

  headingSize: 18,
  headingLineHeight: 9,
  headingGapAfter: 10,

  titleSize: 24,
  titleLineHeight: 12,
  authorSize: 14,
  metaSize: 10,

  footerSize: 8,
  footerColor: 150 as const,

  margin: 20,
} as const

type StyleName = "body" | "heading" | "title" | "author" | "meta" | "footer"

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
  const title = String(options.title || "Untitled")
  const author = String(options.author || "Unknown Author")
  const language = String(options.language || "English")
  const rawContent = String(options.content || "")
  const rawChapters = Array.isArray(options.chapters) ? options.chapters : []

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
      chContent = stripLeadingTitleEchoes(chContent, chTitle)
      return { title: chTitle, content: chContent }
    })
    .filter((ch) => ch.content.trim().length > 0)

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

  // ── Style tracking ──────────────────────────────────────────────────
  // We track the "active" style so anything that temporarily changes the
  // style (like the footer) can restore it afterwards. This is the key
  // fix for the "first lines of a new page are small/grey" bug.
  let activeStyle: StyleName = "body"

  const applyStyle = (name: StyleName) => {
    switch (name) {
      case "body":
        doc.setFont("helvetica", "normal")
        doc.setFontSize(TYPO.bodySize)
        doc.setTextColor(0)
        break
      case "heading":
        doc.setFont("helvetica", "bold")
        doc.setFontSize(TYPO.headingSize)
        doc.setTextColor(0)
        break
      case "title":
        doc.setFont("helvetica", "bold")
        doc.setFontSize(TYPO.titleSize)
        doc.setTextColor(0)
        break
      case "author":
        doc.setFont("helvetica", "italic")
        doc.setFontSize(TYPO.authorSize)
        doc.setTextColor(0)
        break
      case "meta":
        doc.setFont("helvetica", "normal")
        doc.setFontSize(TYPO.metaSize)
        doc.setTextColor(100)
        break
      case "footer":
        doc.setFont("helvetica", "normal")
        doc.setFontSize(TYPO.footerSize)
        doc.setTextColor(TYPO.footerColor)
        break
    }
  }

  const setStyle = (name: StyleName) => {
    activeStyle = name
    applyStyle(name)
  }

  // ── Page management ─────────────────────────────────────────────────
  const addFooter = () => {
    // Save-and-restore: draw the footer without disturbing the active style
    const saved = activeStyle
    applyStyle("footer")
    doc.text(`${pageNum}`, PAGE_W / 2, FOOTER_Y, { align: "center" })
    applyStyle(saved)
  }

  const newPage = () => {
    addFooter()
    doc.addPage()
    pageNum++
    y = TYPO.margin
    // Re-assert the active style on the fresh page (jsPDF state carries
    // over, but being explicit avoids any future jsPDF version surprises).
    applyStyle(activeStyle)
  }

  const ensureSpace = (needed: number) => {
    if (y + needed > PAGE_H - TYPO.margin - 10) newPage()
  }

  // ── Paragraph renderer ──────────────────────────────────────────────
  const renderParagraphs = (text: string) => {
    if (!text) return
    setStyle("body")

    const paragraphs = text.split(/\n+/)

    for (const paragraph of paragraphs) {
      const trimmed = paragraph.trim()
      if (!trimmed) continue

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
        // ensureSpace may have triggered newPage which restores activeStyle,
        // so we're guaranteed to be in "body" style here. Still — be
        // paranoid for future-proofing, as it's cheap.
        doc.text(line, TYPO.margin, y)
        y += TYPO.bodyLineHeight
      }
      y += TYPO.paragraphGap
    }
  }

  // ── Chapter heading renderer ────────────────────────────────────────
  const renderChapterHeading = (chapterTitle: string) => {
    setStyle("heading")

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

  setStyle("title")
  const titleLines = doc.splitTextToSize(safeTitle, MAX_W)
  doc.text(titleLines, PAGE_W / 2, y, { align: "center" })
  y += (Array.isArray(titleLines) ? titleLines.length : 1) * TYPO.titleLineHeight

  setStyle("author")
  doc.text(safeAuthor, PAGE_W / 2, y, { align: "center" })
  y += TYPO.titleLineHeight

  setStyle("meta")
  doc.text(`Language: ${language}`, PAGE_W / 2, y, { align: "center" })

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
    setStyle("body")
    doc.setTextColor(150)
    doc.text("(No content available)", PAGE_W / 2, PAGE_H / 2, {
      align: "center",
    })
    doc.setTextColor(0)
  }

  addFooter()

  return doc.output("arraybuffer") as ArrayBuffer
}

// ---------------------------------------------------------------------------
// Title deduplication
// ---------------------------------------------------------------------------

/**
 * Removes leading lines from `content` that are redundant title echoes.
 * See stripLeadingTitleEchoes comments in the previous version for the
 * motivation — this is the same logic, unchanged.
 */
function stripLeadingTitleEchoes(content: string, chapterTitle: string): string {
  if (!content) return content

  const lines = content.split("\n")
  const titleNorm = normalizeForCompare(chapterTitle)

  const titleVariants = new Set<string>()
  titleVariants.add(titleNorm)

  const beforeComma = titleNorm.split(",")[0].trim()
  if (beforeComma) titleVariants.add(beforeComma)

  const numMatch = titleNorm.match(/^(kapitel|chapter|teil|part)\s*(\d+)/)
  if (numMatch) {
    titleVariants.add(numMatch[2])
    titleVariants.add(numMatch[0])
  }

  let i = 0
  let removed = 0
  const MAX_REMOVE = 8
  const MAX_SCAN = 8

  while (i < lines.length && removed < MAX_REMOVE && i < MAX_SCAN + removed) {
    const original = lines[i]
    const stripped = original.trim()

    if (!stripped) {
      i++
      continue
    }

    if (looksLikeTitleEcho(stripped, titleVariants)) {
      lines[i] = ""
      removed++
      i++
      continue
    }

    break
  }

  if (removed === 0) return content

  return lines.join("\n").replace(/^\s*\n+/, "")
}

function looksLikeTitleEcho(line: string, titleVariants: Set<string>): boolean {
  const normalized = normalizeForCompare(line)
  if (!normalized) return true

  if (line.length > 120) return false

  if (titleVariants.has(normalized)) return true

  if (/^(kapitel|chapter|teil|part|prolog|prologue|epilog|epilogue)$/.test(normalized))
    return true

  if (/^(kapitel|chapter|teil|part)\s*[\divxlcdm]+\.?$/.test(normalized)) return true

  if (/^\d{1,4}$/.test(normalized)) return true
  if (/^[ivxlcdm]+$/.test(normalized)) return true

  if (/^(kapitel|chapter|teil|part)\s*\d+\s*[,:\-–—]/.test(normalized)) {
    for (const variant of titleVariants) {
      if (normalized.startsWith(variant) || variant.startsWith(normalized)) {
        return true
      }
    }
    return true
  }

  return false
}

function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/["'„‚“”‘’«»‹›()\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}