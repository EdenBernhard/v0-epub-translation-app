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

      const chapterTitle = extractChapterTitle(
        htmlContent,
        textContent,
        filePath,
        allChapters.length,
      )

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
// Multi-strategy chapter title extraction
// ---------------------------------------------------------------------------

/**
 * Extracts a meaningful chapter title from an HTML document.
 *
 * Front-matter pages (dedication, copyright, about author) often lack proper
 * heading tags — they're styled with CSS classes on <p> or <div> elements.
 * We try multiple strategies in order of reliability.
 */
export function extractChapterTitle(
  htmlContent: string,
  plainText: string,
  filePath: string,
  fallbackIndex: number,
): string {
  // Strategy 1: First <h1>, <h2>, or <h3> (strongest signal)
  const headingMatch = htmlContent.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)
  if (headingMatch) {
    const cleaned = cleanTitle(headingMatch[1])
    if (cleaned) return cleaned
  }

  // Strategy 2: <title> element in <head>
  const titleTagMatch = htmlContent.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (titleTagMatch) {
    const cleaned = cleanTitle(titleTagMatch[1])
    // Only use <title> if it's short and not just a generic like "Untitled"
    if (
      cleaned &&
      cleaned.length < 80 &&
      !/^(untitled|document|page\s*\d+)$/i.test(cleaned)
    ) {
      return cleaned
    }
  }

  // Strategy 3: <body> / <section> / <div> / <p> with a telling class name.
  // Publishers commonly use classes like "dedication", "toc", "copyright".
  const classMatch = htmlContent.match(
    /<(?:body|section|div|p)[^>]*class\s*=\s*["']([^"']+)["'][^>]*>/i,
  )
  if (classMatch) {
    const classList = classMatch[1].toLowerCase()
    const classTitle = mapClassToTitle(classList)
    if (classTitle) return classTitle
  }

  // Strategy 3b: epub:type attribute (EPUB 3 semantic markup)
  const epubTypeMatch = htmlContent.match(/epub:type\s*=\s*["']([^"']+)["']/i)
  if (epubTypeMatch) {
    const typeTitle = mapEpubTypeToTitle(epubTypeMatch[1].toLowerCase())
    if (typeTitle) return typeTitle
  }

  // Strategy 4: Infer from filename — many publishers name files semantically
  // (e.g. "dedication.xhtml", "about_author.xhtml", "ch01.xhtml")
  const filenameTitle = inferTitleFromFilename(filePath)
  if (filenameTitle) return filenameTitle

  // Strategy 5: First meaningful sentence of body text, truncated.
  // Useful as a "content fingerprint" so the filter's content-based rules
  // can kick in (e.g. a page starting with "For my mother").
  const firstLine = plainText
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && l.length < 120)
  if (firstLine) {
    return firstLine.length > 80 ? firstLine.substring(0, 80) : firstLine
  }

  // Strategy 6: Default
  return `Chapter ${fallbackIndex + 1}`
}

/**
 * Maps CSS class tokens to a canonical title.
 * Returns a title the filter can recognize.
 */
function mapClassToTitle(classList: string): string | null {
  const tokens = classList.split(/\s+/)

  for (const token of tokens) {
    // Table of contents
    if (/^(toc|contents|table-?of-?contents)$/.test(token)) return "Table of Contents"

    // Dedication
    if (/^(dedication|widmung)$/.test(token)) return "Dedication"

    // Copyright
    if (/^(copyright|legal|imprint|impressum|colophon)$/.test(token))
      return "Copyright"

    // Foreword / Preface / Introduction
    if (/^(foreword|preface|prologue|introduction)$/.test(token))
      return token.charAt(0).toUpperCase() + token.slice(1)

    // Acknowledgements
    if (/^(acknowledgements?|acknowledgments?|danksagung)$/.test(token))
      return "Acknowledgements"

    // About the author
    if (/^(about-?(the-?)?author|author-?bio|biography)$/.test(token))
      return "About the Author"

    // Cover / Title page
    if (/^(cover|title-?page|half-?title)$/.test(token)) return "Cover"

    // Epigraph
    if (/^(epigraph|motto)$/.test(token)) return "Epigraph"

    // Praise
    if (/^(praise|reviews?|blurbs?)$/.test(token)) return "Praise"
  }

  return null
}

/**
 * EPUB 3 `epub:type` semantic markup maps directly to section types.
 * https://idpf.org/epub/vocab/structure/
 */
function mapEpubTypeToTitle(epubType: string): string | null {
  if (/\btoc\b/.test(epubType)) return "Table of Contents"
  if (/\bdedication\b/.test(epubType)) return "Dedication"
  if (/\bcopyright-page\b/.test(epubType)) return "Copyright"
  if (/\bforeword\b/.test(epubType)) return "Foreword"
  if (/\bpreface\b/.test(epubType)) return "Preface"
  if (/\bprologue\b/.test(epubType)) return "Prologue"
  if (/\backnowledgments?\b/.test(epubType)) return "Acknowledgements"
  if (/\bepigraph\b/.test(epubType)) return "Epigraph"
  if (/\bcolophon\b/.test(epubType)) return "Colophon"
  if (/\bcover\b/.test(epubType)) return "Cover"
  if (/\btitlepage\b/.test(epubType)) return "Title Page"
  if (/\bappendix\b/.test(epubType)) return "Appendix"
  if (/\bglossary\b/.test(epubType)) return "Glossary"
  if (/\bindex\b/.test(epubType)) return "Index"
  if (/\bbibliography\b/.test(epubType)) return "Bibliography"
  if (/\b(backmatter|afterword)\b/.test(epubType)) return "Afterword"
  return null
}

/**
 * Infer a chapter title from the filename (without extension).
 * Only returns a title if the filename strongly hints at section type.
 */
function inferTitleFromFilename(filePath: string): string | null {
  const filename = (filePath.split("/").pop() || "").toLowerCase()
  const base = filename.replace(/\.(x?html?|xhtml)$/, "").replace(/[-_]/g, " ")

  if (/\b(dedication|widmung)\b/.test(base)) return "Dedication"
  if (/\b(copyright|legal|imprint|impressum|colophon)\b/.test(base))
    return "Copyright"
  if (/\b(foreword|preface|prologue)\b/.test(base))
    return base.replace(/\s+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase())
  if (/\bintroduction\b/.test(base)) return "Introduction"
  if (/\b(acknowledg(e)?ments?)\b/.test(base)) return "Acknowledgements"
  if (/\b(about.?(the.?)?author|author.?bio|biography)\b/.test(base))
    return "About the Author"
  if (/\b(toc|contents|tableofcontents)\b/.test(base))
    return "Table of Contents"
  if (/\b(epigraph|motto)\b/.test(base)) return "Epigraph"
  if (/\b(praise|reviews?)\b/.test(base)) return "Praise"
  if (/\b(also.?by|other.?books)\b/.test(base)) return "Also by This Author"

  return null
}

/**
 * Strip HTML, decode entities, normalize whitespace, and validate.
 */
function cleanTitle(raw: string): string {
  const stripped = raw
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!stripped) return ""
  return decodeHtmlEntities(stripped)
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