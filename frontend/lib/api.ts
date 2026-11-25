// API client for the DenseParse FastAPI backend.
// Uses NEXT_PUBLIC_API_URL when set, and defaults to same-origin ("")
// so reverse proxies like Caddy can route requests without hardcoding localhost.

import { validateFile } from "@/lib/config"

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? ""

// Renamed from "sec_edgar_token". Existing sessions will be logged out once.
const TOKEN_KEY = "denseparse_token"

export function getToken(): string | null {
  if (typeof window === "undefined") return null
  return window.localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken() {
  if (typeof window === "undefined") return
  window.localStorage.removeItem(TOKEN_KEY)
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

type RequestOptions = {
  method?: string
  body?: unknown
  auth?: boolean
  isForm?: boolean
}

// Used when the server (or a proxy like nginx) returns a non-JSON error body.
const STATUS_FALLBACKS: Record<number, string> = {
  413: "That file is too large for the server.",
  429: "Too many requests. Please wait a moment and try again.",
}

// Guards against firing the redirect more than once if several requests
// 401 around the same time (e.g. sidebar + panel both loading on mount).
let redirectingToLogin = false

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, auth = true, isForm = false } = options

  const headers: Record<string, string> = {}
  if (auth) {
    const token = getToken()
    if (token) headers["Authorization"] = `Bearer ${token}`
  }

  let payload: BodyInit | undefined
  if (body !== undefined) {
    if (isForm) {
      payload = body as FormData
    } else {
      headers["Content-Type"] = "application/json"
      payload = JSON.stringify(body)
    }
  }

  let res: Response
  try {
    res = await fetch(`${API_URL}${path}`, { method, headers, body: payload })
  } catch {
    throw new ApiError(
      `Could not reach the backend at ${API_URL || "the server"}. Make sure FastAPI is running and reachable.`,
      0,
    )
  }

  if (!res.ok) {
    let detail = STATUS_FALLBACKS[res.status] ?? `Request failed (${res.status})`
    try {
      const data = await res.json()
      if (data?.detail) {
        detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail)
      } else if (data?.message) {
        detail = data.message
      }
    } catch {
      // ignore parse errors
    }

    // An authenticated request came back unauthorized — the stored token is
    // invalid or expired. Clear it and bounce back to the login screen without
    // throwing an unhandled rejection that pops up in Next.js.
    if (res.status === 401 && auth) {
      clearToken()
      if (typeof window !== "undefined") {
        if (!redirectingToLogin) {
          redirectingToLogin = true
          window.location.href = "/"
        }
        // Return a pending promise to halt downstream execution while redirecting
        return new Promise<T>(() => {})
      }
    }

    throw new ApiError(detail, res.status)
  }

  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

// ---- Types ----
export type ChatMessage = {
  role: "user" | "assistant"
  content: string
}

export type ChatSession = {
  chat_id: string
  title: string
  started_at: string
  updated_at: string
}

export type UserDocument = {
  id: string
  filename: string
  // Used to poll and show per-document processing state instead of
  // blocking the whole upload button.
  status: "processing" | "ready" | "failed"
}

export type ActiveDoc = {
  document_id: string
  ticker: string
  form_type: string
} | null

export type SecChatResponse = {
  answer: string
  chat_id: string
  active_doc: ActiveDoc
  active_set: unknown
}

export type DocChatResponse = {
  answer: string
  chat_id: string
}

export type CurrentUser = {
  user_id: string
  email: string
  name: string
}

// ---- Auth ----
export function register(input: {
  // The backend now generates the user id and ignores this field,
  // so it is optional here and can be dropped from callers.
  user_id?: string
  email: string
  password: string
  name: string
}) {
  return request<{ message: string }>("/auth/register", {
    method: "POST",
    body: input,
    auth: false,
  })
}

export function login(input: { email: string; password: string }) {
  return request<{ access_token: string; token_type: string }>("/auth/login", {
    method: "POST",
    body: input,
    auth: false,
  })
}

export function getMe() {
  return request<CurrentUser>("/auth/me")
}

export function health() {
  return request<{ status: string }>("/health", { auth: false })
}

// ---- Documents ----
export function listDocuments() {
  return request<UserDocument[]>("/documents")
}

export function listSecDocuments() {
  return request<unknown[]>("/sec/documents")
}

export function uploadDocument(file: File) {
  // Fast client-side check (type + size). The backend enforces the same limits.
  const problem = validateFile(file)
  if (problem) return Promise.reject(new ApiError(problem, 400))

  const form = new FormData()
  form.append("file", file)
  return request<{ message: string; document_id: string; status: string }>("/upload", {
    method: "POST",
    body: form,
    isForm: true,
  })
}

// Kept so any other file that still imports the old name keeps working.
export const uploadPdf = uploadDocument

export function deleteDocument(documentId: string) {
  return request<{ message: string }>(`/documents/${documentId}`, {
    method: "DELETE",
  })
}

// ---- Chat sections (sidebar) ----
export function listChatSessions(mode: "sec" | "doc") {
  return request<ChatSession[]>(`/chat/sessions?mode=${mode}`)
}

// ---- Chat ----
// Pass chatId to continue an existing thread; omit/undefined to start a new one.
// The response's chat_id is the one to persist client-side going forward.
export function chatDoc(question: string, chatId?: string, documentIds?: string[]) {
  return request<DocChatResponse>("/chat/doc", {
    method: "POST",
    body: { question, document_ids: documentIds ?? null, chat_id: chatId ?? null },
  })
}

export function chatSec(question: string, chatId?: string) {
  return request<SecChatResponse>("/chat/sec", {
    method: "POST",
    body: { question, document_ids: null, chat_id: chatId ?? null },
  })
}

export function secActive() {
  return request<{ active_doc: ActiveDoc; active_set: unknown }>("/sec/active")
}

export function getHistory(mode: "sec" | "doc", chatId?: string) {
  const q = chatId ? `?mode=${mode}&chat_id=${chatId}` : `?mode=${mode}`
  return request<{ messages: ChatMessage[] }>(`/chat/history${q}`)
}

export function clearHistory(mode: "sec" | "doc", chatId?: string) {
  const q = chatId ? `?mode=${mode}&chat_id=${chatId}` : `?mode=${mode}`
  return request<{ status: string; message: string }>(`/chat/history${q}`, {
    method: "DELETE",
  })
}