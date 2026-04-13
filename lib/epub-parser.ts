import JSZip from "jszip"
import { filterBookContent, shouldSkipSpineFile } from "./content-filter"

/**
 * EPUB Parser — with intelligent content filtering
 *
 * Two-stage filtering:
 * 1. Spine-level: Skip files by filename (cover.xhtml, toc.xhtml, etc.)
 *    → Saves parsing time, no HTML extraction needed
 * 2. Chapter-level: Filter extracted chapters by title + content heuristics
 *    → Catches forewords, previews, copyright, book ads, etc.
 *
 * The result contains both `chapters` (filtered) and `allChapters` (unfiltered)
 * so the original content is preserved for display, only translation is filtered.
 */

export interface BookMetadata {
  title: string
  author: string
  language: string
}

export interface BookContent {
  metadata: BookMetadata
  /** Full text of filtered chapters only (for translation) */
  content: string
  /** Filtered chapters — actual book content only */
  chapters: Array<{ title: string; content: string }>
  /** All chapters including removed ones (for reference/display) */
  allChapters?: Array<{ title: string; content: string }>
  /** Filtering stats */
  filterStats?: {
    totalChapters: number
    keptChapters: number
    removedChapters: number
    savedCharCount: number
    savedPercent: number
    removedTitles: string[]
  }
}

export async function parseEpub(buffer: Buffer): Promise<BookContent> {
  try {
    const zip = await JSZip.loadAsync(buffer)

    // ── Find OPF file via container.xml ─────────────────────────────────
    let opfFile: JSZip.JSZipObject | null = null
    let opfPath = ""

    const containerFile = zip.file("META-INF/container.xml")
    if (containerFile) {
      const containerXml = await containerFile.async("string")
      const opfPathMatch = containerXml.match(/full-path="([^"]+)"/)
      if (opfPathMatch) {
        opfPath = opfPathMatch[1]
        opfFile = zip.file(opfPath)
      }
    }

    // Fallback: search for any .opf file
    if (!opfFile) {
      zip.forEach((relativePath, file) => {
        if (relativePath.endsWith(".opf") && !opfFile) {
          opfFile = file
          opfPath = relativePath
        }
      })
    }

    const metadata: BookMetadata = {
      title: "Unknown Title",
      author: "Unknown Author",
      language: "en",
    }

    const contentFiles: string[] = []
    const skippedFiles: Array<{ path: string; reason: string }> = []

    if (opfFile) {
      const opfContent = await opfFile.async("string")

      // Extract metadata (handle CDATA and attributes)
      const titleMatch = opfContent.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/)
      const authorMatch = opfContent.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/)
      const langMatch = opfContent.match(/<dc:language[^>]*>([^<]+)<\/dc:language>/)

      if (titleMatch) metadata.title = decodeHtmlEntities(titleMatch[1].trim())
      if (authorMatch) metadata.author = decodeHtmlEntities(authorMatch[1].trim())
      if (langMatch) metadata.language = langMatch[1].trim()

      // Build manifest map: id → href (handle both attribute orders)
      const manifestItems = new Map<string, string>()
      const manifestRegex = /<item\s[^>]*?id="([^"]+)"[^>]*?href="([^"]+)"[^>]*>/g
      const manifestRegex2 = /<item\s[^>]*?href="([^"]+)"[^>]*?id="([^"]+)"[^>]*>/g

      for (const match of opfContent.matchAll(manifestRegex)) {
        manifestItems.set(match[1], match[2])
      }
      for (const match of opfContent.matchAll(manifestRegex2)) {
        manifestItems.set(match[2], match[1])
      }

      // Build spine reading order — with Stage 1 filtering
      const spineRegex = /<itemref[^>]+idref="([^"]+)"[^>]*>/g
      const basePath = opfPath.substring(0, opfPath.lastIndexOf("/") + 1)

      for (const match of opfContent.matchAll(spineRegex)) {
        const href = manifestItems.get(match[1])
        if (href) {
          const decodedHref = decodeURIComponent(href)
          const fullPath = basePath + decodedHref

          // ── Stage 1: Skip by filename ─────────────────────────────
          const skipReason = shouldSkipSpineFile(fullPath)
          if (skipReason) {
            skippedFiles.push({ path: fullPath, reason: skipReason })
            continue
          }

          contentFiles.push(fullPath)
        }
      }
    }

    // Fallback: get all HTML/XHTML files (no spine-level filtering possible)
    if (contentFiles.length === 0) {
      zip.forEach((relativePath) => {
        if (
          (relativePath.endsWith(".html") ||
            relativePath.endsWith(".xhtml") ||
            relativePath.endsWith(".htm")) &&
          !relativePath.includes("nav.") &&
          !relativePath.includes("toc.")
        ) {
          const skipReason = shouldSkipSpineFile(relativePath)
          if (!skipReason) {
            contentFiles.push(relativePath)
          }
        }
      })
      contentFiles.sort()
    }

    if (skippedFiles.length > 0) {
      console.log(
        `[epub-parser] Skipped ${skippedFiles.length} spine files:`,
        skippedFiles.map((f) => `${f.reason}: ${f.path}`),
      )
    }

    // ── Extract text content ────────────────────────────────────────────
    const allChapters: Array<{ title: string; content: string }> = []

    for (const filePath of contentFiles) {
      const file = zip.file(filePath) || zip.file(encodeURI(filePath))
      if (!file) continue

      const htmlContent = await file.async("string")
      const textContent = extractTextFromHtml(htmlContent)

      if (!textContent.trim()) continue

      // Extract chapter title — support nested tags
      const titleMatch = htmlContent.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)
      let chapterTitle = `Chapter ${allChapters.length + 1}`
      if (titleMatch) {
        const extracted = titleMatch[1].replace(/<[^>]+>/g, "").trim()
        if (extracted) chapterTitle = decodeHtmlEntities(extracted)
      }

      allChapters.push({ title: chapterTitle, content: textContent })
    }

    // ── Stage 2: Filter chapters by title + content ─────────────────────
    const filterResult = filterBookContent(allChapters)

    console.log(
      `[epub-parser] Filter: ${filterResult.stats.keptChapters}/${filterResult.stats.totalChapters} chapters kept, ` +
        `${filterResult.stats.savedCharCount} chars saved (${filterResult.stats.savedPercent}%)`,
    )
    if (filterResult.removed.length > 0) {
      console.log(
        `[epub-parser] Removed:`,
        filterResult.removed.map((ch) => `"${ch.title}" (${ch.filterReason})`),
      )
    }

    const filteredContent = filterResult.chapters
      .map((ch) => ch.content)
      .join("\n\n")
      .trim()

    return {
      metadata,
      content: filteredContent || "No content could be extracted from this EPUB file.",
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
    console.error("[epub-parser] Error:", error)
    return {
      metadata: { title: "Unknown Title", author: "Unknown Author", language: "en" },
      content:
        "Error: Failed to parse EPUB file. The file may be corrupted or in an unsupported format.",
      chapters: [],
    }
  }
}

// ---------------------------------------------------------------------------
// Shared HTML → Text utility (also used by mobi-parser)
// ---------------------------------------------------------------------------

export function extractTextFromHtml(html: string): string {
  let text = html

  // Remove script and style blocks
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")

  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, "")

  // Replace block elements with newlines (including self-closing <br/>)
  text = text.replace(
    /<\/?(p|div|h[1-6]|br|li|blockquote|section|article|tr)[^>]*\/?>/gi,
    "\n",
  )

  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, "")

  // Decode HTML entities
  text = decodeHtmlEntities(text)

  // Clean up whitespace
  text = text.replace(/\n\s*\n\s*\n/g, "\n\n")
  text = text.replace(/[ \t]+/g, " ")
  text = text
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
  text = text.trim()

  return text
}

// ---------------------------------------------------------------------------
// HTML entity decoder
// ---------------------------------------------------------------------------

function decodeHtmlEntities(text: string): string {
  const namedEntities: Record<string, string> = {
    "&nbsp;": " ",
    "&quot;": '"',
    "&apos;": "'",
    "&lt;": "<",
    "&gt;": ">",
    "&amp;": "&",
    "&mdash;": "—",
    "&ndash;": "–",
    "&lsquo;": "\u2018",
    "&rsquo;": "\u2019",
    "&ldquo;": "\u201C",
    "&rdquo;": "\u201D",
    "&hellip;": "…",
    "&copy;": "©",
    "&reg;": "®",
    "&trade;": "™",
    "&deg;": "°",
    "&times;": "×",
    "&divide;": "÷",
    "&euro;": "€",
    "&pound;": "£",
    "&yen;": "¥",
    "&sect;": "§",
    "&para;": "¶",
    "&bull;": "•",
    "&ensp;": "\u2002",
    "&emsp;": "\u2003",
    "&thinsp;": "\u2009",
    "&shy;": "\u00AD",
  }

  let result = text
  for (const [entity, char] of Object.entries(namedEntities)) {
    result = result.replaceAll(entity, char)
  }

  result = result.replace(/&#(\d+);/g, (_, num) => {
    const code = parseInt(num, 10)
    return code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : ""
  })

  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    const code = parseInt(hex, 16)
    return code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : ""
  })

  return result
}