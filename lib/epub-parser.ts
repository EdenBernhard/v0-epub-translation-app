import JSZip from "jszip"

interface EpubMetadata {
  title: string
  author: string
  language: string
}

interface EpubContent {
  metadata: EpubMetadata
  content: string
  chapters: Array<{ title: string; content: string }>
}

export async function parseEpub(buffer: Buffer): Promise<EpubContent> {
  try {
    const zip = await JSZip.loadAsync(buffer)

    // Find and parse content.opf to get metadata and reading order
    let opfFile: JSZip.JSZipObject | null = null
    let opfPath = ""

    // Find container.xml first
    const containerFile = zip.file("META-INF/container.xml")
    if (containerFile) {
      const containerXml = await containerFile.async("string")
      const opfPathMatch = containerXml.match(/full-path="([^"]+)"/)
      if (opfPathMatch) {
        opfPath = opfPathMatch[1]
        opfFile = zip.file(opfPath)
      }
    }

    // Fallback: search for .opf file
    if (!opfFile) {
      zip.forEach((relativePath, file) => {
        if (relativePath.endsWith(".opf") && !opfFile) {
          opfFile = file
          opfPath = relativePath
        }
      })
    }

    const metadata: EpubMetadata = {
      title: "Unknown Title",
      author: "Unknown Author",
      language: "en",
    }

    const contentFiles: string[] = []

    if (opfFile) {
      const opfContent = await opfFile.async("string")

      // Extract metadata
      const titleMatch = opfContent.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/)
      const authorMatch = opfContent.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/)
      const langMatch = opfContent.match(/<dc:language[^>]*>([^<]+)<\/dc:language>/)

      if (titleMatch) metadata.title = titleMatch[1]
      if (authorMatch) metadata.author = authorMatch[1]
      if (langMatch) metadata.language = langMatch[1]

      // Extract spine/reading order
      const manifestItems = new Map<string, string>()
      const manifestMatches = opfContent.matchAll(/<item[^>]+id="([^"]+)"[^>]+href="([^"]+)"[^>]*>/g)
      for (const match of manifestMatches) {
        manifestItems.set(match[1], match[2])
      }

      const spineMatches = opfContent.matchAll(/<itemref[^>]+idref="([^"]+)"[^>]*>/g)
      const basePath = opfPath.substring(0, opfPath.lastIndexOf("/") + 1)

      for (const match of spineMatches) {
        const href = manifestItems.get(match[1])
        if (href) {
          contentFiles.push(basePath + href)
        }
      }
    }

    // If no spine found, get all HTML/XHTML files
    if (contentFiles.length === 0) {
      zip.forEach((relativePath) => {
        if (
          (relativePath.endsWith(".html") || relativePath.endsWith(".xhtml") || relativePath.endsWith(".htm")) &&
          !relativePath.includes("nav.") &&
          !relativePath.includes("toc.")
        ) {
          contentFiles.push(relativePath)
        }
      })
      contentFiles.sort()
    }

    // Extract text content from each file
    const chapters: Array<{ title: string; content: string }> = []
    let fullContent = ""

    for (const filePath of contentFiles) {
      const file = zip.file(filePath)
      if (file) {
        const htmlContent = await file.async("string")
        const textContent = extractTextFromHtml(htmlContent)

        if (textContent.trim()) {
          // Try to extract chapter title
          const titleMatch = htmlContent.match(/<h[1-3][^>]*>([^<]+)<\/h[1-3]>/)
          const chapterTitle = titleMatch ? titleMatch[1] : `Chapter ${chapters.length + 1}`

          chapters.push({
            title: chapterTitle,
            content: textContent,
          })

          fullContent += textContent + "\n\n"
        }
      }
    }

    return {
      metadata,
      content: fullContent.trim() || "No content could be extracted from this EPUB file.",
      chapters,
    }
  } catch (error) {
    console.error("[v0] EPUB parsing error:", error)
    return {
      metadata: {
        title: "Unknown Title",
        author: "Unknown Author",
        language: "en",
      },
      content: "Error: Failed to parse EPUB file. The file may be corrupted or in an unsupported format.",
      chapters: [],
    }
  }
}

function extractTextFromHtml(html: string): string {
  // Remove script and style tags
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")

  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, "")

  // Replace common block elements with newlines
  text = text.replace(/<\/?(p|div|h[1-6]|br|li)[^>]*>/gi, "\n")

  // Remove remaining HTML tags
  text = text.replace(/<[^>]+>/g, "")

  // Decode HTML entities
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")

  // Clean up whitespace
  text = text.replace(/\n\s*\n/g, "\n\n") // Multiple newlines to double
  text = text.replace(/[ \t]+/g, " ") // Multiple spaces to single
  text = text.trim()

  return text
}
