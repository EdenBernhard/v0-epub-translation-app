import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { parseEpub } from "@/lib/epub-parser"
import { parseMobi } from "@/lib/mobi-parser"

/**
 * Upload API — stores parsed + filtered book content.
 *
 * The parser now filters out non-content sections (TOC, copyright,
 * previews, etc.) and stores both filtered chapters and filter stats.
 * The translation endpoint later uses only the filtered chapters.
 */

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Ensure user record exists
    const { data: existingUser } = await supabase
      .from("users")
      .select("id")
      .eq("id", user.id)
      .maybeSingle()

    if (!existingUser) {
      const { error: userError } = await supabase.from("users").insert({
        id: user.id,
        email: user.email || "",
      })
      if (userError) {
        console.error("[upload] Error creating user:", userError)
        return NextResponse.json(
          { error: "Failed to create user record" },
          { status: 500 },
        )
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
      return NextResponse.json(
        { error: "Only EPUB and MOBI files are supported" },
        { status: 400 },
      )
    }

    console.log(`[upload] Parsing ${isEpub ? "EPUB" : "MOBI"}: ${file.name}`)

    const bookData = isEpub ? await parseEpub(buffer) : await parseMobi(buffer)

    console.log("[upload] Metadata:", bookData.metadata)
    console.log("[upload] Filtered content:", bookData.content.length, "chars")

    // Log filter savings
    if (bookData.filterStats) {
      const fs = bookData.filterStats
      console.log(
        `[upload] Content filter: ${fs.keptChapters}/${fs.totalChapters} chapters kept, ` +
          `${fs.savedCharCount} chars removed (${fs.savedPercent}%)`,
      )
      if (fs.removedTitles.length > 0) {
        console.log(`[upload] Removed: ${fs.removedTitles.join(", ")}`)
      }
    }

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
          // Filtered content + chapters (used for translation)
          content: bookData.content,
          chapters: bookData.chapters,
          metadata: bookData.metadata,
          // Store filter stats for debugging + cost tracking
          filterStats: bookData.filterStats || null,
          // Keep all chapters for potential future use (e.g. showing what was filtered)
          allChapters: bookData.allChapters || null,
        },
      })
      .select()
      .single()

    if (epubError) {
      console.error("[upload] Error storing book:", epubError)
      throw epubError
    }

    console.log("[upload] Success, Book ID:", fileData.id)

    return NextResponse.json({
      success: true,
      epubId: fileData.id,
      filterStats: bookData.filterStats || null,
    })
  } catch (error) {
    console.error("[upload] Error:", error)
    return NextResponse.json({ error: "Upload failed" }, { status: 500 })
  }
}