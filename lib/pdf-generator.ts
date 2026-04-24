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
 * Returns a plain ArrayBuffer — NextResponse's BodyInit accepts it directly
 * without generic-type conflicts. Previous attempts with Buffer and
 * Uint8Array hit TypeScript overload resolution bugs caused by newer
 * @types/node versions declaring generic variants incompatible with the
 * DOM types Next.js expects.
 */

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
    .map((ch) => ({
      title: normalizeForPdf(String(ch.title || "")) || "Untitled Chapter",
      content: normalizeForPdf(String(ch.content || "")),
    }))
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
  const MARGIN = 20
  const MAX_W = PAGE_W - 2 * MARGIN
  const LINE_H = 6
  const PARA_GAP = 4
  const FOOTER_Y = PAGE_H - 10

  let y = MARGIN
  let pageNum = 1

  // ── Helpers ─────────────────────────────────────────────────────────
  const addFooter = () => {
    doc.setFontSize(8)
    doc.setFont("helvetica", "normal")
    doc.setTextColor(150)
    doc.text(`${pageNum}`, PAGE_W / 2, FOOTER_Y, { align: "center" })
    doc.setTextColor(0)
  }

  const newPage = () => {
    addFooter()
    doc.addPage()
    pageNum++
    y = MARGIN
  }

  const ensureSpace = (needed: number) => {
    if (y + needed > PAGE_H - MARGIN - 10) newPage()
  }

  const renderParagraphs = (text: string) => {
    if (!text) return
    const paragraphs = text.split(/\n+/)
    doc.setFontSize(11)
    doc.setFont("helvetica", "normal")

    for (const paragraph of paragraphs) {
      const trimmed = paragraph.trim()
      if (!trimmed) continue

      let lines: string[]
      try {
        const result = doc.splitTextToSize(trimmed, MAX_W)
        lines = Array.isArray(result) ? result : [String(result)]
      } catch (err) {
        console.warn(
          `[pdf-generator] splitTextToSize failed on paragraph (len=${trimmed.length}), falling back to raw split`,
        )
        lines = []
        for (let i = 0; i < trimmed.length; i += 90) {
          lines.push(trimmed.slice(i, i + 90))
        }
      }

      for (const line of lines) {
        ensureSpace(LINE_H + 2)
        doc.text(line, MARGIN, y)
        y += LINE_H
      }
      y += PARA_GAP
    }
  }

  // ── Title page ──────────────────────────────────────────────────────
  y = PAGE_H / 3

  doc.setFontSize(24)
  doc.setFont("helvetica", "bold")
  const titleLines = doc.splitTextToSize(safeTitle, MAX_W)
  doc.text(titleLines, PAGE_W / 2, y, { align: "center" })
  y += (Array.isArray(titleLines) ? titleLines.length : 1) * 12

  doc.setFontSize(14)
  doc.setFont("helvetica", "italic")
  doc.text(safeAuthor, PAGE_W / 2, y, { align: "center" })
  y += 12

  doc.setFontSize(10)
  doc.setFont("helvetica", "normal")
  doc.setTextColor(100)
  doc.text(`Language: ${language}`, PAGE_W / 2, y, { align: "center" })
  doc.setTextColor(0)

  addFooter()

  // ── Content ─────────────────────────────────────────────────────────
  if (safeChapters.length > 0) {
    for (const chapter of safeChapters) {
      newPage()

      doc.setFontSize(16)
      doc.setFont("helvetica", "bold")

      let chTitleLines: string[]
      try {
        const result = doc.splitTextToSize(chapter.title, MAX_W)
        chTitleLines = Array.isArray(result) ? result : [String(result)]
      } catch {
        chTitleLines = [chapter.title.slice(0, 100)]
      }

      ensureSpace(chTitleLines.length * 9 + 10)
      doc.text(chTitleLines, MARGIN, y)
      y += chTitleLines.length * 9 + 6

      renderParagraphs(chapter.content)
    }
  } else if (safeContent) {
    newPage()
    renderParagraphs(safeContent)
  } else {
    newPage()
    doc.setFontSize(11)
    doc.setTextColor(150)
    doc.text("(No content available)", PAGE_W / 2, PAGE_H / 2, {
      align: "center",
    })
    doc.setTextColor(0)
  }

  addFooter()

  // ── Serialize ───────────────────────────────────────────────────────
  // Return an ArrayBuffer — it's part of DOM's BodyInit union without
  // any generic variants, so no overload-resolution ambiguity.
  return doc.output("arraybuffer") as ArrayBuffer
}