/**
 * EPUB Translator — single-chapter translation
 *
 * Called once per chapter by the /api/translate/[id]/chapter route.
 * Each call translates one chapter title + content and returns quickly.
 * DeepL → Google fallback on quota errors.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChapterTranslationResult {
  translatedTitle: string
  translatedContent: string
  provider: "deepl" | "google"
  durationMs: number
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Translates a single chapter (title + content).
 * Tries DeepL first, falls back to Google on quota errors.
 */
export async function translateChapterText(
  title: string,
  content: string,
): Promise<ChapterTranslationResult> {
  const start = Date.now()
  const hasDeepL = !!process.env.DEEPL_API_KEY
  let provider: "deepl" | "google" = hasDeepL ? "deepl" : "google"

  try {
    // Translate title + content in parallel
    const [translatedTitle, translatedContent] = await Promise.all([
      translateText(title, provider),
      translateText(content, provider),
    ])

    return {
      translatedTitle,
      translatedContent,
      provider,
      durationMs: Date.now() - start,
    }
  } catch (err) {
    // If DeepL failed with quota, retry with Google
    if (provider === "deepl" && isQuotaError(err)) {
      console.warn("[translator] DeepL quota hit, falling back to Google")
      provider = "google"

      const [translatedTitle, translatedContent] = await Promise.all([
        translateText(title, provider),
        translateText(content, provider),
      ])

      return {
        translatedTitle,
        translatedContent,
        provider,
        durationMs: Date.now() - start,
      }
    }
    throw err
  }
}

/** Legacy wrapper for backwards compatibility */
export async function translateToGerman(text: string): Promise<string> {
  const result = await translateChapterText("", text)
  return result.translatedContent
}

/** Legacy wrapper */
export async function translateBook(
  fullContent: string,
  chapters: Array<{ title: string; content: string }> = [],
): Promise<{
  translatedContent: string
  translatedChapters: Array<{ title: string; content: string }>
  provider: "deepl" | "google"
  stats: { totalChunks: number; totalCharacters: number; durationMs: number }
}> {
  const start = Date.now()
  const translatedChapters = []

  for (const ch of chapters) {
    const result = await translateChapterText(ch.title, ch.content)
    translatedChapters.push({
      title: result.translatedTitle,
      content: result.translatedContent,
    })
  }

  if (chapters.length === 0) {
    const result = await translateChapterText("", fullContent)
    return {
      translatedContent: result.translatedContent,
      translatedChapters: [],
      provider: result.provider,
      stats: {
        totalChunks: 0,
        totalCharacters: fullContent.length,
        durationMs: Date.now() - start,
      },
    }
  }

  return {
    translatedContent: translatedChapters.map((c) => c.content).join("\n\n"),
    translatedChapters,
    provider: translatedChapters[translatedChapters.length - 1]
      ? "deepl"
      : "google",
    stats: {
      totalChunks: 0,
      totalCharacters: chapters.reduce((s, c) => s + c.content.length, 0),
      durationMs: Date.now() - start,
    },
  }
}

// ---------------------------------------------------------------------------
// Core text translation with chunking
// ---------------------------------------------------------------------------

async function translateText(
  text: string,
  provider: "deepl" | "google",
): Promise<string> {
  if (!text || text.trim().length === 0) return ""

  const MAX_CHUNK = provider === "deepl" ? 4500 : 3000
  const chunks = chunkText(text, MAX_CHUNK)

  // Translate all chunks with concurrency
  const CONCURRENCY = provider === "deepl" ? 5 : 3
  const DELAY = provider === "deepl" ? 150 : 600
  const translated: string[] = new Array(chunks.length)

  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      batch.map((chunk, idx) =>
        translateChunkWithRetry(chunk, provider),
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
// Chunk translation with retry
// ---------------------------------------------------------------------------

async function translateChunkWithRetry(
  chunk: string,
  provider: "deepl" | "google",
  maxRetries = 3,
): Promise<string> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return provider === "deepl"
        ? await translateChunkDeepL(chunk)
        : await translateChunkGoogle(chunk)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))

      // Quota/rate errors bubble up for fallback handling
      if (isQuotaError(err)) throw lastError

      // Other 4xx = fail fast
      if (lastError.message.includes("HTTP 4")) throw lastError

      const backoff = Math.min(1000 * 2 ** attempt, 6000)
      await sleep(backoff)
    }
  }

  throw new Error(`Translation failed after ${maxRetries} attempts: ${lastError?.message}`)
}

function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : ""
  return (
    msg.includes("http 456") ||
    msg.includes("http 429") ||
    msg.includes("quota") ||
    msg.includes("too many requests") ||
    msg.includes("character limit")
  )
}

// ---------------------------------------------------------------------------
// DeepL API
// ---------------------------------------------------------------------------

async function translateChunkDeepL(chunk: string): Promise<string> {
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
  if (!translated) throw new Error("DeepL returned empty translation")
  return translated
}

// ---------------------------------------------------------------------------
// Google Translate (fallback)
// ---------------------------------------------------------------------------

async function translateChunkGoogle(chunk: string): Promise<string> {
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

  throw new Error("Google Translate returned unexpected format")
}

// ---------------------------------------------------------------------------
// Chunking
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
      if (current.trim()) { chunks.push(current.trim()); current = "" }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}