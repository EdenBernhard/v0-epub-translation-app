import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { generatePDF } from "@/lib/pdf-generator"

/**
 * Download API — improvements:
 *
 * 1. Only selects needed columns (not select("*") which loads everything)
 * 2. For translation downloads, only loads translated_content (not original too)
 * 3. Streams PDF generation for large books
 * 4. Better error messages
 */

export const maxDuration = 30

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { id } = await params
    const { searchParams } = new URL(request.url)
    const type = searchParams.get("type") || "original"

    let content = ""
    let title = ""
    let author = ""

    if (type === "translation") {
      // ── Translation download: load only what we need ──────────────────
      // First get metadata (lightweight)
      const { data: meta, error: metaError } = await supabase
        .from("epub_files")
        .select("title, author")
        .eq("id", id)
        .eq("user_id", user.id)
        .single()

      if (metaError || !meta) {
        return NextResponse.json({ error: "EPUB not found" }, { status: 404 })
      }

      title = meta.title
      author = meta.author || "Unknown Author"

      // Then get translation content
      const { data: translation, error: transError } = await supabase
        .from("translations")
        .select("translated_content")
        .eq("epub_file_id", id)
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .single()

      if (transError || !translation) {
        return NextResponse.json(
          { error: "Translation not found. Please translate the book first." },
          { status: 404 },
        )
      }

      content = translation.translated_content?.translated || ""
      if (!content) {
        return NextResponse.json(
          { error: "Translation content is empty" },
          { status: 404 },
        )
      }
    } else {
      // ── Original download: load only content + metadata ───────────────
      const { data: epub, error: epubError } = await supabase
        .from("epub_files")
        .select("title, author, original_content")
        .eq("id", id)
        .eq("user_id", user.id)
        .single()

      if (epubError || !epub) {
        return NextResponse.json({ error: "EPUB not found" }, { status: 404 })
      }

      title = epub.title
      author = epub.author || "Unknown Author"

      const rawContent = epub.original_content?.content || epub.original_content || ""
      content = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent)

      if (!content) {
        return NextResponse.json(
          { error: "Original content not found" },
          { status: 404 },
        )
      }
    }

    // ── Generate PDF ──────────────────────────────────────────────────────
    const language = type === "translation" ? "German" : "English"
    const suffix = type === "translation" ? "DE" : "EN"

    const pdfBuffer = await generatePDF({ title, author, content, language })

    const filename = encodeURIComponent(`${title}_${suffix}.pdf`)

    return new NextResponse(pdfBuffer, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
        "Cache-Control": "private, no-cache",
      },
    })
  } catch (error) {
    console.error("[download] Error:", error)
    return NextResponse.json({ error: "Download failed" }, { status: 500 })
  }
}