import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { parseEpub } from "@/lib/epub-parser"
import { parseMobi } from "@/lib/mobi-parser"

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
    const customTitle = formData.get("customTitle") as string | null

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 })
    }

    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    const isEpub = file.name.toLowerCase().endsWith(".epub")
    const isMobi = file.name.toLowerCase().endsWith(".mobi")

    if (!isEpub && !isMobi) {
      return NextResponse.json({ error: "Only EPUB and MOBI files are supported" }, { status: 400 })
    }

    console.log(`[v0] Parsing ${isEpub ? "EPUB" : "MOBI"} file:`, file.name)

    const bookData = isEpub ? await parseEpub(buffer) : await parseMobi(buffer)

    console.log("[v0] Extracted metadata:", bookData.metadata)
    console.log("[v0] Content length:", bookData.content.length, "characters")

    const finalTitle = customTitle || bookData.metadata.title

    const { data: fileData, error: epubError } = await supabase
      .from("epub_files")
      .insert({
        user_id: user.id,
        title: finalTitle,
        author: bookData.metadata.author,
        original_filename: file.name,
        file_path: `${user.id}/${Date.now()}_${file.name}`,
        file_size: file.size,
        source_language: bookData.metadata.language || "en",
        original_content: {
          content: bookData.content,
          chapters: bookData.chapters,
          metadata: bookData.metadata,
        },
      })
      .select()
      .single()

    if (epubError) {
      console.error("[v0] Error storing book:", epubError)
      throw epubError
    }

    console.log("[v0] Upload successful, Book ID:", fileData.id)
    return NextResponse.json({ success: true, epubId: fileData.id })
  } catch (error) {
    console.error("[v0] Upload error:", error)
    return NextResponse.json({ error: "Upload failed" }, { status: 500 })
  }
}
