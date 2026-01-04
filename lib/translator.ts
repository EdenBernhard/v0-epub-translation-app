/**
 * Translates text from English to German using Google Translate (Free)
 * This is the same free API used by the Calibre EPUB Translator plugin
 */
export async function translateToGerman(text: string): Promise<string> {
  if (!text || text.trim().length === 0) {
    return ""
  }

  const chunks = chunkText(text, 4500) // Google Translate limit is 5000 chars
  console.log(`[v0] Translating ${chunks.length} chunks with Google Translate (Free)`)

  const translatedChunks: string[] = []

  for (let i = 0; i < chunks.length; i += 5) {
    const batch = chunks.slice(i, i + 5)
    console.log(`[v0] Processing batch ${Math.floor(i / 5) + 1}/${Math.ceil(chunks.length / 5)}`)

    const batchPromises = batch.map((chunk, index) => translateChunk(chunk, i + index + 1))
    const batchResults = await Promise.all(batchPromises)
    translatedChunks.push(...batchResults)

    // Add delay between batches to avoid rate limiting
    if (i + 5 < chunks.length) {
      console.log(`[v0] Waiting 2 seconds before next batch...`)
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }

  console.log(`[v0] Translation complete. Length: ${translatedChunks.join(" ").length} characters`)
  return translatedChunks.join(" ")
}

/**
 * Translates a single chunk using Google Translate Free API
 */
async function translateChunk(chunk: string, chunkNumber: number): Promise<string> {
  try {
    const url = new URL("https://translate.googleapis.com/translate_a/single")
    url.searchParams.append("client", "gtx")
    url.searchParams.append("sl", "en") // Source: English
    url.searchParams.append("tl", "de") // Target: German
    url.searchParams.append("dt", "t") // Return translation
    url.searchParams.append("q", chunk)

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    })

    if (!response.ok) {
      console.error(`[v0] Translation error for chunk ${chunkNumber}: HTTP ${response.status}`)
      return chunk
    }

    const data = await response.json()

    // Google Translate returns: [[[translated_text, original_text, null, null, rank], ...], ...]
    if (data && Array.isArray(data) && data[0] && Array.isArray(data[0])) {
      const translatedParts = data[0].map((part: any[]) => part[0]).filter(Boolean)
      const translation = translatedParts.join("")

      console.log(`[v0] Successfully translated chunk ${chunkNumber}`)
      return translation || chunk
    }

    console.error(`[v0] Unexpected response format for chunk ${chunkNumber}`)
    return chunk
  } catch (error) {
    console.error(`[v0] Translation error for chunk ${chunkNumber}:`, error)
    return chunk
  }
}

/**
 * Splits text into chunks at sentence boundaries
 */
function chunkText(text: string, maxChunkSize: number): string[] {
  const chunks: string[] = []
  let currentChunk = ""

  const sentences = text.match(/[^.!?]+[.!?]+[\s]*/g) || [text]

  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length > maxChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim())
      currentChunk = sentence
    } else {
      currentChunk += sentence
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim())
  }

  return chunks
}
