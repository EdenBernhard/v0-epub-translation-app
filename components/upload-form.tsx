"use client"

import type React from "react"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Upload, FileText, Loader2, X, CheckCircle2, AlertCircle } from "lucide-react"

interface UploadFormProps {
  userId: string
}

interface FileUploadStatus {
  file: File
  status: "pending" | "uploading" | "success" | "error"
  error?: string
  progress?: number
}

export default function UploadForm({ userId }: UploadFormProps) {
  const [files, setFiles] = useState<FileUploadStatus[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || [])
    if (selectedFiles.length > 0) {
      const validFiles = selectedFiles.filter((file) => file.name.endsWith(".epub") || file.name.endsWith(".mobi"))

      if (validFiles.length === 0) {
        setError("Please select valid EPUB or MOBI files")
        return
      }

      if (validFiles.length !== selectedFiles.length) {
        setError(`${selectedFiles.length - validFiles.length} file(s) skipped (not EPUB or MOBI)`)
      } else {
        setError(null)
      }

      const newFiles: FileUploadStatus[] = validFiles.map((file) => ({
        file,
        status: "pending",
      }))
      setFiles((prev) => [...prev, ...newFiles])
    }
  }

  const handleRemoveFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const handleUpload = async () => {
    if (files.length === 0) return

    setIsLoading(true)
    setError(null)

    for (let i = 0; i < files.length; i++) {
      const fileStatus = files[i]

      // Skip already successful uploads
      if (fileStatus.status === "success") continue

      // Update status to uploading
      setFiles((prev) => {
        const updated = [...prev]
        updated[i] = { ...updated[i], status: "uploading" }
        return updated
      })

      try {
        const formData = new FormData()
        formData.append("file", fileStatus.file)
        formData.append("userId", userId)

        const response = await fetch("/api/upload", {
          method: "POST",
          body: formData,
        })

        const data = await response.json()

        if (!response.ok) {
          throw new Error(data.error || "Upload failed")
        }

        // Update status to success
        setFiles((prev) => {
          const updated = [...prev]
          updated[i] = { ...updated[i], status: "success" }
          return updated
        })
      } catch (err) {
        // Update status to error
        const errorMessage = err instanceof Error ? err.message : "Upload failed"
        setFiles((prev) => {
          const updated = [...prev]
          updated[i] = { ...updated[i], status: "error", error: errorMessage }
          return updated
        })
      }
    }

    setIsLoading(false)

    // Check if all uploads were successful
    const allSuccess = files.every((f) => f.status === "success")
    if (allSuccess) {
      setTimeout(() => router.push("/library"), 1000)
    }
  }

  const pendingCount = files.filter((f) => f.status === "pending").length
  const successCount = files.filter((f) => f.status === "success").length
  const errorCount = files.filter((f) => f.status === "error").length

  return (
    <div className="mx-auto max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>Upload Your eBook Files</CardTitle>
          <CardDescription>Select multiple English EPUB or MOBI files to save to your library</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-6">
            <div className="grid gap-2">
              <Label htmlFor="epub-file">eBook Files (EPUB or MOBI)</Label>
              <div className="relative">
                <Input
                  id="epub-file"
                  type="file"
                  accept=".epub,.mobi"
                  multiple
                  onChange={handleFileChange}
                  className="cursor-pointer"
                  disabled={isLoading}
                />
              </div>

              {files.length > 0 && (
                <div className="mt-4 space-y-2">
                  {files.map((fileStatus, index) => (
                    <div
                      key={`${fileStatus.file.name}-${index}`}
                      className="flex items-center gap-2 rounded-lg border p-3"
                    >
                      <div className="flex-shrink-0">
                        {fileStatus.status === "pending" && <FileText className="h-4 w-4 text-muted-foreground" />}
                        {fileStatus.status === "uploading" && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
                        {fileStatus.status === "success" && <CheckCircle2 className="h-4 w-4 text-green-600" />}
                        {fileStatus.status === "error" && <AlertCircle className="h-4 w-4 text-destructive" />}
                      </div>
                      <div className="flex-1 overflow-hidden">
                        <p className="truncate text-sm font-medium">{fileStatus.file.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {(fileStatus.file.size / 1024 / 1024).toFixed(2)} MB
                          {fileStatus.status === "uploading" && " - Uploading..."}
                          {fileStatus.status === "success" && " - Uploaded"}
                          {fileStatus.status === "error" && ` - ${fileStatus.error}`}
                        </p>
                      </div>
                      {fileStatus.status === "pending" && !isLoading && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveFile(index)}
                          className="flex-shrink-0"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            {files.length > 0 && (
              <div className="rounded-lg border bg-muted/50 p-3 text-sm">
                <div className="flex justify-between">
                  <span>Total files: {files.length}</span>
                  {isLoading && (
                    <span>
                      Uploading: {successCount} of {files.length}
                    </span>
                  )}
                  {!isLoading && successCount > 0 && <span className="text-green-600">Uploaded: {successCount}</span>}
                  {errorCount > 0 && <span className="text-destructive">Failed: {errorCount}</span>}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-3 sm:flex-row">
              <Button onClick={handleUpload} disabled={files.length === 0 || isLoading} className="flex-1">
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Uploading {successCount + 1} of {files.length}...
                  </>
                ) : (
                  <>
                    <Upload className="mr-2 h-4 w-4" />
                    Upload {files.length > 0 ? `${files.length} File${files.length > 1 ? "s" : ""}` : "to Library"}
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
                <li>Select multiple English EPUB or MOBI files to upload</li>
                <li>Files will be uploaded to your library one by one</li>
                <li>Click "Translate to German" button for any book when ready</li>
                <li>Download the original or translated version as PDF</li>
              </ol>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
