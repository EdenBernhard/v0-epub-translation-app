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

    const { data: epubFiles, error } = await supabase
      .from("epub_files")
      .select(
        `
        *,
        translations(*)
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
