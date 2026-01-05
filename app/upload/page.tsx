import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import UploadForm from "@/components/upload-form"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import { ArrowLeft, Download } from "lucide-react"

export default async function UploadPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect("/auth/login")
  }

  return (
    <div className="flex min-h-svh w-full flex-col bg-background">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-2">
            <Link href="/library">
              <Button variant="ghost" size="sm" className="gap-2">
                <ArrowLeft className="h-4 w-4" />
                <span className="hidden sm:inline">Back</span>
              </Button>
            </Link>
            <h1 className="text-xl font-semibold">Upload EPUB</h1>
          </div>
          <Link href="https://welib.org/" target="_blank" rel="noopener noreferrer">
            <Button size="sm" variant="outline" className="gap-2 bg-transparent">
              <Download className="h-4 w-4" />
              <span className="hidden sm:inline">Find EPUBs</span>
            </Button>
          </Link>
        </div>
      </header>
      <main className="flex-1 container px-4 py-6 sm:px-6">
        <UploadForm userId={user.id} />
      </main>
    </div>
  )
}
