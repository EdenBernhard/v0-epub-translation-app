import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { translateToGerman } from "@/lib/translator"

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Check if translation already exists
    const { data: existingTranslation } = await supabase
      .from("translations")
      .select("id")
      .eq("epub_file_id", id)
      .eq("user_id", user.id)
      .maybeSingle()

    if (existingTranslation) {
      return NextResponse.json({ success: true, message: "Translation already exists" })
    }

    await supabase.from("epub_files").update({ translation_status: "translating" }).eq("id", id).eq("user_id", user.id)

    // Get EPUB file
    const { data: epubFile, error: epubError } = await supabase
      .from("epub_files")
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .single()

    if (epubError || !epubFile) {
      return NextResponse.json({ error: "EPUB not found" }, { status: 404 })
    }

    const originalContent = epubFile.original_content?.content || ""
    const chapters = epubFile.original_content?.chapters || []

    console.log("[v0] Starting translation for EPUB:", epubFile.title)
    console.log("[v0] Content length:", originalContent.length, "characters")

    const translatedContent = await translateToGerman(originalContent)

    console.log("[v0] Translation complete. Length:", translatedContent.length, "characters")

    // Store translation
    const { error: translationError } = await supabase.from("translations").insert({
      epub_file_id: id,
      user_id: user.id,
      translated_content: {
        original: originalContent,
        translated: translatedContent,
        chapters: chapters,
      },
      target_language: "de",
      translation_status: "completed",
    })

    if (translationError) {
      console.error("[v0] Error storing translation:", translationError)
      await supabase.from("epub_files").update({ translation_status: "none" }).eq("id", id).eq("user_id", user.id)
      throw translationError
    }

    await supabase.from("epub_files").update({ translation_status: "completed" }).eq("id", id).eq("user_id", user.id)

    return NextResponse.json({ success: true, message: "Translation completed" })
  } catch (error) {
    console.error("[v0] Translation error:", error)
    return NextResponse.json({ error: "Translation failed" }, { status: 500 })
  }
}
