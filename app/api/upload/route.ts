import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { parseEpub } from "@/lib/epub-parser"
import { translateToGerman } from "@/lib/translator"

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { data: existingUser } = await supabase.from("users").select("id").eq("id", user.id).maybeSingle()

    if (!existingUser) {
      const { error: userError } = await supabase.from("users").insert({
        id: user.id,
        email: user.email || "",
      })

      if (userError) {
        console.error("[v0] Error creating user:", userError)
        return NextResponse.json({ error: "Failed to create user record" }, { status: 500 })
      }
    }

    const formData = await request.formData()
    const file = formData.get("file") as File

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 })
    }

    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    console.log("[v0] Parsing EPUB file:", file.name)
    const epubData = await parseEpub(buffer)
    console.log("[v0] Extracted metadata:", epubData.metadata)
    console.log("[v0] Content length:", epubData.content.length, "characters")

    console.log("[v0] Starting AI translation to German...")
    const translatedContent = await translateToGerman(epubData.content)
    console.log("[v0] Translation complete. Length:", translatedContent.length, "characters")

    const { data: fileData, error: epubError } = await supabase
      .from("epub_files")
      .insert({
        user_id: user.id,
        title: epubData.metadata.title,
        author: epubData.metadata.author,
        original_filename: file.name,
        file_path: `${user.id}/${Date.now()}_${file.name}`,
        file_size: file.size,
        source_language: epubData.metadata.language || "en",
      })
      .select()
      .single()

    if (epubError) {
      console.error("[v0] Error storing EPUB:", epubError)
      throw epubError
    }

    const { error: translationError } = await supabase.from("translations").insert({
      epub_file_id: fileData.id,
      user_id: user.id,
      translated_content: {
        original: epubData.content,
        translated: translatedContent,
        chapters: epubData.chapters,
      },
      target_language: "de",
      translation_status: "completed",
    })

    if (translationError) {
      console.error("[v0] Error storing translation:", translationError)
      throw translationError
    }

    console.log("[v0] Upload successful, EPUB ID:", fileData.id)
    return NextResponse.json({ success: true, epubId: fileData.id })
  } catch (error) {
    console.error("[v0] Upload error:", error)
    return NextResponse.json({ error: "Upload failed" }, { status: 500 })
  }
}
