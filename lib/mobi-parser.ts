import { initMobiFile } from "@lingo-reader/mobi-parser"

interface MobiMetadata {
  title: string
  author: string
  language: string
}

interface MobiContent {
  metadata: MobiMetadata
  content: string
  chapters: Array<{ title: string; content: string }>
}

export async function parseMobi(buffer: Buffer): Promise<MobiContent> {
  try {
    // Convert Buffer to Uint8Array for the parser
    const uint8Array = new Uint8Array(buffer)

    // Initialize the MOBI file
    const mobi = await initMobiFile(uint8Array)

    // Extract metadata
    const metadata: MobiMetadata = {
      title: mobi.getMetadata().title || "Unknown Title",
      author: mobi.getMetadata().author || "Unknown Author",
      language: mobi.getMetadata().language || "en",
    }

    // Get the spine (list of chapters)
    const spine = mobi.getSpine()

    // Extract content from all chapters
    const chapters: Array<{ title: string; content: string }> = []
    let fullContent = ""

    for (let i = 0; i < spine.length; i++) {
      const chapter = mobi.loadChapter(spine[i].id)

      if (chapter && chapter.html) {
        const textContent = extractTextFromHtml(chapter.html)

        if (textContent.trim()) {
          // Try to extract chapter title from the HTML or use spine title
          const titleMatch = chapter.html.match(/<h[1-3][^>]*>([^<]+)<\/h[1-3]>/)
          const chapterTitle = titleMatch ? titleMatch[1] : spine[i].title || `Chapter ${i + 1}`

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
      content: fullContent.trim() || "No content could be extracted from this MOBI file.",
      chapters,
    }
  } catch (error) {
    console.error("[v0] MOBI parsing error:", error)
    return {
      metadata: {
        title: "Unknown Title",
        author: "Unknown Author",
        language: "en",
      },
      content: "Error: Failed to parse MOBI file. The file may be corrupted or in an unsupported format.",
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
