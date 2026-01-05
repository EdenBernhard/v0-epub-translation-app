import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { folderId } = await request.json()

    const { data: epub, error } = await supabase
      .from("epub_files")
      .update({ folder_id: folderId })
      .eq("id", id)
      .eq("user_id", user.id)
      .select()
      .single()

    if (error) throw error

    return NextResponse.json({ epub })
  } catch (error: any) {
    console.error("[v0] Error moving book:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
