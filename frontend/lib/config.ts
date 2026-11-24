// lib/config.ts --> single place for the app name and upload limits.
// Keep the numbers in sync with the backend .env (MAX_UPLOAD_MB, MAX_IMAGE_MB,
// MAX_PDF_PAGES, MAX_DOCS_PER_USER). The backend is the real enforcement;
// these checks only give users a faster, friendlier error.

export const APP_NAME = "DenseParse"

export const UPLOAD_LIMITS = {
    maxMb: 10,
    maxImageMb: 5,
    maxPages: 50,
    maxDocs: 5,
    maxCompare: 5,
    imageExts: ["png", "jpg", "jpeg"] as string[],
    allowedExts: [
        "pdf",
        "docx",
        "doc",
        "pptx",
        "xlsx",
        "csv",
        "txt",
        "md",
        "html",
        "png",
        "jpg",
        "jpeg",
    ] as string[],
}

export const ACCEPT_STRING = UPLOAD_LIMITS.allowedExts.map((ext) => `.${ext}`).join(",")

export function getFileExt(filename: string): string {
    return filename.includes(".") ? (filename.split(".").pop() ?? "").toLowerCase() : ""
}

export function maxBytesForExt(ext: string): number {
    const mb = UPLOAD_LIMITS.imageExts.includes(ext)
        ? UPLOAD_LIMITS.maxImageMb
        : UPLOAD_LIMITS.maxMb
    return mb * 1024 * 1024
}

/** Returns an error message if the file is not allowed, otherwise null. */
export function validateFile(file: File): string | null {
    const ext = getFileExt(file.name)
    if (!UPLOAD_LIMITS.allowedExts.includes(ext)) {
        return `Unsupported file extension (.${ext}). Please upload a supported document or image.`
    }
    const maxBytes = maxBytesForExt(ext)
    if (file.size > maxBytes) {
        return `File is too large. The limit is ${maxBytes / (1024 * 1024)} MB for .${ext} files.`
    }
    return null
}