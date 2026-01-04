"use client"

import type React from "react"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Upload, FileText, Loader2 } from "lucide-react"

interface UploadFormProps {
  userId: string
}

export default function UploadForm({ userId }: UploadFormProps) {
  const [file, setFile] = useState<File | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0]
    if (selectedFile) {
      if (selectedFile.name.endsWith(".epub")) {
        setFile(selectedFile)
        setError(null)
      } else {
        setError("Please select a valid EPUB file")
        setFile(null)
      }
    }
  }

  const handleUpload = async () => {
    if (!file) return

    setIsLoading(true)
    setError(null)

    try {
      const formData = new FormData()
      formData.append("file", file)
      formData.append("userId", userId)

      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Upload failed")
      }

      router.push("/library")
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred during upload")
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>Upload Your EPUB File</CardTitle>
          <CardDescription>Select an English EPUB file to translate to German</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-6">
            <div className="grid gap-2">
              <Label htmlFor="epub-file">EPUB File</Label>
              <div className="relative">
                <Input
                  id="epub-file"
                  type="file"
                  accept=".epub"
                  onChange={handleFileChange}
                  className="cursor-pointer"
                  disabled={isLoading}
                />
              </div>
              {file && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <FileText className="h-4 w-4" />
                  <span>{file.name}</span>
                  <span className="text-xs">({(file.size / 1024 / 1024).toFixed(2)} MB)</span>
                </div>
              )}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex flex-col gap-3 sm:flex-row">
              <Button onClick={handleUpload} disabled={!file || isLoading} className="flex-1">
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Uploading & Translating...
                  </>
                ) : (
                  <>
                    <Upload className="mr-2 h-4 w-4" />
                    Upload & Translate
                  </>
                )}
              </Button>
              <Button variant="outline" onClick={() => router.push("/library")} disabled={isLoading}>
                Cancel
              </Button>
            </div>

            <div className="rounded-lg border bg-muted/50 p-4 text-sm">
              <p className="font-medium">How it works:</p>
              <ol className="mt-2 list-inside list-decimal space-y-1 text-muted-foreground">
                <li>Select your English EPUB file</li>
                <li>The file will be automatically translated to German</li>
                <li>Both original and translation will be saved to your library</li>
                <li>You can download either version as PDF</li>
              </ol>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
