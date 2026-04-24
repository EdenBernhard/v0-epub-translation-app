import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { checkDeepLUsage, isDeepLQuotaExhausted } from "@/lib/translator"

/**
 * Translation orchestrator — no longer translates inline.
 *
 * GET  /api/translate/[id] → returns chapters + status (for the frontend to drive)
 * POST /api/translate/[id] → starts translation (sets status) or saves completed result
 *
 * The frontend:
 * 1. POST to start → gets chapter list + capacity hint back
 * 2. For each chapter: POST to /api/translate/[id]/chapter
 * 3. POST to /api/translate/[id] with action:"complete" + all translated chapters + provider stats
 *
 * Each chapter request stays under 10s → works on Hobby plan.
 */

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const body = await request.json().catch(() => ({}))
    const action = body.action || "start"

    // ── ACTION: start — return chapters for client-side orchestration ──
    if (action === "start") {
      // Guard: already translated?
      const { data: existing } = await supabase
        .from("translations")
        .select("id")
        .eq("epub_file_id", id)
        .eq("user_id", user.id)
        .maybeSingle()

      if (existing) {
        return NextResponse.json({
          success: true,
          message: "Translation already exists",
          action: "already_done",
        })
      }

      // Guard: already translating?
      const { data: currentStatus } = await supabase
        .from("epub_files")
        .select("translation_status")
        .eq("id", id)
        .eq("user_id", user.id)
        .single()

      if (currentStatus?.translation_status === "translating") {
        return NextResponse.json(
          { error: "Translation already in progress" },
          { status: 409 },
        )
      }

      // Set status to translating
      await supabase
        .from("epub_files")
        .update({ translation_status: "translating" })
        .eq("id", id)
        .eq("user_id", user.id)

      // Load chapters
      const { data: epubFile, error: epubError } = await supabase
        .from("epub_files")
        .select("title, original_content")
        .eq("id", id)
        .eq("user_id", user.id)
        .single()

      if (epubError || !epubFile) {
        await resetStatus(supabase, id, user.id)
        return NextResponse.json({ error: "EPUB not found" }, { status: 404 })
      }

      const chapters = epubFile.original_content?.chapters || []
      const fullContent = epubFile.original_content?.content || ""

      if (!fullContent && chapters.length === 0) {
        await resetStatus(supabase, id, user.id)
        return NextResponse.json(
          { error: "No content to translate" },
          { status: 400 },
        )
      }

      const chaptersToTranslate =
        chapters.length > 0
          ? chapters.map((ch: any, i: number) => ({
              index: i,
              title: ch.title || `Chapter ${i + 1}`,
              content: ch.content,
              charCount: ch.content?.length || 0,
            }))
          : [
              {
                index: 0,
                title: epubFile.title || "Full content",
                content: fullContent,
                charCount: fullContent.length,
              },
            ]

      const totalChars = chaptersToTranslate.reduce(
        (sum: number, ch: any) => sum + ch.charCount,
        0,
      )

      // ── DeepL usage pre-check ──────────────────────────────────────────
      // If quota is already gone, the frontend can show "via Google" up front
      // and we skip N doomed DeepL requests.
      const usage = await checkDeepLUsage()
      let expectedProvider: "deepl" | "google" = "deepl"
      let quotaWarning: string | null = null

      if (!process.env.DEEPL_API_KEY) {
        expectedProvider = "google"
      } else if (isDeepLQuotaExhausted()) {
        expectedProvider = "google"
        quotaWarning = "DeepL quota exhausted — will use Google Translate"
      } else if (usage) {
        if (!usage.hasCapacity) {
          expectedProvider = "google"
          quotaWarning = "DeepL quota exhausted — will use Google Translate"
        } else if (usage.remaining < totalChars) {
          quotaWarning = `DeepL has only ${usage.remaining.toLocaleString()} chars left for ~${totalChars.toLocaleString()} needed — may fall back to Google mid-way`
        }
      }

      console.log(
        `[translate] Started: "${epubFile.title}" — ${chaptersToTranslate.length} chapters, ${totalChars} chars, expected provider: ${expectedProvider}`,
      )
      if (quotaWarning) console.warn(`[translate] ${quotaWarning}`)

      return NextResponse.json({
        action: "translate_chapters",
        chapters: chaptersToTranslate,
        totalChars,
        bookTitle: epubFile.title,
        expectedProvider,
        quotaWarning,
        deeplUsage: usage
          ? {
              remaining: usage.remaining,
              limit: usage.characterLimit,
            }
          : null,
      })
    }

    // ── ACTION: complete — save all translated chapters ─────────────────
    if (action === "complete") {
      const { translatedChapters, originalContent, providers, stats } = body

      if (!translatedChapters || !Array.isArray(translatedChapters)) {
        await resetStatus(supabase, id, user.id)
        return NextResponse.json(
          { error: "Missing translatedChapters" },
          { status: 400 },
        )
      }

      const translatedContent = translatedChapters
        .map((ch: any) => ch.content)
        .join("\n\n")

      // Determine the overall provider for this translation.
      // `providers` is an optional array from the frontend listing provider per chapter.
      let overallProvider: "deepl" | "google" | "mixed" = "deepl"
      if (Array.isArray(providers) && providers.length > 0) {
        const unique = new Set(providers.filter(Boolean))
        if (unique.size === 1) {
          overallProvider = (providers[0] as "deepl" | "google") ?? "deepl"
        } else if (unique.size > 1) {
          overallProvider = "mixed"
        }
      }

      // Store translation with provider info
      const { error: insertError } = await supabase
        .from("translations")
        .insert({
          epub_file_id: id,
          user_id: user.id,
          translated_content: {
            original: originalContent || "",
            translated: translatedContent,
            chapters: translatedChapters,
            providers: providers || null,
          },
          target_language: "de",
          translation_status: "completed",
          provider: overallProvider,
        })

      if (insertError) {
        console.error("[translate] Insert error:", insertError)
        await resetStatus(supabase, id, user.id)
        return NextResponse.json(
          { error: "Failed to store translation" },
          { status: 500 },
        )
      }

      await supabase
        .from("epub_files")
        .update({ translation_status: "completed" })
        .eq("id", id)
        .eq("user_id", user.id)

      console.log(
        `[translate] Completed: ${translatedChapters.length} chapters saved (provider: ${overallProvider})`,
      )

      return NextResponse.json({
        success: true,
        message: "Translation completed",
        provider: overallProvider,
        stats,
      })
    }

    // ── ACTION: cancel — reset status on error ──────────────────────────
    if (action === "cancel") {
      await resetStatus(supabase, id, user.id)
      return NextResponse.json({ success: true, message: "Translation cancelled" })
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  } catch (error) {
    console.error("[translate] Error:", error)
    await resetStatus(supabase, id, user.id)
    const message =
      error instanceof Error ? error.message : "Translation failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

async function resetStatus(
  supabase: Awaited<ReturnType<typeof createClient>>,
  epubId: string,
  userId: string,
) {
  try {
    await supabase
      .from("epub_files")
      .update({ translation_status: "none" })
      .eq("id", epubId)
      .eq("user_id", userId)
  } catch (e) {
    console.error("[translate] Failed to reset status:", e)
  }
}