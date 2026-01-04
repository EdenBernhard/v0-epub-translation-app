import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import UploadForm from "@/components/upload-form"

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
          <h1 className="text-xl font-semibold">Upload EPUB</h1>
        </div>
      </header>
      <main className="flex-1 container px-4 py-6 sm:px-6">
        <UploadForm userId={user.id} />
      </main>
    </div>
  )
}
