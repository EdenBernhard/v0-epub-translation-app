import { initMobiFile } from "@lingo-reader/mobi-parser"
import { extractTextFromHtml, type BookContent, type BookMetadata } from "./epub-parser"
import { filterBookContent } from "./content-filter"

/**
 * MOBI Parser — with content filtering
 *
 * Same filtering as EPUB parser:
 * - Removes forewords, copyright, previews, book ads, etc.
 * - Keeps only actual story/content chapters
 */

export async function parseMobi(buffer: Buffer): Promise<BookContent> {
  try {
    const uint8Array = new Uint8Array(buffer)
    const mobi = await initMobiFile(uint8Array)

    const mobiMeta = mobi.getMetadata()

    const metadata: BookMetadata = {
      title: mobiMeta.title || "Unknown Title",
      author: mobiMeta.author || "Unknown Author",
      language: mobiMeta.language || "en",
    }

    const spine = mobi.getSpine()
    const allChapters: Array<{ title: string; content: string }> = []

    for (let i = 0; i < spine.length; i++) {
      const chapter = mobi.loadChapter(spine[i].id)
      if (!chapter?.html) continue

      const textContent = extractTextFromHtml(chapter.html)
      if (!textContent.trim()) continue

      // Extract chapter title
      const titleMatch = chapter.html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)
      let chapterTitle = spine[i].title || `Chapter ${i + 1}`
      if (titleMatch) {
        const extracted = titleMatch[1].replace(/<[^>]+>/g, "").trim()
        if (extracted) chapterTitle = extracted
      }

      allChapters.push({ title: chapterTitle, content: textContent })
    }

    // ── Filter chapters ─────────────────────────────────────────────────
    const filterResult = filterBookContent(allChapters)

    console.log(
      `[mobi-parser] Filter: ${filterResult.stats.keptChapters}/${filterResult.stats.totalChapters} chapters kept, ` +
        `${filterResult.stats.savedCharCount} chars saved (${filterResult.stats.savedPercent}%)`,
    )
    if (filterResult.removed.length > 0) {
      console.log(
        `[mobi-parser] Removed:`,
        filterResult.removed.map((ch) => `"${ch.title}" (${ch.filterReason})`),
      )
    }

    const filteredContent = filterResult.chapters
      .map((ch) => ch.content)
      .join("\n\n")
      .trim()

    return {
      metadata,
      content: filteredContent || "No content could be extracted from this MOBI file.",
      chapters: filterResult.chapters,
      allChapters,
      filterStats: {
        totalChapters: filterResult.stats.totalChapters,
        keptChapters: filterResult.stats.keptChapters,
        removedChapters: filterResult.stats.removedChapters,
        savedCharCount: filterResult.stats.savedCharCount,
        savedPercent: filterResult.stats.savedPercent,
        removedTitles: filterResult.removed.map(
          (ch) => `${ch.title} (${ch.filterReason})`,
        ),
      },
    }
  } catch (error) {
    console.error("[mobi-parser] Error:", error)
    return {
      metadata: { title: "Unknown Title", author: "Unknown Author", language: "en" },
      content:
        "Error: Failed to parse MOBI file. The file may be corrupted or in an unsupported format.",
      chapters: [],
    }
  }
}