"use client"

import { useRef, useState } from "react"
import useSWR from "swr"
import { Button } from "@/components/ui/button"
import {
  ApiError,
  deleteDocument,
  listDocuments,
  uploadDocument,
  type UserDocument,
} from "@/lib/api"
import { ACCEPT_STRING, UPLOAD_LIMITS, validateFile } from "@/lib/config"
import { FileText, Loader2, Trash2, Upload, AlertCircle } from "lucide-react"

const MAX_COMPARE_DOCS = UPLOAD_LIMITS.maxCompare

export function DocumentManager({
  selectedIds,
  onSelectionChange,
}: {
  selectedIds: string[]
  onSelectionChange: (ids: string[]) => void
}) {
  const { data, isLoading, mutate } = useSWR<UserDocument[]>("documents", listDocuments, {
    revalidateOnFocus: false,
    // Keep polling every 3s as long as at least one document is still
    // being processed server-side (Docling parsing + embeddings run in
    // the background, so the list needs to catch up on its own).
    refreshInterval: (latestData) =>
      latestData?.some((d) => d.status === "processing") ? 3000 : 0,
  })
  const documents = data ?? []

  // Failed documents don't count toward the quota (same rule as the backend).
  const activeCount = documents.filter((d) => d.status !== "failed").length
  const atLimit = activeCount >= UPLOAD_LIMITS.maxDocs

  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  async function onFileSelected(file: File | undefined) {
    if (!file) return

    if (atLimit) {
      setError(
        `Document limit reached (${UPLOAD_LIMITS.maxDocs}). Delete one to upload another.`,
      )
      if (inputRef.current) inputRef.current.value = ""
      return
    }

    // Quick type + size check before sending anything over the network.
    const problem = validateFile(file)
    if (problem) {
      setError(problem)
      if (inputRef.current) inputRef.current.value = ""
      return
    }

    setError(null)
    setUploading(true)
    try {
      // Resolves as soon as the backend accepts the file (status: "processing")
      // rather than waiting for embeddings to finish.
      await uploadDocument(file)
      await mutate()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed.")
      // The backend may have rejected for quota/limits, so refresh the list.
      void mutate()
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ""
    }
  }

  async function onDelete(id: string) {
    setDeletingId(id)
    setError(null)
    try {
      await deleteDocument(id)
      onSelectionChange(selectedIds.filter((x) => x !== id))
      await mutate()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Delete failed.")
    } finally {
      setDeletingId(null)
    }
  }

  function toggle(id: string) {
    if (selectedIds.includes(id)) {
      onSelectionChange(selectedIds.filter((x) => x !== id))
    } else {
      if (selectedIds.length >= MAX_COMPARE_DOCS) {
        setError(`You can compare up to ${MAX_COMPARE_DOCS} documents at once.`)
        return
      }
      setError(null)
      onSelectionChange([...selectedIds, id])
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Your Documents
        </h3>
        <span className="text-xs text-muted-foreground">
          {activeCount}/{UPLOAD_LIMITS.maxDocs}
        </span>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_STRING}
        className="sr-only"
        onChange={(e) => void onFileSelected(e.target.files?.[0])}
      />
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() => inputRef.current?.click()}
        disabled={uploading || atLimit}
        title={atLimit ? "Document limit reached. Delete one to upload another." : undefined}
      >
        {uploading ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Upload className="size-3.5" aria-hidden="true" />
        )}
        {uploading ? "Uploading…" : atLimit ? "Limit reached" : "Upload Document"}
      </Button>

      <p className="text-xs text-muted-foreground text-pretty">
        Max file size: 10 MB per document (images {UPLOAD_LIMITS.maxImageMb} MB, up to{" "}
        {UPLOAD_LIMITS.maxPages} pages for PDFs).
      </p>

      {error && (
        <p className="rounded-lg bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-1">
        {isLoading ? (
          <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Loading…
          </div>
        ) : documents.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground text-pretty">
            No documents yet. Upload a document to start chatting with it.
          </p>
        ) : (
          documents.map((doc) => {
            const selected = selectedIds.includes(doc.id)
            const isProcessing = doc.status === "processing"
            const isFailed = doc.status === "failed"
            return (
              <div
                key={doc.id}
                className={
                  "group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors " +
                  (selected ? "bg-primary/10" : "hover:bg-muted")
                }
              >
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => toggle(doc.id)}
                  disabled={isProcessing || isFailed}
                  className="size-3.5 shrink-0 accent-primary disabled:opacity-40"
                  aria-label={`Select ${doc.filename} for comparison`}
                />
                <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span
                  className={
                    "flex-1 truncate " + (isProcessing || isFailed ? "text-muted-foreground" : "")
                  }
                  title={doc.filename}
                >
                  {doc.filename}
                </span>

                {isProcessing && (
                  <span
                    className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
                    title="Still processing this document"
                  >
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    Processing…
                  </span>
                )}
                {isFailed && (
                  <span
                    className="flex shrink-0 items-center gap-1 text-xs text-destructive"
                    title="Processing failed — try deleting and re-uploading"
                  >
                    <AlertCircle className="size-3.5" aria-hidden="true" />
                    Failed
                  </span>
                )}

                <button
                  type="button"
                  onClick={() => void onDelete(doc.id)}
                  disabled={deletingId === doc.id}
                  className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  aria-label={`Delete ${doc.filename}`}
                >
                  {deletingId === doc.id ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  )}
                </button>
              </div>
            )
          })
        )}
      </div>

      {selectedIds.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {selectedIds.length} selected for comparison.
        </p>
      )}
    </div>
  )
}