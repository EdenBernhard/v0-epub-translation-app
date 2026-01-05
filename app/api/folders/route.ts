import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET() {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { data: folders, error } = await supabase
      .from("folders")
      .select("*")
      .eq("user_id", user.id)
      .order("name", { ascending: true })

    if (error) throw error

    return NextResponse.json({ folders })
  } catch (error: any) {
    console.error("[v0] Error fetching folders:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { name } = await request.json()

    if (!name || name.trim() === "") {
      return NextResponse.json({ error: "Folder name is required" }, { status: 400 })
    }

    const { data: folder, error } = await supabase
      .from("folders")
      .insert({
        user_id: user.id,
        name: name.trim(),
      })
      .select()
      .single()

    if (error) throw error

    return NextResponse.json({ folder })
  } catch (error: any) {
    console.error("[v0] Error creating folder:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
