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

  const { data: epubFiles, error } = await supabase
    .from("epub_files")
    .select(
      `
      *,
      translations (*)
    `,
    )
    .eq("user_id", user.id)
    .order("upload_date", { ascending: false })

  if (error) {
    console.error("[v0] Error fetching library:", error)
  }

  return (
    <div className="flex min-h-svh w-full flex-col bg-background">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between px-4 sm:px-6">
          <h1 className="text-xl font-semibold">My Library</h1>
          <div className="flex items-center gap-2">
            <Link
              href="https://welib.org/md5/2d9f4102272a4b480ea3f28e1a9b19f5"
              target="_blank"
              rel="noopener noreferrer"
            >
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
        <LibraryView epubFiles={epubFiles || []} />
      </main>
    </div>
  )
}
