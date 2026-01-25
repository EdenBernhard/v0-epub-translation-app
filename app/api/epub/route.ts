import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Only select metadata fields, NOT original_content or translated_content
    // This drastically reduces data transfer from ~MB per book to ~KB
    const { data: epubFiles, error } = await supabase
      .from("epub_files")
      .select(
        `
        id,
        title,
        author,
        original_filename,
        file_size,
        source_language,
        upload_date,
        translation_status,
        folder_id,
        translations (
          id,
          target_language,
          translation_status,
          created_at
        )
      `,
      )
      .eq("user_id", user.id)
      .order("upload_date", { ascending: false })

    if (error) throw error

    return NextResponse.json({ epubFiles: epubFiles || [] })
  } catch (error) {
    console.error("[v0] Error fetching EPUBs:", error)
    return NextResponse.json({ error: "Failed to fetch EPUBs" }, { status: 500 })
  }
}
