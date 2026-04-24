import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import LibraryView from "@/components/library-view"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import { Upload, LogOut, Download } from "lucide-react"
import { logout } from "@/app/actions/auth"

export default async function LibraryPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect("/auth/login")
  }

  // Only select metadata fields, NOT original_content or translated_content
  // This drastically reduces data transfer
  const [{ data: epubFiles, error: epubError }, { data: folders, error: folderError }] = await Promise.all([
    supabase
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
          created_at,
          provider
        )
      `,
      )
      .eq("user_id", user.id)
      .order("upload_date", { ascending: false }),
    supabase.from("folders").select("*").eq("user_id", user.id).order("name", { ascending: true }),
  ])

  if (epubError) {
    console.error("[v0] Error fetching library:", epubError)
  }

  if (folderError) {
    console.error("[v0] Error fetching folders:", folderError)
  }

  return (
    <div className="flex min-h-svh w-full flex-col bg-background">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between px-4 sm:px-6">
          <h1 className="text-xl font-semibold">My Library</h1>
          <div className="flex items-center gap-2">
            <Link href="https://welib.org/" target="_blank" rel="noopener noreferrer">
              <Button size="sm" variant="outline" className="gap-2 bg-transparent">
                <Download className="h-4 w-4" />
                <span className="hidden sm:inline">Find EPUBs</span>
              </Button>
            </Link>
            <Link href="/upload">
              <Button size="sm" className="gap-2">
                <Upload className="h-4 w-4" />
                <span className="hidden sm:inline">Upload</span>
              </Button>
            </Link>
            <form action={logout}>
              <Button type="submit" variant="outline" size="sm" className="gap-2 bg-transparent">
                <LogOut className="h-4 w-4" />
                <span className="hidden sm:inline">Logout</span>
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="flex-1 container px-4 py-6 sm:px-6">
        <LibraryView epubFiles={epubFiles || []} folders={folders || []} />
      </main>
    </div>
  )
}