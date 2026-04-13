/**
 * EPUB Translator — DeepL API (recommended) with Google Translate fallback
 *
 * Key features:
 * 1. Only translates filtered chapters (no TOC, copyright, previews, etc.)
 * 2. DeepL API for best EN→DE quality
 * 3. Chapter-aware translation preserves context
 * 4. Exponential backoff retry
 * 5. Logs character savings from filtering
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TranslationChapter {
  title: string
  content: string
}

interface TranslationResult {
  translatedContent: string
  translatedChapters: TranslationChapter[]
  provider: "deepl" | "google"
  stats: {
    totalChunks: number
    totalCharacters: number
    durationMs: number
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Translates book content from English to German.
 *
 * Pass `filteredChapters` (from the content filter) so only actual
 * book content is translated — saving API costs and improving quality.
 */
export async function translateBook(
  fullContent: string,
  chapters: TranslationChapter[] = [],
): Promise<TranslationResult> {
  const start = Date.now()

  const useDeepL = !!process.env.DEEPL_API_KEY
  const provider = useDeepL ? "deepl" : "google"

  const charCount = chapters.length > 0
    ? chapters.reduce((sum, ch) => sum + ch.title.length + ch.content.length, 0)
    : fullContent.length

  console.log(
    `[translator] Using ${provider} — ${chapters.length} chapters, ${charCount} chars to translate`,
  )

  let translatedChapters: TranslationChapter[] = []
  let translatedContent: string

  if (chapters.length > 0) {
    // ── Translate each chapter individually for better context ─────────
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i]
      console.log(
        `[translator] Chapter ${i + 1}/${chapters.length}: "${ch.title}" (${ch.content.length} chars)`,
      )

      const [translatedTitle, translatedBody] = await Promise.all([
        translateText(ch.title, provider),
        translateText(ch.content, provider),
      ])

      translatedChapters.push({
        title: translatedTitle,
        content: translatedBody,
      })
    }

    translatedContent = translatedChapters
      .map((ch) => ch.content)
      .join("\n\n")
  } else {
    // ── No chapter structure — translate flat content ──────────────────
    translatedContent = await translateText(fullContent, provider)
  }

  const stats = {
    totalChunks: 0,
    totalCharacters: charCount,
    durationMs: Date.now() - start,
  }

  console.log(
    `[translator] Done in ${(stats.durationMs / 1000).toFixed(1)}s via ${provider}`,
  )

  return { translatedContent, translatedChapters, provider, stats }
}

/** Legacy wrapper for backwards compatibility */
export async function translateToGerman(text: string): Promise<string> {
  const result = await translateBook(text)
  return result.translatedContent
}

// ---------------------------------------------------------------------------
// Core translation with chunking
// ---------------------------------------------------------------------------

async function translateText(
  text: string,
  provider: "deepl" | "google",
): Promise<string> {
  if (!text || text.trim().length === 0) return ""

  const MAX_CHUNK = provider === "deepl" ? 4500 : 2000
  const chunks = chunkText(text, MAX_CHUNK)
  const CONCURRENCY = provider === "deepl" ? 3 : 2
  const DELAY = provider === "deepl" ? 500 : 1500

  const translated: string[] = new Array(chunks.length)

  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      batch.map((chunk, idx) =>
        translateChunkWithRetry(chunk, i + idx, provider),
      ),
    )
    results.forEach((result, idx) => {
      translated[i + idx] = result
    })

    if (i + CONCURRENCY < chunks.length) {
      await sleep(DELAY)
    }
  }

  return translated.join(" ")
}

// ---------------------------------------------------------------------------
// Chunk-level translation with retries
// ---------------------------------------------------------------------------

async function translateChunkWithRetry(
  chunk: string,
  index: number,
  provider: "deepl" | "google",
  maxRetries = 3,
): Promise<string> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return provider === "deepl"
        ? await translateChunkDeepL(chunk, index)
        : await translateChunkGoogle(chunk, index)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      const backoff = Math.min(1000 * 2 ** attempt, 10_000)
      console.warn(
        `[translator] Chunk ${index} attempt ${attempt + 1} failed: ${lastError.message}. Retrying in ${backoff}ms…`,
      )
      await sleep(backoff)
    }
  }

  throw new Error(
    `Translation failed for chunk ${index} after ${maxRetries} attempts: ${lastError?.message}`,
  )
}

// ---------------------------------------------------------------------------
// DeepL API
// ---------------------------------------------------------------------------

async function translateChunkDeepL(
  chunk: string,
  index: number,
): Promise<string> {
  const apiKey = process.env.DEEPL_API_KEY!
  const baseUrl = apiKey.endsWith(":fx")
    ? "https://api-free.deepl.com"
    : "https://api.deepl.com"

  const response = await fetch(`${baseUrl}/v2/translate`, {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: [chunk],
      source_lang: "EN",
      target_lang: "DE",
      formality: "default",
      preserve_formatting: true,
      tag_handling: "html",
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`DeepL HTTP ${response.status}: ${body}`)
  }

  const data = await response.json()
  const translated = data.translations?.[0]?.text
  if (!translated) {
    throw new Error(`DeepL returned empty translation for chunk ${index}`)
  }
  return translated
}

// ---------------------------------------------------------------------------
// Google Translate (fallback)
// ---------------------------------------------------------------------------

async function translateChunkGoogle(
  chunk: string,
  index: number,
): Promise<string> {
  const url = new URL("https://translate.googleapis.com/translate_a/single")
  url.searchParams.append("client", "gtx")
  url.searchParams.append("sl", "en")
  url.searchParams.append("tl", "de")
  url.searchParams.append("dt", "t")
  url.searchParams.append("q", chunk)

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { "User-Agent": "Mozilla/5.0" },
  })

  if (!response.ok) {
    throw new Error(`Google Translate HTTP ${response.status}`)
  }

  const data = await response.json()

  if (data?.[0] && Array.isArray(data[0])) {
    const parts = data[0].map((part: any[]) => part[0]).filter(Boolean)
    const translation = parts.join("")
    if (translation) return translation
  }

  throw new Error(
    `Google Translate returned unexpected format for chunk ${index}`,
  )
}

// ---------------------------------------------------------------------------
// Text chunking — respects sentence boundaries
// ---------------------------------------------------------------------------

function chunkText(text: string, maxSize: number): string[] {
  if (text.length <= maxSize) return [text]

  const chunks: string[] = []
  let current = ""

  const sentences = text.match(/[^.!?]+[.!?]+[\s]*/g)

  if (!sentences) {
    const words = text.split(/\s+/)
    for (const word of words) {
      if (current.length + word.length + 1 > maxSize && current.length > 0) {
        chunks.push(current.trim())
        current = word
      } else {
        current += (current ? " " : "") + word
      }
    }
    if (current.trim()) chunks.push(current.trim())
    return chunks
  }

  for (const sentence of sentences) {
    if (sentence.length > maxSize) {
      if (current.trim()) {
        chunks.push(current.trim())
        current = ""
      }
      chunks.push(...chunkText(sentence, maxSize))
      continue
    }

    if (current.length + sentence.length > maxSize && current.length > 0) {
      chunks.push(current.trim())
      current = sentence
    } else {
      current += sentence
    }
  }

  if (current.trim()) chunks.push(current.trim())
  return chunks
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}