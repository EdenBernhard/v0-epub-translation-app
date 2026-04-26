import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { generatePDF } from "@/lib/pdf-generator"

/**
 * Download API — returns the actual error message to the client
 * (not just "Download failed") so we can diagnose problems without
 * digging through Vercel logs.
 *
 * Passes chapter structure to the PDF generator when available, so the
 * output has proper chapter headings and pagination.
 */

export const maxDuration = 30

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const type = searchParams.get("type") || "original"

    let content = ""
    let title = ""
    let author = ""
    let chapters: Array<{ title: string; content: string }> | undefined

    if (type === "translation") {
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

      const tc = translation.translated_content

      if (tc && typeof tc === "object") {
        if (Array.isArray(tc.chapters) && tc.chapters.length > 0) {
          chapters = tc.chapters
            .filter(
              (ch: any) =>
                ch && typeof ch === "object" && typeof ch.content === "string",
            )
            .map((ch: any) => ({
              title: String(ch.title || ""),
              content: String(ch.content || ""),
            }))
          content = chapters?.map((c) => c.content).join("\n\n") || ""
        }

        if (!content && typeof tc.translated === "string") {
          content = tc.translated
        }
      } else if (typeof tc === "string") {
        content = tc
      }

      if (!content && (!chapters || chapters.length === 0)) {
        return NextResponse.json(
          { error: "Translation content is empty" },
          { status: 404 },
        )
      }
    } else {
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

      const oc = epub.original_content

      if (oc && typeof oc === "object") {
        if (Array.isArray(oc.chapters) && oc.chapters.length > 0) {
          chapters = oc.chapters
            .filter(
              (ch: any) =>
                ch && typeof ch === "object" && typeof ch.content === "string",
            )
            .map((ch: any) => ({
              title: String(ch.title || ""),
              content: String(ch.content || ""),
            }))
          content = chapters?.map((c) => c.content).join("\n\n") || ""
        }

        if (!content && typeof oc.content === "string") {
          content = oc.content
        }
      } else if (typeof oc === "string") {
        content = oc
      }

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

    console.log(
      `[download] Generating PDF: ${type}, title="${title}", ${chapters ? `${chapters.length} chapters` : `${content.length} chars flat`}`,
    )

    try {
      const pdfData: ArrayBuffer = await generatePDF({
        title,
        author,
        content,
        language,
        chapters,
      })

      const safeTitle = title.replace(/[^\w\s.-]/g, "_").trim() || "book"
      const filename = encodeURIComponent(`${safeTitle}_${suffix}.pdf`)

      return new NextResponse(pdfData, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
          "Cache-Control": "private, no-cache",
          "Content-Length": String(pdfData.byteLength),
        },
      })
    } catch (genError) {
      console.error("[download] PDF generation error:", genError)
      const message =
        genError instanceof Error
          ? `PDF generation failed: ${genError.message}`
          : "PDF generation failed"
      return NextResponse.json({ error: message }, { status: 500 })
    }
  } catch (error) {
    console.error("[download] Unhandled error:", error)
    const message =
      error instanceof Error
        ? `Download failed: ${error.message}`
        : "Download failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}