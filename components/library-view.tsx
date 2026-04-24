"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  BookOpen,
  Download,
  Trash2,
  Languages,
  Loader2,
  Folder,
  FolderOpen,
  Plus,
  Edit2,
  FolderX,
  ChevronLeft,
  Pencil,
  MoveRight,
  X,
} from "lucide-react"
import { formatDistanceToNow } from "date-fns"
import { useState, useEffect } from "react"
import FolderDialog from "@/components/folder-dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { EditTitleDialog } from "./edit-title-dialog"
import { Checkbox } from "@/components/ui/checkbox"

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
  translation_status: string
  folder_id: string | null
  translations: Translation[]
}

interface LibraryViewProps {
  epubFiles: EpubFile[]
  folders: any[]
}

export default function LibraryView({ epubFiles: initialEpubFiles, folders: initialFolders }: LibraryViewProps) {
  const [epubFiles, setEpubFiles] = useState(initialEpubFiles)
  const [folders, setFolders] = useState(initialFolders)
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState<string | null>(null)
  const [folderDialogOpen, setFolderDialogOpen] = useState(false)
  const [editingFolder, setEditingFolder] = useState<any | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [editingBookId, setEditingBookId] = useState<string | null>(null)
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [selectedBooks, setSelectedBooks] = useState<Set<string>>(new Set())
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)

  // Optimized polling: only poll when there are translating books
  // Increased interval to 15 seconds to reduce data transfer
  useEffect(() => {
    const hasTranslating = epubFiles.some((epub) => epub.translation_status === "translating")
    
    if (!hasTranslating) return // Don't create interval if nothing is translating
    
    const interval = setInterval(async () => {
      try {
        const response = await fetch("/api/epub")
        if (response.ok) {
          const data = await response.json()
          setEpubFiles(data.epubFiles)
        }
      } catch (error) {
        // Silent fail on polling errors - don't spam console
      }
    }, 15000) // Increased from 5s to 15s

    return () => clearInterval(interval)
  }, [epubFiles.some((epub) => epub.translation_status === "translating")])

  const handleCreateFolder = async (name: string) => {
    try {
      const response = await fetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      })

      if (response.ok) {
        const { folder } = await response.json()
        setFolders((prev) => [...prev, folder])
      }
    } catch (error) {
      console.error("[v0] Error creating folder:", error)
      alert("Failed to create folder. Please try again.")
    }
  }

  const handleUpdateFolder = async (name: string) => {
    if (!editingFolder) return

    try {
      const response = await fetch(`/api/folders/${editingFolder.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      })

      if (response.ok) {
        const { folder } = await response.json()
        setFolders((prev) => prev.map((f) => (f.id === folder.id ? folder : f)))
        setEditingFolder(null)
      }
    } catch (error) {
      console.error("[v0] Error updating folder:", error)
      alert("Failed to update folder. Please try again.")
    }
  }

  const handleDeleteFolder = async (id: string) => {
    if (!confirm("Delete this folder? Books will be moved to 'All Books'.")) return

    try {
      const response = await fetch(`/api/folders/${id}`, {
        method: "DELETE",
      })

      if (response.ok) {
        setFolders((prev) => prev.filter((f) => f.id !== id))
        if (selectedFolder === id) setSelectedFolder(null)
        // Update books locally instead of refetching - move books from deleted folder to "All Books"
        setEpubFiles((prev) => prev.map((epub) => 
          epub.folder_id === id ? { ...epub, folder_id: null } : epub
        ))
      }
    } catch (error) {
      alert("Failed to delete folder. Please try again.")
    }
  }

  const handleMoveToFolder = async (epubId: string, folderId: string | null) => {
    try {
      const response = await fetch(`/api/epub/${epubId}/move`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId }),
      })

      if (response.ok) {
        setEpubFiles((prev) => prev.map((epub) => (epub.id === epubId ? { ...epub, folder_id: folderId } : epub)))
      }
    } catch (error) {
      console.error("[v0] Error moving book:", error)
      alert("Failed to move book. Please try again.")
    }
  }

  const handleUpdateTitle = async (id: string, newTitle: string) => {
    if (!newTitle.trim()) {
      setEditingBookId(null)
      return
    }

    try {
      const response = await fetch(`/api/epub/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle }),
      })

      if (response.ok) {
        setEpubFiles((prev) => prev.map((epub) => (epub.id === id ? { ...epub, title: newTitle } : epub)))
        setEditingBookId(null)
      }
    } catch (error) {
      console.error("[v0] Error updating title:", error)
      alert("Failed to update title. Please try again.")
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this EPUB and its translation?")) return

    setIsDeleting(id)
    try {
      const response = await fetch(`/api/epub/${id}`, {
        method: "DELETE",
      })

      if (response.ok) {
        setEpubFiles((prev) => prev.filter((epub) => epub.id !== id))
      }
    } catch (error) {
      console.error("[v0] Delete error:", error)
    } finally {
      setIsDeleting(null)
    }
  }

  const handleDownload = async (id: string, type: "original" | "translation") => {
    setDownloadingId(`${id}-${type}`)
    try {
      const response = await fetch(`/api/download/${id}?type=${type}`)
      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(errorText || "Download failed")
      }

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      // Get filename from Content-Disposition header if available
      const contentDisposition = response.headers.get("Content-Disposition")
      const filenameMatch = contentDisposition?.match(/filename\*?=(?:UTF-8'')?([^;]+)/)
      const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : `${type}-${id}.pdf`
      a.download = filename
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    } catch (error) {
      alert("Download failed. Please try again.")
    } finally {
      setDownloadingId(null)
    }
  }

  const handleTranslate = async (id: string) => {
    // Optimistic update - set status immediately
    setEpubFiles((prev) =>
      prev.map((epub) =>
        epub.id === id ? { ...epub, translation_status: "translating" } : epub,
      ),
    )
  
    try {
      // Step 1: Start translation — get chapter list
      const startResponse = await fetch(`/api/translate/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      })
  
      if (!startResponse.ok) {
        const errorData = await startResponse.json().catch(() => ({}))
        throw new Error(errorData.error || "Failed to start translation")
      }
  
      const startData = await startResponse.json()
  
      // Already translated
      if (startData.action === "already_done") {
        setEpubFiles((prev) =>
          prev.map((epub) =>
            epub.id === id
              ? {
                  ...epub,
                  translation_status: "completed",
                  translations: [
                    ...(epub.translations || []),
                    {
                      id: crypto.randomUUID(),
                      target_language: "de",
                      translation_status: "completed",
                      created_at: new Date().toISOString(),
                    },
                  ],
                }
              : epub,
          ),
        )
        return
      }
  
      const chapters = startData.chapters || []
      if (chapters.length === 0) {
        throw new Error("No chapters to translate")
      }
  
      // Step 2: Translate chapters in PARALLEL with limited concurrency
      // This is the main performance win — replaces the sequential for-loop.
      const CONCURRENCY = 4
      const translatedChapters: Array<{ title: string; content: string }> =
        new Array(chapters.length)
  
      // Build original content in original order (independent of translation order)
      const fullOriginalContent = chapters
        .map((ch: any) => ch.content)
        .join("\n\n")
        .trim()
  
      let cursor = 0
      let doneCount = 0
      let firstError: Error | null = null
  
      const worker = async () => {
        while (true) {
          const i = cursor++
          if (i >= chapters.length) return
          if (firstError) return // stop picking up new work once we've failed
  
          const chapter = chapters[i]
          console.log(
            `[translate] Chapter ${i + 1}/${chapters.length} starting: "${chapter.title}" (${chapter.charCount} chars)`,
          )
  
          const chapterResponse = await fetch(`/api/translate/${id}/chapter`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chapterIndex: i,
              title: chapter.title,
              content: chapter.content,
            }),
          })
  
          if (!chapterResponse.ok) {
            const errorData = await chapterResponse.json().catch(() => ({}))
            throw new Error(
              errorData.error || `Chapter ${i + 1} translation failed`,
            )
          }
  
          const chapterData = await chapterResponse.json()
          translatedChapters[i] = {
            title: chapterData.translatedTitle,
            content: chapterData.translatedContent,
          }
  
          doneCount++
          console.log(
            `[translate] Chapter ${i + 1}/${chapters.length} done (${doneCount}/${chapters.length} total) via ${chapterData.provider}`,
          )
        }
      }
  
      const workers = Array.from(
        { length: Math.min(CONCURRENCY, chapters.length) },
        () =>
          worker().catch((err: unknown) => {
            if (!firstError) {
              firstError = err instanceof Error ? err : new Error(String(err))
            }
          }),
      )
  
      await Promise.all(workers)
  
      if (firstError) throw firstError
  
      // Step 3: Save completed translation
      const completeResponse = await fetch(`/api/translate/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "complete",
          translatedChapters,
          originalContent: fullOriginalContent,
        }),
      })
  
      if (!completeResponse.ok) {
        const errorData = await completeResponse.json().catch(() => ({}))
        throw new Error(errorData.error || "Failed to save translation")
      }
  
      // Success!
      setEpubFiles((prev) =>
        prev.map((epub) =>
          epub.id === id
            ? {
                ...epub,
                translation_status: "completed",
                translations: [
                  ...(epub.translations || []),
                  {
                    id: crypto.randomUUID(),
                    target_language: "de",
                    translation_status: "completed",
                    created_at: new Date().toISOString(),
                  },
                ],
              }
            : epub,
        ),
      )
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Translation failed"
      console.error("[translate] Error:", errorMessage)
      alert(`Translation failed: ${errorMessage}`)
  
      // Cancel / reset status on server
      await fetch(`/api/translate/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      }).catch(() => {})
  
      setEpubFiles((prev) =>
        prev.map((epub) =>
          epub.id === id ? { ...epub, translation_status: "none" } : epub,
        ),
      )
    }
  }

  const handleBulkMove = async (folderId: string | null) => {
    try {
      const movePromises = Array.from(selectedBooks).map((bookId) =>
        fetch(`/api/epub/${bookId}/move`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folderId }),
        }),
      )

      await Promise.all(movePromises)

      setEpubFiles((prev) => prev.map((epub) => (selectedBooks.has(epub.id) ? { ...epub, folder_id: folderId } : epub)))

      setSelectedBooks(new Set())
      setBulkMoveOpen(false)
    } catch (error) {
      console.error("[v0] Error bulk moving books:", error)
      alert("Failed to move books. Please try again.")
    }
  }

  const toggleBookSelection = (bookId: string) => {
    setSelectedBooks((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(bookId)) {
        newSet.delete(bookId)
      } else {
        newSet.add(bookId)
      }
      return newSet
    })
  }

  const toggleSelectAll = () => {
    if (selectedBooks.size === filteredBooks.length) {
      setSelectedBooks(new Set())
    } else {
      setSelectedBooks(new Set(filteredBooks.map((book) => book.id)))
    }
  }

  const filteredBooks = selectedFolder
    ? epubFiles.filter((epub) => epub.folder_id === selectedFolder)
    : epubFiles.filter((epub) => !epub.folder_id)

  const allBooksCount = epubFiles.filter((epub) => !epub.folder_id).length

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
    <div className="flex h-full gap-6">
      <aside className={`${sidebarCollapsed ? "w-12" : "w-64"} shrink-0 transition-all duration-300 relative`}>
        <div className="space-y-4 sticky top-20">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="absolute -right-3 top-0 h-6 w-6 p-0 rounded-full border bg-background shadow-sm z-10"
          >
            <ChevronLeft className={`h-4 w-4 transition-transform ${sidebarCollapsed ? "rotate-180" : ""}`} />
          </Button>

          {!sidebarCollapsed && (
            <>
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-sm text-muted-foreground uppercase">Folders</h3>
                <Button size="sm" variant="ghost" onClick={() => setFolderDialogOpen(true)} className="h-8 w-8 p-0">
                  <Plus className="h-4 w-4" />
                </Button>
              </div>

              <div className="space-y-1">
                <Button
                  variant={selectedFolder === null ? "secondary" : "ghost"}
                  className="w-full justify-start gap-2"
                  onClick={() => setSelectedFolder(null)}
                >
                  <FolderOpen className="h-4 w-4" />
                  <span className="flex-1 text-left">All Books</span>
                  <span className="text-xs text-muted-foreground">{allBooksCount}</span>
                </Button>

                {folders.map((folder) => {
                  const count = epubFiles.filter((epub) => epub.folder_id === folder.id).length
                  return (
                    <div key={folder.id} className="flex items-center gap-1">
                      <Button
                        variant={selectedFolder === folder.id ? "secondary" : "ghost"}
                        className="flex-1 justify-start gap-2"
                        onClick={() => setSelectedFolder(folder.id)}
                      >
                        <Folder className="h-4 w-4" />
                        <span className="flex-1 text-left truncate">{folder.name}</span>
                        <span className="text-xs text-muted-foreground">{count}</span>
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="sm" variant="ghost" className="h-8 w-8 p-0">
                            <Edit2 className="h-3 w-3" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => {
                              setEditingFolder(folder)
                              setFolderDialogOpen(true)
                            }}
                          >
                            <Edit2 className="h-4 w-4 mr-2" />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleDeleteFolder(folder.id)} className="text-destructive">
                            <Trash2 className="h-4 w-4 mr-2" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </aside>

      <div className="flex-1">
        {selectedBooks.size > 0 && (
          <div className="mb-4 p-4 bg-primary/10 rounded-lg flex items-center justify-between">
            <div className="flex items-center gap-4">
              <span className="font-medium">
                {selectedBooks.size} book{selectedBooks.size > 1 ? "s" : ""} selected
              </span>
              <Button size="sm" variant="ghost" onClick={() => setSelectedBooks(new Set())}>
                <X className="h-4 w-4 mr-2" />
                Clear Selection
              </Button>
            </div>
            <DropdownMenu open={bulkMoveOpen} onOpenChange={setBulkMoveOpen}>
              <DropdownMenuTrigger asChild>
                <Button size="sm" className="gap-2">
                  <MoveRight className="h-4 w-4" />
                  Move Selected
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-56">
                <DropdownMenuItem onClick={() => handleBulkMove(null)}>
                  <FolderOpen className="h-4 w-4 mr-2" />
                  All Books
                </DropdownMenuItem>
                {folders.map((folder) => (
                  <DropdownMenuItem key={folder.id} onClick={() => handleBulkMove(folder.id)}>
                    <Folder className="h-4 w-4 mr-2" />
                    {folder.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}

        {filteredBooks.length > 0 && (
          <div className="mb-4 flex items-center gap-2">
            <Checkbox
              id="select-all"
              checked={selectedBooks.size === filteredBooks.length && filteredBooks.length > 0}
              onCheckedChange={toggleSelectAll}
            />
            <label htmlFor="select-all" className="text-sm font-medium cursor-pointer">
              Select All
            </label>
          </div>
        )}

        {filteredBooks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <FolderX className="h-16 w-16 text-muted-foreground mb-4" />
            <h2 className="text-xl font-semibold mb-2">No books in this folder</h2>
            <p className="text-muted-foreground">Upload books or move existing books to this folder</p>
          </div>
        ) : (
          <div className="grid gap-6 grid-cols-1 lg:grid-cols-2">
            {filteredBooks.map((epub) => {
              const hasTranslation = epub.translations && epub.translations.length > 0
              const isTranslating = epub.translation_status === "translating"
              const isSelected = selectedBooks.has(epub.id)

              return (
                <Card key={epub.id} className={`flex flex-col group ${isSelected ? "ring-2 ring-primary" : ""}`}>
                  <CardHeader>
                    <div className="flex items-start gap-3">
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleBookSelection(epub.id)}
                        className="mt-1"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <CardTitle
                            className="text-base font-semibold line-clamp-2 flex-1 leading-tight"
                            title={epub.title}
                          >
                            {epub.title}
                          </CardTitle>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setEditingBookId(epub.id)
                              setEditDialogOpen(true)
                            }}
                            className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 hover:opacity-100 transition-opacity flex-shrink-0"
                          >
                            <Pencil className="h-3 w-3" />
                          </Button>
                        </div>
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
                        <span
                          className={
                            isTranslating
                              ? "text-blue-600 font-medium"
                              : hasTranslation
                                ? "text-green-600 font-medium"
                                : "text-muted-foreground"
                          }
                        >
                          {isTranslating ? (
                            <span className="flex items-center gap-1">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              Translating...
                            </span>
                          ) : hasTranslation ? (
                            "German"
                          ) : (
                            "Not translated"
                          )}
                        </span>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="outline" size="sm" className="w-full gap-2 bg-transparent">
                            <Folder className="h-4 w-4" />
                            Move to Folder
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent className="w-56">
                          <DropdownMenuItem onClick={() => handleMoveToFolder(epub.id, null)}>
                            <FolderOpen className="h-4 w-4 mr-2" />
                            All Books
                          </DropdownMenuItem>
                          {folders.map((folder) => (
                            <DropdownMenuItem key={folder.id} onClick={() => handleMoveToFolder(epub.id, folder.id)}>
                              <Folder className="h-4 w-4 mr-2" />
                              {folder.name}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>

                      {!hasTranslation && !isTranslating && (
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => handleTranslate(epub.id)}
                          className="w-full gap-2"
                        >
                          <Languages className="h-4 w-4" />
                          Translate to German
                        </Button>
                      )}

                      {isTranslating && (
                        <div className="w-full py-2 text-sm text-center text-muted-foreground bg-muted rounded-md">
                          Translation in progress...
                        </div>
                      )}

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
                          disabled={!hasTranslation}
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
              )
            })}
          </div>
        )}
      </div>

      {editingBookId && (
        <EditTitleDialog
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
          title={epubFiles.find((e) => e.id === editingBookId)?.title || ""}
          onSave={(newTitle) => handleUpdateTitle(editingBookId, newTitle)}
        />
      )}

      <FolderDialog
        open={folderDialogOpen}
        onOpenChange={(open) => {
          setFolderDialogOpen(open)
          if (!open) setEditingFolder(null)
        }}
        onSave={editingFolder ? handleUpdateFolder : handleCreateFolder}
        initialName={editingFolder?.name}
        title={editingFolder ? "Rename Folder" : "Create Folder"}
        description={editingFolder ? "Enter a new name for this folder" : "Enter a name for your new folder"}
      />
    </div>
  )
}
