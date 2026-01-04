"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { BookOpen, Download, Trash2, Languages } from "lucide-react"
import { formatDistanceToNow } from "date-fns"
import { useState } from "react"

interface Translation {
  id: string
  target_language: string
  translation_status: string
  created_at: string
}

interface EpubFile {
  id: string
  title: string
  author: string
  original_filename: string
  file_size: number
  source_language: string
  upload_date: string
  translations: Translation[]
}

interface LibraryViewProps {
  epubFiles: EpubFile[]
}

export default function LibraryView({ epubFiles }: LibraryViewProps) {
  const [isDeleting, setIsDeleting] = useState<string | null>(null)

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this EPUB and its translation?")) return

    setIsDeleting(id)
    try {
      const response = await fetch(`/api/epub/${id}`, {
        method: "DELETE",
      })

      if (response.ok) {
        window.location.reload()
      }
    } catch (error) {
      console.error("[v0] Delete error:", error)
    } finally {
      setIsDeleting(null)
    }
  }

  const handleDownload = async (id: string, type: "original" | "translation") => {
    try {
      const response = await fetch(`/api/download/${id}?type=${type}`)
      if (!response.ok) throw new Error("Download failed")

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `${type}-${id}.pdf`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    } catch (error) {
      console.error("[v0] Download error:", error)
      alert("Download failed. Please try again.")
    }
  }

  if (epubFiles.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <BookOpen className="h-16 w-16 text-muted-foreground mb-4" />
        <h2 className="text-2xl font-semibold mb-2">No EPUBs yet</h2>
        <p className="text-muted-foreground mb-6">Upload your first EPUB file to get started with translations</p>
        <Button asChild>
          <a href="/upload">Upload EPUB</a>
        </Button>
      </div>
    )
  }

  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {epubFiles.map((epub) => (
        <Card key={epub.id} className="flex flex-col">
          <CardHeader>
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <CardTitle className="text-lg truncate">{epub.title}</CardTitle>
                <CardDescription className="truncate">{epub.author || "Unknown Author"}</CardDescription>
              </div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Languages className="h-3 w-3" />
                <span className="uppercase">{epub.source_language}</span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col gap-4">
            <div className="flex-1 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Size:</span>
                <span>{(epub.file_size / 1024 / 1024).toFixed(2)} MB</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Uploaded:</span>
                <span>{formatDistanceToNow(new Date(epub.upload_date), { addSuffix: true })}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Translation:</span>
                <span className="text-green-600 font-medium">
                  {epub.translations && epub.translations.length > 0 ? "German" : "None"}
                </span>
              </div>
            </div>

            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleDownload(epub.id, "original")}
                  className="gap-2"
                >
                  <Download className="h-4 w-4" />
                  Original
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleDownload(epub.id, "translation")}
                  disabled={!epub.translations || epub.translations.length === 0}
                  className="gap-2"
                >
                  <Download className="h-4 w-4" />
                  German
                </Button>
              </div>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => handleDelete(epub.id)}
                disabled={isDeleting === epub.id}
                className="w-full gap-2"
              >
                <Trash2 className="h-4 w-4" />
                {isDeleting === epub.id ? "Deleting..." : "Delete"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
