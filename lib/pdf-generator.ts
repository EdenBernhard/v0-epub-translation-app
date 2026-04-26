import jsPDF from "jspdf"
import { normalizeForPdf } from "./text-normalizer"

/**
 * PDF Generator — DIAGNOSTIC BUILD
 *
 * Two changes vs. previous version:
 *
 * 1. PER-LINE style reset. Before every single line of body text, font,
 *    size, and color are re-applied. This is more aggressive than the
 *    previous "per-paragraph" approach. If jsPDF is silently changing
 *    state somewhere we don't see, this catches it.
 *
 * 2. Paragraph debug logging. The first 60 chars of each paragraph are
 *    logged with their byte hex values. If a paragraph contains hidden
 *    Unicode that's making the renderer behave weirdly, we'll see it.
 *
 * Once the problem is identified and fixed, the debug logging can be
 * removed. The per-line style reset has negligible cost and should stay.
 */

// ---------------------------------------------------------------------------
// Typography constants
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

// Set to false to silence the diagnostic logs once the issue is identified.
const DEBUG_LOG = true

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
  let activeStyle: StyleName = "body"

  // ── Style management ────────────────────────────────────────────────
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
    applyStyle(activeStyle)
  }

  const ensureSpace = (needed: number) => {
    if (y + needed > PAGE_H - TYPO.margin - 10) newPage()
  }

  // ── Diagnostic logger ───────────────────────────────────────────────
  const logParagraph = (paragraph: string, chapterIdx: number, paraIdx: number) => {
    if (!DEBUG_LOG) return
    const head = paragraph.slice(0, 60)
    const bytes = Array.from(paragraph.slice(0, 20))
      .map((c) => {
        const code = c.codePointAt(0) ?? 0
        return code.toString(16).padStart(4, "0")
      })
      .join(" ")
    console.log(
      `[pdf-debug] ch${chapterIdx} p${paraIdx} (len=${paragraph.length}): "${head}" | hex: ${bytes}`,
    )
  }

  // ── Paragraph renderer (per-line style reset) ───────────────────────
  const renderParagraphs = (text: string, chapterIdx: number) => {
    if (!text) return
    setStyle("body")

    const paragraphs = text.split(/\n+/)
    let paraIdx = 0

    for (const paragraph of paragraphs) {
      const trimmed = paragraph.trim()
      if (!trimmed) continue

      logParagraph(trimmed, chapterIdx, paraIdx++)

      let lines: string[]
      try {
        // Make sure splitTextToSize itself is using the right size by
        // re-asserting the body style first.
        applyStyle("body")
        const result = doc.splitTextToSize(trimmed, MAX_W)
        lines = Array.isArray(result) ? result : [String(result)]
      } catch {
        console.warn(
          `[pdf-generator] splitTextToSize failed (len=${trimmed.length}), falling back`,
        )
        lines = []
        for (let i = 0; i < trimmed.length; i += 90) {
          lines.push(trimmed.slice(i, i + 90))
        }
      }

      for (const line of lines) {
        ensureSpace(TYPO.bodyLineHeight + 2)

        // ── KEY CHANGE: re-apply body style before EVERY line. ──
        // If jsPDF is mutating state somewhere we don't track, this
        // forces it back to known-good values for every render call.
        applyStyle("body")

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
    applyStyle("heading") // re-assert after potential page break
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
    let chapterIdx = 0
    for (const chapter of safeChapters) {
      newPage()
      renderChapterHeading(chapter.title)
      renderParagraphs(chapter.content, chapterIdx)
      chapterIdx++
    }
  } else if (safeContent) {
    newPage()
    renderParagraphs(safeContent, 0)
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
// Title deduplication (unchanged)
// ---------------------------------------------------------------------------

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