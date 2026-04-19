import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { translateChapterText } from "@/lib/translator"

/**
 * Translate a single chapter.
 *
 * Called by the frontend in a loop — one chapter per request.
 * Each request finishes in ~2-8 seconds, well within Hobby's 10s limit.
 *
 * POST /api/translate/[id]/chapter
 * Body: { chapterIndex: number, title: string, content: string }
 * Returns: { translatedTitle: string, translatedContent: string, provider: string }
 */

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Verify the book belongs to the user
    const { data: epub } = await supabase
      .from("epub_files")
      .select("id")
      .eq("id", id)
      .eq("user_id", user.id)
      .single()

    if (!epub) {
      return NextResponse.json({ error: "EPUB not found" }, { status: 404 })
    }

    const body = await request.json()
    const { chapterIndex, title, content } = body

    if (typeof chapterIndex !== "number" || !title || !content) {
      return NextResponse.json(
        { error: "Missing chapterIndex, title, or content" },
        { status: 400 },
      )
    }

    console.log(
      `[translate-chapter] Book ${id}, chapter ${chapterIndex}: "${title}" (${content.length} chars)`,
    )

    const result = await translateChapterText(title, content)

    console.log(
      `[translate-chapter] Chapter ${chapterIndex} done via ${result.provider} in ${result.durationMs}ms`,
    )

    return NextResponse.json({
      chapterIndex,
      translatedTitle: result.translatedTitle,
      translatedContent: result.translatedContent,
      provider: result.provider,
      durationMs: result.durationMs,
    })
  } catch (error) {
    console.error("[translate-chapter] Error:", error)
    const message =
      error instanceof Error ? error.message : "Chapter translation failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}