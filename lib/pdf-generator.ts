import jsPDF from "jspdf"
import { normalizeForPdf } from "./text-normalizer"

/**
 * PDF Generator — improvements:
 *
 * 1. Uses chapter structure when available for proper headings
 * 2. Adds page numbers
 * 3. Better paragraph spacing and line height
 * 4. Handles German special characters (ä, ö, ü, ß) properly
 *    Note: jsPDF's default helvetica font handles basic Latin + German chars.
 *    For full Unicode support, you'd need to embed a custom font (e.g. Noto Sans).
 */

interface PDFOptions {
  title: string
  author: string
  normalizedContent: string
  language: string
  normalizedChapters?: Array<{ title: string; normalizedContent: string }>
}

export async function generatePDF(options: PDFOptions): Promise<Buffer> {
  const { title, author, normalizedContent, language, normalizedChapters } = options

  const normalizednormalizedContent = normalizeForPdf(normalizedContent)
  const normalizednormalizedChapters = normalizedChapters?.map((ch) => ({
    title: normalizeForPdf(ch.title),
    normalizedContent: normalizeForPdf(ch.normalizedContent),
  }))

  const doc = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4",
  })

  doc.setProperties({
    title,
    author,
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

  // ── Helper: add page number footer ──────────────────────────────────
  function addFooter() {
    doc.setFontSize(8)
    doc.setFont("helvetica", "normal")
    doc.setTextColor(150)
    doc.text(`${pageNum}`, PAGE_W / 2, FOOTER_Y, { align: "center" })
    doc.setTextColor(0)
  }

  // ── Helper: new page ────────────────────────────────────────────────
  function newPage() {
    addFooter()
    doc.addPage()
    pageNum++
    y = MARGIN
  }

  // ── Helper: check if we need a new page ─────────────────────────────
  function ensureSpace(needed: number) {
    if (y + needed > PAGE_H - MARGIN - 10) {
      newPage()
    }
  }

  // ── Title page ──────────────────────────────────────────────────────
  y = PAGE_H / 3

  doc.setFontSize(24)
  doc.setFont("helvetica", "bold")
  const titleLines = doc.splitTextToSize(title, MAX_W)
  doc.text(titleLines, PAGE_W / 2, y, { align: "center" })
  y += titleLines.length * 12

  doc.setFontSize(14)
  doc.setFont("helvetica", "italic")
  doc.text(author, PAGE_W / 2, y, { align: "center" })
  y += 12

  doc.setFontSize(10)
  doc.setFont("helvetica", "normal")
  doc.setTextColor(100)
  doc.text(`Language: ${language}`, PAGE_W / 2, y, { align: "center" })
  doc.setTextColor(0)

  addFooter()

  // ── normalizedContent ─────────────────────────────────────────────────────────
  if (normalizedChapters && normalizedChapters.length > 0) {
    // Render with chapter structure
    for (const chapter of normalizedChapters) {
      newPage()

      // Chapter title
      doc.setFontSize(16)
      doc.setFont("helvetica", "bold")
      const chTitleLines = doc.splitTextToSize(chapter.title, MAX_W)
      ensureSpace(chTitleLines.length * 9 + 10)
      doc.text(chTitleLines, MARGIN, y)
      y += chTitleLines.length * 9 + 6

      // Chapter normalizedContent
      doc.setFontSize(11)
      doc.setFont("helvetica", "normal")
      renderParagraphs(doc, chapter.normalizedContent, MARGIN, MAX_W, LINE_H, PARA_GAP)
    }
  } else {
    // Flat normalizedContent — start on new page after title
    newPage()
    doc.setFontSize(11)
    doc.setFont("helvetica", "normal")
    renderParagraphs(doc, normalizedContent, MARGIN, MAX_W, LINE_H, PARA_GAP)
  }

  // Final page footer
  addFooter()

  // ── Helper: render paragraphs with page breaks ──────────────────────
  function renderParagraphs(
    _doc: jsPDF,
    text: string,
    margin: number,
    maxW: number,
    lineH: number,
    paraGap: number,
  ) {
    const paragraphs = text.split(/\n+/)

    for (const paragraph of paragraphs) {
      const trimmed = paragraph.trim()
      if (!trimmed) continue

      const lines = _doc.splitTextToSize(trimmed, maxW)

      for (const line of lines) {
        ensureSpace(lineH + 2)
        _doc.text(line, margin, y)
        y += lineH
      }

      y += paraGap
    }
  }

  const pdfData = doc.output("arraybuffer")
  return Buffer.from(pdfData)
}