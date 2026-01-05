import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { generatePDF } from "@/lib/pdf-generator"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

    // Fetch EPUB file data
    const { data: epubFile, error: epubError } = await supabase
      .from("epub_files")
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .single()

    if (epubError || !epubFile) {
      console.error("[v0] EPUB fetch error:", epubError)
      return NextResponse.json({ error: "EPUB not found" }, { status: 404 })
    }

    let content = ""
    let filename = ""

    if (type === "translation") {
      const { data: translations, error: translationError } = await supabase
        .from("translations")
        .select("*")
        .eq("epub_file_id", id)
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(1)

      if (translationError) {
        console.error("[v0] Translation fetch error:", translationError)
        return NextResponse.json({ error: "Failed to fetch translation" }, { status: 500 })
      }

      if (!translations || translations.length === 0) {
        return NextResponse.json({ error: "Translation not found. Please translate the book first." }, { status: 404 })
      }

      const translation = translations[0]
      content = translation.translated_content.translated || "No translation available"
      const encodedFilename = encodeURIComponent(`${epubFile.title}_DE.pdf`)
      filename = encodedFilename
    } else {
      const originalContent = epubFile.original_content?.content || epubFile.original_content || ""

      if (!originalContent) {
        return NextResponse.json({ error: "Original content not found" }, { status: 404 })
      }

      content = typeof originalContent === "string" ? originalContent : JSON.stringify(originalContent)
      const encodedFilename = encodeURIComponent(`${epubFile.title}_EN.pdf`)
      filename = encodedFilename
    }

    // Generate PDF
    const pdfBuffer = await generatePDF({
      title: epubFile.title,
      author: epubFile.author || "Unknown Author",
      content,
      language: type === "translation" ? "German" : "English",
    })

    return new NextResponse(pdfBuffer, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
      },
    })
  } catch (error) {
    console.error("[v0] Download error:", error)
    return NextResponse.json({ error: "Download failed" }, { status: 500 })
  }
}
