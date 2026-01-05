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
      return NextResponse.json({ error: "EPUB not found" }, { status: 404 })
    }

    let content = ""
    let filename = ""

    if (type === "translation") {
      const { data: translation, error: translationError } = await supabase
        .from("translations")
        .select("*")
        .eq("epub_file_id", id)
        .eq("user_id", user.id)
        .maybeSingle()

      if (translationError) {
        console.error("[v0] Translation fetch error:", translationError)
        return NextResponse.json({ error: "Failed to fetch translation" }, { status: 500 })
      }

      if (!translation) {
        return NextResponse.json({ error: "Translation not found. Please translate the book first." }, { status: 404 })
      }

      content = translation.translated_content.translated || "No translation available"
      filename = `${epubFile.title}_DE.pdf`
    } else {
      const originalContent = epubFile.original_content?.content || epubFile.original_content || ""

      if (!originalContent) {
        return NextResponse.json({ error: "Original content not found" }, { status: 404 })
      }

      content = typeof originalContent === "string" ? originalContent : JSON.stringify(originalContent)
      filename = `${epubFile.title}_EN.pdf`
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
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    })
  } catch (error) {
    console.error("[v0] Download error:", error)
    return NextResponse.json({ error: "Download failed" }, { status: 500 })
  }
}
