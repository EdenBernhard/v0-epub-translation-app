/**
 * EPUB Translator — single-chapter translation
 *
 * Called once per chapter by the /api/translate/[id]/chapter route.
 * Each call translates one chapter title + content and returns quickly.
 *
 * Provider strategy:
 * - Tries DeepL first (if DEEPL_API_KEY set).
 * - Falls back to Google on quota errors (HTTP 456/429) — always.
 * - Falls back to Google on DeepL 5xx / network errors — opt-in via
 *   FALLBACK_ON_ERROR=true environment variable.
 *
 * Process-wide state:
 * - Once DeepL's quota is hit, a module-level flag keeps all subsequent
 *   chapters on Google for the life of the Node process. This avoids
 *   paying the cost of ~N failed DeepL requests for a multi-chapter book
 *   after quota is exhausted.
 *
 * Performance:
 * - Title + content chunks are batched into ONE DeepL request where possible.
 * - Inter-batch delay removed for DeepL, reduced to 250ms for Google.
 * - tag_handling only enabled when HTML tags are actually detected.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import { normalizeForTranslation } from "./text-normalizer"

interface ChapterTranslationResult {
  translatedTitle: string
  translatedContent: string
  provider: "deepl" | "google"
  durationMs: number
}

export interface DeepLUsage {
  characterCount: number
  characterLimit: number
  remaining: number
  /** True if we have enough budget to at least attempt — heuristic. */
  hasCapacity: boolean
}

// ---------------------------------------------------------------------------
// Process-wide state
// ---------------------------------------------------------------------------

/**
 * Sticky flag: once DeepL has signalled quota exhaustion, the whole process
 * routes everything to Google. Resets on process restart (or via
 * resetQuotaFlag() for tests).
 */
let deeplQuotaExhausted = false

/** Exposed for tests / manual recovery (e.g. after a wait). */
export function resetDeepLQuotaFlag(): void {
  deeplQuotaExhausted = false
}

/** Read-only inspection — used by route handlers for logging. */
export function isDeepLQuotaExhausted(): boolean {
  return deeplQuotaExhausted
}

// ---------------------------------------------------------------------------
// DeepL usage / capacity check
// ---------------------------------------------------------------------------

/**
 * Query DeepL's /usage endpoint.
 *
 * Cheap (single GET, no text processing on their side). Use before a big
 * translation job to know if there's any chance DeepL can handle it —
 * saves a whole book's worth of failed requests if the monthly quota is
 * already gone.
 *
 * Returns `null` if no API key or the endpoint is unreachable — caller
 * should treat that as "capacity unknown" and proceed with normal logic.
 */
export async function checkDeepLUsage(): Promise<DeepLUsage | null> {
  const apiKey = process.env.DEEPL_API_KEY
  if (!apiKey) return null

  const baseUrl = apiKey.endsWith(":fx")
    ? "https://api-free.deepl.com"
    : "https://api.deepl.com"

  try {
    const response = await fetch(`${baseUrl}/v2/usage`, {
      method: "GET",
      headers: { Authorization: `DeepL-Auth-Key ${apiKey}` },
      // Short timeout — if DeepL's usage endpoint is slow we shouldn't block.
      signal: AbortSignal.timeout(5000),
    })

    if (!response.ok) return null

    const data = await response.json()
    const characterCount = Number(data.character_count ?? 0)
    const characterLimit = Number(data.character_limit ?? 0)
    const remaining = Math.max(0, characterLimit - characterCount)

    // Treat <1% remaining as effectively exhausted.
    const hasCapacity = characterLimit === 0 // no limit tier
      ? true
      : remaining > characterLimit * 0.01

    if (!hasCapacity) {
      // Flip the sticky flag now so chapter translations don't even try.
      deeplQuotaExhausted = true
    }

    return { characterCount, characterLimit, remaining, hasCapacity }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Translates a single chapter (title + content).
 */
export async function translateChapterText(
  title: string,
  content: string,
): Promise<ChapterTranslationResult> {
  const start = Date.now()
  const safeTitle = normalizeForTranslation(title || "")
  const safeContent = normalizeForTranslation(content || "")
  const hasDeepL = !!process.env.DEEPL_API_KEY
  const fallbackOnError = process.env.FALLBACK_ON_ERROR === "true"

  // Decide starting provider:
  // - No key → Google
  // - Key but process-wide flag says quota gone → Google (skip the doomed DeepL call)
  // - Otherwise → DeepL
  let provider: "deepl" | "google" =
    hasDeepL && !deeplQuotaExhausted ? "deepl" : "google"

  try {
    const { translatedTitle, translatedContent } = await translateTitleAndContent(
      safeTitle,      
      safeContent,
      provider,
    )

    return {
      translatedTitle,
      translatedContent,
      provider,
      durationMs: Date.now() - start,
    }
  } catch (err) {
    if (provider !== "deepl") throw err

    const isQuota = isQuotaError(err)
    const isServerError = isDeepLServerError(err)

    // Quota → always flip flag + fall back
    if (isQuota) {
      deeplQuotaExhausted = true
      console.warn(
        "[translator] DeepL quota exhausted — all subsequent chapters will use Google",
      )
    }

    const shouldFallback = isQuota || (fallbackOnError && isServerError)

    if (!shouldFallback) throw err

    if (!isQuota) {
      console.warn(
        `[translator] DeepL ${isServerError ? "server error" : "error"} — falling back to Google for this chapter`,
      )
    }

    provider = "google"
    const { translatedTitle, translatedContent } = await translateTitleAndContent(
      title,
      content,
      provider,
    )

    return {
      translatedTitle,
      translatedContent,
      provider,
      durationMs: Date.now() - start,
    }
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
  const providersUsed = new Set<"deepl" | "google">()

  for (const ch of chapters) {
    const result = await translateChapterText(ch.title, ch.content)
    translatedChapters.push({
      title: result.translatedTitle,
      content: result.translatedContent,
    })
    providersUsed.add(result.provider)
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

  // If both providers were used it's "mixed" conceptually, but the legacy
  // signature only supports one — prefer DeepL if it was used at all.
  const provider: "deepl" | "google" = providersUsed.has("deepl")
    ? "deepl"
    : "google"

  return {
    translatedContent: translatedChapters.map((c) => c.content).join("\n\n"),
    translatedChapters,
    provider,
    stats: {
      totalChunks: 0,
      totalCharacters: chapters.reduce((s, c) => s + c.content.length, 0),
      durationMs: Date.now() - start,
    },
  }
}

// ---------------------------------------------------------------------------
// Title + Content translation (batched where possible)
// ---------------------------------------------------------------------------

async function translateTitleAndContent(
  title: string,
  content: string,
  provider: "deepl" | "google",
): Promise<{ translatedTitle: string; translatedContent: string }> {
  const safeTitle = title || ""
  const safeContent = content || ""

  if (provider === "deepl") {
    const MAX_CHUNK = 4500
    const contentChunks = chunkText(safeContent, MAX_CHUNK)

    // Fast path: title + single content chunk in ONE request
    if (contentChunks.length <= 1) {
      const texts = [safeTitle, contentChunks[0] || ""].filter(
        (t) => t.length > 0,
      )

      if (texts.length === 0) {
        return { translatedTitle: "", translatedContent: "" }
      }

      const translated = await translateBatchDeepLWithRetry(texts)

      if (safeTitle && (contentChunks[0] || "")) {
        return {
          translatedTitle: translated[0] ?? "",
          translatedContent: translated[1] ?? "",
        }
      }
      if (safeTitle) {
        return { translatedTitle: translated[0] ?? "", translatedContent: "" }
      }
      return { translatedTitle: "", translatedContent: translated[0] ?? "" }
    }

    // Multi-chunk path
    const [translatedTitle, translatedContent] = await Promise.all([
      translateText(safeTitle, provider),
      translateText(safeContent, provider),
    ])
    return { translatedTitle, translatedContent }
  }

  // Google path
  const [translatedTitle, translatedContent] = await Promise.all([
    translateText(safeTitle, provider),
    translateText(safeContent, provider),
  ])
  return { translatedTitle, translatedContent }
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

  if (provider === "deepl") {
    if (chunks.length <= 50) {
      return (await translateBatchDeepLWithRetry(chunks)).join(" ")
    }
  }

  const CONCURRENCY = provider === "deepl" ? 5 : 3
  const DELAY = provider === "deepl" ? 0 : 250
  const translated: string[] = new Array(chunks.length)

  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      batch.map((chunk) => translateChunkWithRetry(chunk, provider)),
    )
    results.forEach((result, idx) => {
      translated[i + idx] = result
    })

    if (DELAY > 0 && i + CONCURRENCY < chunks.length) {
      await sleep(DELAY)
    }
  }

  return translated.join(" ")
}

// ---------------------------------------------------------------------------
// Retry wrappers
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

      if (isQuotaError(err)) throw lastError

      // DeepL 5xx: retry with backoff (translateChapterText handles fallback if enabled)
      if (isDeepLServerError(err)) {
        const backoff = Math.min(1000 * 2 ** attempt, 6000)
        await sleep(backoff)
        continue
      }

      // Other 4xx = fail fast
      if (lastError.message.includes("HTTP 4")) throw lastError

      const backoff = Math.min(1000 * 2 ** attempt, 6000)
      await sleep(backoff)
    }
  }

  throw new Error(
    `Translation failed after ${maxRetries} attempts: ${lastError?.message}`,
  )
}

async function translateBatchDeepLWithRetry(
  texts: string[],
  maxRetries = 3,
): Promise<string[]> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await translateBatchDeepL(texts)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (isQuotaError(err)) throw lastError
      if (isDeepLServerError(err)) {
        const backoff = Math.min(1000 * 2 ** attempt, 6000)
        await sleep(backoff)
        continue
      }
      if (lastError.message.includes("HTTP 4")) throw lastError
      const backoff = Math.min(1000 * 2 ** attempt, 6000)
      await sleep(backoff)
    }
  }

  throw new Error(
    `DeepL batch translation failed after ${maxRetries} attempts: ${lastError?.message}`,
  )
}

// ---------------------------------------------------------------------------
// Error classifiers
// ---------------------------------------------------------------------------

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

function isDeepLServerError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : ""
  // Match HTTP 500-599 from DeepL specifically.
  if (/DeepL HTTP 5\d\d/.test(msg)) return true
  // Also treat network/timeout errors as server-side issues.
  const lower = msg.toLowerCase()
  return (
    lower.includes("etimedout") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("fetch failed") ||
    lower.includes("network")
  )
}

// ---------------------------------------------------------------------------
// DeepL API
// ---------------------------------------------------------------------------

function containsHtml(text: string): boolean {
  return /<[a-zA-Z!/][^>]*>/.test(text)
}

async function translateBatchDeepL(texts: string[]): Promise<string[]> {
  if (texts.length === 0) return []

  const apiKey = process.env.DEEPL_API_KEY!
  const baseUrl = apiKey.endsWith(":fx")
    ? "https://api-free.deepl.com"
    : "https://api.deepl.com"

  const body: Record<string, unknown> = {
    text: texts,
    source_lang: "EN",
    target_lang: "DE",
    formality: "default",
    preserve_formatting: true,
  }

  if (texts.some(containsHtml)) {
    body.tag_handling = "html"
  }

  const response = await fetch(`${baseUrl}/v2/translate`, {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errBody = await response.text()
    throw new Error(`DeepL HTTP ${response.status}: ${errBody}`)
  }

  const data = await response.json()
  const translations = data.translations
  if (!Array.isArray(translations) || translations.length !== texts.length) {
    throw new Error("DeepL returned unexpected translation count")
  }

  return translations.map((t: { text?: string }) => t.text ?? "")
}

async function translateChunkDeepL(chunk: string): Promise<string> {
  const result = await translateBatchDeepL([chunk])
  const translated = result[0]
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
  const sentences = text.match(/[^.!?…]+[.!?…]+["'”’)\]]*\s*/g)

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}