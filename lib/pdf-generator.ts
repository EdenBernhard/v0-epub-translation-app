import jsPDF from "jspdf"

interface PDFOptions {
  title: string
  author: string
  content: string
  language: string
}

export async function generatePDF(options: PDFOptions): Promise<Buffer> {
  const { title, author, content, language } = options

  // Create new PDF document
  const doc = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4",
  })

  // Set document properties
  doc.setProperties({
    title,
    author,
    subject: `EPUB Translation - ${language}`,
    creator: "EPUB Translation App",
  })

  // Page dimensions
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 20
  const maxWidth = pageWidth - 2 * margin

  let yPosition = margin

  // Add title
  doc.setFontSize(20)
  doc.setFont("helvetica", "bold")
  const titleLines = doc.splitTextToSize(title, maxWidth)
  doc.text(titleLines, margin, yPosition)
  yPosition += titleLines.length * 10

  // Add author
  doc.setFontSize(12)
  doc.setFont("helvetica", "italic")
  doc.text(`by ${author}`, margin, yPosition)
  yPosition += 10

  // Add language indicator
  doc.setFontSize(10)
  doc.setFont("helvetica", "normal")
  doc.text(`Language: ${language}`, margin, yPosition)
  yPosition += 15

  // Add content
  doc.setFontSize(11)
  doc.setFont("helvetica", "normal")

  // Split content into paragraphs
  const paragraphs = content.split(/\n+/)

  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) continue

    const lines = doc.splitTextToSize(paragraph, maxWidth)

    for (const line of lines) {
      // Check if we need a new page
      if (yPosition + 10 > pageHeight - margin) {
        doc.addPage()
        yPosition = margin
      }

      doc.text(line, margin, yPosition)
      yPosition += 7
    }

    // Add spacing between paragraphs
    yPosition += 5
  }

  // Convert to buffer
  const pdfData = doc.output("arraybuffer")
  return Buffer.from(pdfData)
}
