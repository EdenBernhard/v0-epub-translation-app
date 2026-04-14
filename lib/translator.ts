/**
 * EPUB Translator — High-Performance Version
 *
 * Speed optimizations:
 * 1. Parallel chapter translation (up to 3 chapters simultaneously)
 * 2. Higher chunk concurrency (5 for DeepL, 3 for Google)
 * 3. Reduced delays between batches (200ms DeepL, 800ms Google)
 * 4. Larger chunks = fewer API calls
 * 5. Title + content translated in parallel per chapter
 * 6. Progress logging with ETA
 * 7. Skip retry on 4xx errors (quota, auth) — fail fast
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
    `[translator] Using ${provider} — ${chapters.length} chapters, ${charCount} chars`,
  )

  let translatedChapters: TranslationChapter[] = []
  let translatedContent: string

  if (chapters.length > 0) {
    // ── Parallel chapter translation ──────────────────────────────────
    const CHAPTER_CONCURRENCY = provider === "deepl" ? 3 : 2
    translatedChapters = new Array(chapters.length)
    let completedChapters = 0

    for (let i = 0; i < chapters.length; i += CHAPTER_CONCURRENCY) {
      const batch = chapters.slice(i, i + CHAPTER_CONCURRENCY)

      const results = await Promise.all(
        batch.map(async (ch, idx) => {
          const chapterIndex = i + idx
          const startCh = Date.now()

          // Title + content in parallel
          const [translatedTitle, translatedBody] = await Promise.all([
            ch.title.length < 200
              ? translateSingleChunk(ch.title, provider)
              : translateText(ch.title, provider),
            translateText(ch.content, provider),
          ])

          completedChapters++
          const elapsed = Date.now() - start
          const avgPerChapter = elapsed / completedChapters
          const remaining = (chapters.length - completedChapters) * avgPerChapter

          console.log(
            `[translator] Chapter ${chapterIndex + 1}/${chapters.length} done ` +
            `(${ch.content.length} chars in ${((Date.now() - startCh) / 1000).toFixed(1)}s) ` +
            `— ETA: ${(remaining / 1000).toFixed(0)}s`,
          )

          return { index: chapterIndex, title: translatedTitle, content: translatedBody }
        }),
      )

      for (const r of results) {
        translatedChapters[r.index] = { title: r.title, content: r.content }
      }
    }

    translatedContent = translatedChapters
      .map((ch) => ch.content)
      .join("\n\n")
  } else {
    translatedContent = await translateText(fullContent, provider)
  }

  const stats = {
    totalChunks: 0,
    totalCharacters: charCount,
    durationMs: Date.now() - start,
  }

  console.log(
    `[translator] Done: ${charCount} chars in ${(stats.durationMs / 1000).toFixed(1)}s ` +
    `(${Math.round(charCount / (stats.durationMs / 1000))} chars/sec) via ${provider}`,
  )

  return { translatedContent, translatedChapters, provider, stats }
}

/** Legacy wrapper */
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

  const MAX_CHUNK = provider === "deepl" ? 4500 : 3000
  const chunks = chunkText(text, MAX_CHUNK)

  if (chunks.length === 1) {
    return translateSingleChunk(chunks[0], provider)
  }

  const CONCURRENCY = provider === "deepl" ? 5 : 3
  const DELAY = provider === "deepl" ? 200 : 800

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

async function translateSingleChunk(
  text: string,
  provider: "deepl" | "google",
): Promise<string> {
  if (!text || text.trim().length === 0) return ""
  return translateChunkWithRetry(text, 0, provider)
}

// ---------------------------------------------------------------------------
// Retry logic
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

      // Fail fast on client errors (auth, quota, bad request)
      if (lastError.message.includes("HTTP 4")) {
        throw lastError
      }

      const backoff = Math.min(1000 * 2 ** attempt, 8000)
      console.warn(
        `[translator] Chunk ${index} attempt ${attempt + 1} failed: ${lastError.message}. Retry in ${backoff}ms`,
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