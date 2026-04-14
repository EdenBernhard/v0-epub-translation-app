/**
 * EPUB Translator — DeepL with automatic Google Translate fallback
 *
 * Fallback behavior:
 * - Starts with DeepL if DEEPL_API_KEY is set
 * - On quota exceeded (HTTP 456) or rate limit (HTTP 429): switches to Google
 * - Already-translated chapters keep their DeepL translation
 * - Remaining chapters continue with Google — no restart needed
 * - Logs clearly which provider was used for each chapter
 *
 * Speed optimizations:
 * - Parallel chapter translation (2-3 chapters simultaneously)
 * - High chunk concurrency (5 DeepL, 3 Google)
 * - Short delays between batches (200ms DeepL, 800ms Google)
 * - Title + content translated in parallel per chapter
 * - Progress logging with ETA
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
  provider: "deepl" | "google" | "mixed"
  stats: {
    totalChunks: number
    totalCharacters: number
    durationMs: number
    deeplChapters: number
    googleChapters: number
    fallbackTriggered: boolean
  }
}

type Provider = "deepl" | "google"

// Shared state: once DeepL quota is hit, all subsequent calls use Google
let activeProvider: Provider = "deepl"
let fallbackTriggered = false

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function translateBook(
  fullContent: string,
  chapters: TranslationChapter[] = [],
): Promise<TranslationResult> {
  const start = Date.now()

  // Reset provider state for each book
  const hasDeepL = !!process.env.DEEPL_API_KEY
  activeProvider = hasDeepL ? "deepl" : "google"
  fallbackTriggered = false

  let deeplChapters = 0
  let googleChapters = 0

  const charCount = chapters.length > 0
    ? chapters.reduce((sum, ch) => sum + ch.title.length + ch.content.length, 0)
    : fullContent.length

  console.log(
    `[translator] Starting with ${activeProvider} — ${chapters.length} chapters, ${charCount} chars`,
  )

  let translatedChapters: TranslationChapter[] = []
  let translatedContent: string

  if (chapters.length > 0) {
    translatedChapters = new Array(chapters.length)
    let completedChapters = 0

    for (let i = 0; i < chapters.length;) {
      // Concurrency depends on current provider (may change mid-loop)
      const CHAPTER_CONCURRENCY = activeProvider === "deepl" ? 3 : 2
      const batch = chapters.slice(i, i + CHAPTER_CONCURRENCY)

      const results = await Promise.all(
        batch.map(async (ch, idx) => {
          const chapterIndex = i + idx
          const startCh = Date.now()
          const usedProvider = activeProvider // capture before it might change

          try {
            const [translatedTitle, translatedBody] = await Promise.all([
              ch.title.length < 200
                ? translateSingleChunk(ch.title)
                : translateText(ch.title),
              translateText(ch.content),
            ])

            completedChapters++
            const elapsed = Date.now() - start
            const avgPerChapter = elapsed / completedChapters
            const remaining = (chapters.length - completedChapters) * avgPerChapter

            if (usedProvider === "deepl" || activeProvider === "deepl") {
              deeplChapters++
            } else {
              googleChapters++
            }

            console.log(
              `[translator] Chapter ${chapterIndex + 1}/${chapters.length} done [${activeProvider}] ` +
              `(${ch.content.length} chars in ${((Date.now() - startCh) / 1000).toFixed(1)}s) ` +
              `— ETA: ${(remaining / 1000).toFixed(0)}s`,
            )

            return {
              index: chapterIndex,
              title: translatedTitle,
              content: translatedBody,
              success: true as const,
            }
          } catch (err) {
            // If quota error and we haven't fallen back yet, this will be
            // caught in translateChunkWithRetry which triggers the fallback.
            // Re-throw so Promise.all rejects and we can retry the chapter.
            throw err
          }
        }),
      ).catch(async (err) => {
        // If the batch failed due to quota, the fallback was already triggered
        // in translateChunkWithRetry. Retry the entire batch with new provider.
        if (fallbackTriggered) {
          console.log(
            `[translator] Retrying batch starting at chapter ${i + 1} with ${activeProvider}`,
          )
          // Return null to signal retry
          return null
        }
        throw err
      })

      if (results === null) {
        // Retry this batch index — don't increment i
        continue
      }

      for (const r of results) {
        if (r.success) {
          translatedChapters[r.index] = { title: r.title, content: r.content }
        }
      }

      i += batch.length
    }

    translatedContent = translatedChapters
      .map((ch) => ch.content)
      .join("\n\n")
  } else {
    translatedContent = await translateText(fullContent)
    if (activeProvider === "deepl") deeplChapters = 1
    else googleChapters = 1
  }

  const usedProvider = fallbackTriggered
    ? "mixed"
    : (activeProvider as "deepl" | "google")

  const stats = {
    totalChunks: 0,
    totalCharacters: charCount,
    durationMs: Date.now() - start,
    deeplChapters,
    googleChapters,
    fallbackTriggered,
  }

  console.log(
    `[translator] Done: ${charCount} chars in ${(stats.durationMs / 1000).toFixed(1)}s ` +
    `(${Math.round(charCount / (stats.durationMs / 1000))} chars/sec) ` +
    `— provider: ${usedProvider}` +
    (fallbackTriggered
      ? ` (DeepL: ${deeplChapters} chapters, Google: ${googleChapters} chapters)`
      : ""),
  )

  return { translatedContent, translatedChapters, provider: usedProvider, stats }
}

/** Legacy wrapper */
export async function translateToGerman(text: string): Promise<string> {
  const result = await translateBook(text)
  return result.translatedContent
}

// ---------------------------------------------------------------------------
// Core translation with chunking
// ---------------------------------------------------------------------------

async function translateText(text: string): Promise<string> {
  if (!text || text.trim().length === 0) return ""

  const MAX_CHUNK = activeProvider === "deepl" ? 4500 : 3000
  const chunks = chunkText(text, MAX_CHUNK)

  if (chunks.length === 1) {
    return translateSingleChunk(chunks[0])
  }

  const CONCURRENCY = activeProvider === "deepl" ? 5 : 3
  const DELAY = activeProvider === "deepl" ? 200 : 800

  const translated: string[] = new Array(chunks.length)

  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      batch.map((chunk, idx) =>
        translateChunkWithRetry(chunk, i + idx),
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

async function translateSingleChunk(text: string): Promise<string> {
  if (!text || text.trim().length === 0) return ""
  return translateChunkWithRetry(text, 0)
}

// ---------------------------------------------------------------------------
// Retry logic with automatic fallback
// ---------------------------------------------------------------------------

async function translateChunkWithRetry(
  chunk: string,
  index: number,
  maxRetries = 3,
): Promise<string> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return activeProvider === "deepl"
        ? await translateChunkDeepL(chunk, index)
        : await translateChunkGoogle(chunk, index)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))

      // ── DeepL quota/rate limit → switch to Google ───────────────────
      if (
        activeProvider === "deepl" &&
        isQuotaOrRateLimitError(lastError)
      ) {
        console.warn(
          `[translator] DeepL quota/rate limit hit: ${lastError.message}`,
        )
        console.log(
          `[translator] ⚡ Switching to Google Translate for remaining content`,
        )
        activeProvider = "google"
        fallbackTriggered = true

        // Immediately retry this chunk with Google (no backoff needed)
        try {
          return await translateChunkGoogle(chunk, index)
        } catch (googleErr) {
          lastError = googleErr instanceof Error
            ? googleErr
            : new Error(String(googleErr))
          // Fall through to normal retry logic
        }
      }

      // Client errors (other than quota) → fail fast
      if (
        lastError.message.includes("HTTP 4") &&
        !isQuotaOrRateLimitError(lastError)
      ) {
        throw lastError
      }

      const backoff = Math.min(1000 * 2 ** attempt, 8000)
      console.warn(
        `[translator] Chunk ${index} attempt ${attempt + 1} failed [${activeProvider}]: ${lastError.message}. Retry in ${backoff}ms`,
      )
      await sleep(backoff)
    }
  }

  throw new Error(
    `Translation failed for chunk ${index} after ${maxRetries} attempts: ${lastError?.message}`,
  )
}

/**
 * Check if error is a DeepL quota or rate limit error.
 * - HTTP 456: Quota exceeded
 * - HTTP 429: Too many requests
 * - HTTP 403 with "quota": Quota-related forbidden
 */
function isQuotaOrRateLimitError(err: Error): boolean {
  const msg = err.message.toLowerCase()
  return (
    msg.includes("http 456") ||
    msg.includes("http 429") ||
    (msg.includes("http 403") && msg.includes("quota")) ||
    msg.includes("quota exceeded") ||
    msg.includes("character limit") ||
    msg.includes("too many requests")
  )
}

// ---------------------------------------------------------------------------
// DeepL API
// ---------------------------------------------------------------------------

async function translateChunkDeepL(
  chunk: string,
  _index: number,
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
    throw new Error(`DeepL returned empty translation for chunk ${_index}`)
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
// Text chunking
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