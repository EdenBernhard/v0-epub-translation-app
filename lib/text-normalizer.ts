/**
 * Text Normalizer — cleans up translation / EPUB parsing artifacts that
 * cause visible formatting problems in the rendered PDF.
 *
 * Common issues this addresses:
 *  - Letter-spacing via wide Unicode spaces (U+2003, U+3000, etc.)
 *  - Runs like "f l a c h e n   S t e i n e" from <span class="expanded">
 *  - Zero-width joiners / invisible Unicode garbage
 *  - Soft hyphens (U+00AD) embedded mid-word
 *  - Non-breaking spaces that break jsPDF's word wrapping
 *  - Pathologically long "words" that overflow the right margin
 *
 * Usage:
 *  - Call `normalizeForTranslation(text)` on chapter content BEFORE translation
 *  - Call `normalizeForPdf(text)` on translated content BEFORE passing to jsPDF
 */

// ---------------------------------------------------------------------------
// Unicode character classes
// ---------------------------------------------------------------------------

/** Wide / non-standard Unicode spaces (all replaced with ASCII space). */
const WIDE_SPACE_RE = /[\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g

/** Zero-width / invisible characters (ZWSP, ZWNJ, ZWJ, LRM, RLM, BOM, WJ). */
const INVISIBLE_RE = /[\u200B-\u200F\u2060-\u2064\uFEFF]/g

/** Soft hyphen — invisible in most renderers, visible in some fonts. */
const SOFT_HYPHEN_RE = /\u00AD/g

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalize text coming FROM EPUB parsing, BEFORE translation.
 *
 * Kills letter-spacing artifacts and invisible characters so DeepL
 * doesn't faithfully preserve them in its output.
 */
export function normalizeForTranslation(text: string): string {
  if (!text) return ""

  let out = text

  // 1. Remove invisible / zero-width characters entirely
  out = out.replace(INVISIBLE_RE, "")

  // 2. Remove soft hyphens (typically appear mid-word)
  out = out.replace(SOFT_HYPHEN_RE, "")

  // 3. Replace wide Unicode spaces with regular spaces
  out = out.replace(WIDE_SPACE_RE, " ")

  // 4. Normalize NBSP to regular space for downstream word-wrapping
  out = out.replace(/\u00A0/g, " ")

  // 5. Fix letter-spaced runs: "f l a c h e n" → "flachen"
  out = fixLetterSpacedRuns(out)

  // 6. Collapse multiple spaces/tabs (but preserve newlines)
  out = out.replace(/[^\S\n]{2,}/g, " ")

  // 7. Trim whitespace from each line
  out = out
    .split("\n")
    .map((line) => line.trim())
    .join("\n")

  // 8. Collapse 3+ consecutive newlines to a paragraph break
  out = out.replace(/\n{3,}/g, "\n\n")

  return out.trim()
}

/**
 * Normalize text coming FROM translation, BEFORE PDF generation.
 *
 * Ensures jsPDF can wrap it correctly and render it with helvetica.
 */
export function normalizeForPdf(text: string): string {
  if (!text) return ""

  // Start with baseline normalization
  let out = normalizeForTranslation(text)

  // Break up absurdly long tokens (no whitespace for 80+ chars) so jsPDF
  // has somewhere to wrap. Without this, pathological runs overflow the
  // right margin.
  out = out.replace(/\S{80,}/g, (match) => match.replace(/(\S{40})/g, "$1 "))

  // Replace "--" (double hyphen as em-dash substitute) with the real char
  out = out.replace(/(\s)--(\s)/g, "$1\u2014$2")

  // Normalize fancy quote styles. Helvetica's WinAnsi encoding handles
  // “ ” but not „ low-9 or « guillemets — these render as boxes or
  // missing glyphs in older jsPDF builds. Replace with ASCII quotes.
  out = out
    .replace(/[\u201E\u201A]/g, '"') // „ ‚
    .replace(/[\u00AB\u00BB]/g, '"') // « »
    .replace(/[\u2039\u203A]/g, "'") // ‹ ›

  return out
}

// ---------------------------------------------------------------------------
// Letter-spaced run detection
// ---------------------------------------------------------------------------

/**
 * Fixes runs like:
 *   "f l a c h e n   S t e i n e"   →   "flachen Steine"
 *   "H E L L O  W O R L D"           →   "HELLO WORLD"
 *
 * Strategy:
 *   1. Find a region bounded on both sides by whitespace/punctuation
 *      containing 3+ consecutive single letters separated by 1-4 spaces.
 *   2. Within such a region, double-spaces are word boundaries and single
 *      spaces are letter joiners → remove single spaces, keep doubles as
 *      single spaces.
 *
 * The prefix/suffix character classes deliberately include German
 * quotation marks („ " ‚ ' « » ‹ ›) and brackets so that
 * "„flachen"" gets matched as well as "flachen".
 *
 * Conservative: only triggers on 3+ consecutive single-letter tokens.
 * Preserves normal text like "A B test" (only 2 single letters).
 */
function fixLetterSpacedRuns(text: string): string {
  return text
    .split("\n")
    .map(fixLineLetterSpacing)
    .join("\n")
}

const LETTER_SPACED_REGION =
  /(^|[\s"'„‚“”‘’«»‹›(\[\u2014\u2013])(\p{L}(?:[ ]{1,4}\p{L}){2,})(?=[\s.,;:!?"'„‚“”‘’«»‹›)\]\u2014\u2013\u2026]|$)/gu

function fixLineLetterSpacing(line: string): string {
  const fixed = line.replace(
    LETTER_SPACED_REGION,
    (_full, prefix: string, match: string) => {
      // Split the run on 2+ spaces (= original word boundaries), then
      // remove single spaces within each "word" (= letter joiners).
      const words = match.split(/ {2,}/).map((word) => word.replace(/ /g, ""))
      return prefix + words.join(" ")
    },
  )
  // Collapse any leftover multi-space runs created during replacement
  return fixed.replace(/[^\S\n]{2,}/g, " ")
}