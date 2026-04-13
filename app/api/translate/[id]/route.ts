import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { translateBook } from "@/lib/translator"

/**
 * Translation API endpoint
 *
 * Key improvement: only translates filtered chapters (no TOC, copyright,
 * previews, book ads, etc.) — saves 10-30% of API costs per book.
 */

export const maxDuration = 60

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
    // ── Guard: already translated? ──────────────────────────────────────
    const { data: existingTranslation } = await supabase
      .from("translations")
      .select("id")
      .eq("epub_file_id", id)
      .eq("user_id", user.id)
      .maybeSingle()

    if (existingTranslation) {
      return NextResponse.json({
        success: true,
        message: "Translation already exists",
      })
    }

    // ── Guard: already translating? ─────────────────────────────────────
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

    // ── Set status ──────────────────────────────────────────────────────
    await supabase
      .from("epub_files")
      .update({ translation_status: "translating" })
      .eq("id", id)
      .eq("user_id", user.id)

    // ── Load book content ───────────────────────────────────────────────
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

    // Use filtered chapters (from content filter) — these exclude
    // TOC, copyright, previews, book ads, etc.
    const chapters = epubFile.original_content?.chapters || []
    const fullContent = epubFile.original_content?.content || ""
    const filterStats = epubFile.original_content?.filterStats

    if (!fullContent && chapters.length === 0) {
      await resetStatus(supabase, id, user.id)
      return NextResponse.json(
        { error: "No content to translate" },
        { status: 400 },
      )
    }

    // Log savings from content filtering
    if (filterStats) {
      console.log(
        `[translate] "${epubFile.title}" — Content filter saved ${filterStats.savedCharCount} chars (${filterStats.savedPercent}%)`,
      )
      if (filterStats.removedTitles?.length > 0) {
        console.log(
          `[translate] Removed sections: ${filterStats.removedTitles.join(", ")}`,
        )
      }
    }

    console.log(
      `[translate] Starting: "${epubFile.title}" — ${fullContent.length} chars, ${chapters.length} chapters`,
    )

    // ── Translate only the filtered chapters ────────────────────────────
    const result = await translateBook(fullContent, chapters)

    console.log(
      `[translate] Done: ${result.translatedContent.length} chars via ${result.provider} in ${(result.stats.durationMs / 1000).toFixed(1)}s`,
    )

    // ── Store translation ───────────────────────────────────────────────
    const { error: insertError } = await supabase.from("translations").insert({
      epub_file_id: id,
      user_id: user.id,
      translated_content: {
        original: fullContent,
        translated: result.translatedContent,
        chapters:
          result.translatedChapters.length > 0
            ? result.translatedChapters
            : chapters,
      },
      target_language: "de",
      translation_status: "completed",
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

    return NextResponse.json({
      success: true,
      message: "Translation completed",
      provider: result.provider,
      stats: {
        ...result.stats,
        filterSavings: filterStats
          ? {
              removedChapters: filterStats.removedChapters,
              savedCharacters: filterStats.savedCharCount,
              savedPercent: filterStats.savedPercent,
            }
          : null,
      },
    })
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