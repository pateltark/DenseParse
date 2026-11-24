import os
import uuid
import asyncio
import tempfile
import logging
import threading

from fastapi import (
    FastAPI, UploadFile, File, HTTPException, Depends, Query, BackgroundTasks
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from jose import JWTError
from pypdf import PdfReader  # pip install pypdf  (add to requirements.txt)

from agent.llm_agent import ask_upload, ask_sec
from rag.emb_chunks import create_vectorstore
from auth import hash_password, verify_password, create_access_token, decode_token
from rag.db import (
    save_user_info, get_user_by_email, get_user_by_id, save_chat,
    save_doc_info, update_document_status, get_user_documents, list_sec_documents,
    delete_document, load_chat, clear_chat, list_chats
)
from agent.session import get_active_doc, get_active_set

from slowapi import Limiter
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse


logger = logging.getLogger(__name__)

app = FastAPI(title="DenSparse API")

security = HTTPBearer()

# ── CORS ────────────────────────────────────────────────────
# Add your real frontend URL(s) here, or set CORS_ORIGINS="https://a.com,https://b.com"
DEFAULT_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://65.2.146.75:3000",
]
origins = [
    o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()
] or DEFAULT_ORIGINS

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Request / response models ───────────────────────────────
class QueryRequest(BaseModel):
    question: str
    document_ids: list[str] | None = None
    chat_id: str | None = None  # None => start a new chat section


class RegisterRequest(BaseModel):
    # user_id is generated server-side now; if the frontend still sends it,
    # pydantic simply ignores the extra field.
    email: str
    password: str
    name: str


class LoginRequest(BaseModel):
    email: str
    password: str


class DocumentOut(BaseModel):
    id: str
    filename: str
    status: str  # 'processing', 'ready', or 'failed'


# ── Limits (tune via env vars, no code change needed) ───────
MAX_COMPARE_DOCS = 5

MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", 10))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024

MAX_IMAGE_MB = int(os.getenv("MAX_IMAGE_MB", 5))  # OCR is heavy, so images get a smaller cap
MAX_IMAGE_BYTES = MAX_IMAGE_MB * 1024 * 1024

MAX_PDF_PAGES = int(os.getenv("MAX_PDF_PAGES", 50))
MAX_DOCS_PER_USER = int(os.getenv("MAX_DOCS_PER_USER", 5))

IMAGE_EXTENSIONS = {"png", "jpg", "jpeg"}
ALLOWED_EXTENSIONS = {
    "pdf", "docx", "doc", "pptx", "xlsx",
    "csv", "txt", "md", "html", "png", "jpg", "jpeg"
}

# Only one heavy parse/embed job at a time (t3.small has 2 GB RAM).
# Extra jobs wait here and their status stays "processing".
_processing_lock = threading.Semaphore(1)


# ── Rate limiter setup ──────────────────────────────────────
# Reuses the same REDIS_HOST/PORT/PASSWORD/DB env vars as rag/redis_cache.py
def _build_redis_url() -> str:
    host = os.getenv("REDIS_HOST", "localhost")
    port = os.getenv("REDIS_PORT", "6379")
    password = os.getenv("REDIS_PASSWORD", "")
    db = os.getenv("REDIS_DB", "0")
    auth = f":{password}@" if password else ""
    # protocol=2 forces RESP2 compatibility for older Redis servers
    return f"redis://{auth}{host}:{port}/{db}?protocol=2"


def user_or_ip_key(request: Request) -> str:
    """Rate-limit by authenticated user id when possible, else by IP."""
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        try:
            payload = decode_token(auth_header.removeprefix("Bearer "))
            return f"user:{payload['sub']}"
        except JWTError:
            pass
    return f"ip:{get_remote_address(request)}"


limiter = Limiter(key_func=user_or_ip_key, storage_uri=_build_redis_url())
app.state.limiter = limiter
app.add_middleware(SlowAPIMiddleware)


RATE_LIMIT_MESSAGES = {
    "/auth/login": "Too many login attempts. Please wait a minute and try again.",
    "/auth/register": "Too many signup attempts. Please wait a minute and try again.",
    "/upload": "Too many uploads. Please wait a minute before uploading again.",
    "/chat/doc": "You're sending messages too fast. Please slow down.",
    "/chat/sec": "You're sending messages too fast. Please slow down.",
}


@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded):
    message = RATE_LIMIT_MESSAGES.get(
        request.url.path,
        "You're doing that too often. Please wait a moment and try again."
    )
    return JSONResponse(
        status_code=429,
        content={"error": "rate_limited", "message": message},
    )


@app.get("/")
def read_root():
    return {"status": "ok"}


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security)
):
    try:
        token = credentials.credentials
        payload = decode_token(token)
        return payload
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token.")


# ── Background document processing ──────────────────────────
def _process_document(tmp_path: str, user_id: str, doc_id: str):
    try:
        with _processing_lock:  # one heavy job at a time
            create_vectorstore(tmp_path, user_id, document_id=doc_id)
        update_document_status(doc_id, "ready")
    except Exception as exc:
        update_document_status(doc_id, "failed")
        logger.error(f"Failed embedding pipeline for document {doc_id}: {exc}")
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


# ── Documents ───────────────────────────────────────────────
@app.get("/documents", response_model=list[DocumentOut])
def list_documents(user=Depends(get_current_user)):
    return get_user_documents(user["sub"])


@app.delete("/documents/{document_id}")
def delete_document_route(document_id: str, user=Depends(get_current_user)):
    delete_document(user_id=user["sub"], document_id=document_id)
    return {"message": "Document deleted."}


# ── Auth ────────────────────────────────────────────────────
@app.post("/auth/register")
@limiter.limit("5/minute")
def register(request: Request, body: RegisterRequest):
    existing = get_user_by_email(body.email)
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered.")
    hashed = hash_password(body.password)
    user_id = str(uuid.uuid4())  # never trust a client-supplied id
    save_user_info(user_id, body.email, hashed, body.name)
    return {"message": "User registered successfully."}


@app.post("/auth/login")
@limiter.limit("5/minute")
def login(request: Request, body: LoginRequest):
    user = get_user_by_email(body.email)
    if not user or not verify_password(body.password, user["pass_word"]):
        raise HTTPException(status_code=401, detail="Invalid email or password.")
    token = create_access_token(user["user_id"], user["email"])
    return {"access_token": token, "token_type": "bearer"}


@app.get("/auth/me")
def get_me(user=Depends(get_current_user)):
    info = get_user_by_id(user["sub"])
    if not info:
        raise HTTPException(status_code=404, detail="User not found.")
    return info


@app.get("/health")
def health():
    return {"status": "ok"}


# ── Upload ──────────────────────────────────────────────────
@app.post("/upload")
@limiter.limit("5/minute")
async def upload_document(
    request: Request,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    user=Depends(get_current_user),
):
    filename = file.filename or ""
    ext = filename.split(".")[-1].lower() if "." in filename else ""
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported file format '.{ext}'.")

    max_bytes = MAX_IMAGE_BYTES if ext in IMAGE_EXTENSIONS else MAX_UPLOAD_BYTES
    max_mb = max_bytes // (1024 * 1024)

    # Quick reject using Content-Length (can be spoofed, so the streaming
    # check below is the real protection). 1 MB slack for multipart overhead.
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > max_bytes + 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"File exceeds the {max_mb} MB upload limit.")

    # Per-user quota (failed documents don't count)
    active_docs = [d for d in get_user_documents(user["sub"]) if d["status"] != "failed"]
    if len(active_docs) >= MAX_DOCS_PER_USER:
        raise HTTPException(
            status_code=403,
            detail=f"Document limit reached ({MAX_DOCS_PER_USER}). Delete one to upload another.",
        )

    total = 0
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=f".{ext}") as tmp:
            tmp_path = tmp.name
            while chunk := await file.read(1024 * 1024):  # 1 MB chunks
                total += len(chunk)
                if total > max_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=f"File exceeds the {max_mb} MB upload limit.",
                    )
                tmp.write(chunk)

        # Page limit for PDFs. Must be checked here: the background task
        # can't send an error back to the user.
        if ext == "pdf":
            try:
                pages = await asyncio.to_thread(lambda: len(PdfReader(tmp_path).pages))
            except Exception:
                raise HTTPException(
                    status_code=400,
                    detail="Could not read this PDF (it may be corrupted or password-protected).",
                )
            if pages > MAX_PDF_PAGES:
                raise HTTPException(
                    status_code=413,
                    detail=f"PDF has {pages} pages. The maximum is {MAX_PDF_PAGES}.",
                )
    except Exception:  # covers HTTPException AND client disconnects
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise

    doc_id = save_doc_info(user["sub"], file.filename, status="processing")
    background_tasks.add_task(_process_document, tmp_path, user["sub"], doc_id)

    return {
        "message": "Upload received, processing.",
        "document_id": doc_id,
        "status": "processing",
    }


# ── Chat ────────────────────────────────────────────────────
@app.post("/chat/doc")
@limiter.limit("10/minute")
async def chat_with_doc(request: Request, req: QueryRequest, user=Depends(get_current_user)):
    if req.document_ids and len(req.document_ids) > MAX_COMPARE_DOCS:
        raise HTTPException(
            status_code=400,
            detail=f"You can compare up to {MAX_COMPARE_DOCS} documents at once."
        )

    user_id = user["sub"]
    chat_id = req.chat_id or str(uuid.uuid4())

    save_chat(user_id=user_id, role="user", content=req.question, mode="doc", chat_id=chat_id)

    # ask_upload is a blocking LLM call: run it in a thread so the event loop stays free
    answer = await asyncio.to_thread(
        ask_upload,
        question=req.question,
        user_id=user_id,
        document_ids=req.document_ids,
    )

    save_chat(user_id=user_id, role="assistant", content=answer, mode="doc", chat_id=chat_id)

    return {"answer": answer, "chat_id": chat_id}


@app.post("/chat/sec")
@limiter.limit("10/minute")
async def chat_with_sec(request: Request, req: QueryRequest, user=Depends(get_current_user)):
    user_id = user["sub"]
    chat_id = req.chat_id or str(uuid.uuid4())

    save_chat(user_id=user_id, role="user", content=req.question, mode="sec", chat_id=chat_id)

    answer = await asyncio.to_thread(ask_sec, question=req.question, user_id=user_id)

    save_chat(user_id=user_id, role="assistant", content=answer, mode="sec", chat_id=chat_id)

    return {
        "answer": answer,
        "chat_id": chat_id,
        "active_doc": get_active_doc(user_id),
        "active_set": get_active_set(user_id),
    }


@app.get("/sec/active")
def sec_active(user=Depends(get_current_user)):
    user_id = user["sub"]
    return {
        "active_doc": get_active_doc(user_id),
        "active_set": get_active_set(user_id),
    }


@app.get("/sec/documents")
def sec_documents(user=Depends(get_current_user)):
    return list_sec_documents()


# ── Chat sections (sidebar) ─────────────────────────────────
@app.get("/chat/sessions")
def get_chat_sessions(
    mode: str = Query("sec", description="Chat mode: 'sec' or 'doc'"),
    user=Depends(get_current_user),
):
    if mode not in ["sec", "doc"]:
        raise HTTPException(status_code=400, detail="Invalid chat mode")
    return list_chats(user_id=user["sub"], mode=mode)


# ── Chat history (single section) ───────────────────────────
@app.get("/chat/history")
async def get_history(
    mode: str = Query("sec", description="Chat mode: 'sec' or 'doc'"),
    chat_id: str | None = Query(None, description="If omitted, returns all messages for the mode"),
    user=Depends(get_current_user),
):
    user_id = user["sub"]
    if mode not in ["sec", "doc"]:
        raise HTTPException(status_code=400, detail="Invalid chat mode")

    messages = load_chat(user_id=user_id, mode=mode, chat_id=chat_id)
    return {"messages": messages}


@app.delete("/chat/history")
async def clear_history(
    mode: str = Query("sec", description="Chat mode: 'sec' or 'doc'"),
    chat_id: str | None = Query(None, description="If omitted, clears all chats for the mode"),
    user=Depends(get_current_user),
):
    user_id = user["sub"]
    if mode not in ["sec", "doc"]:
        raise HTTPException(status_code=400, detail="Invalid chat mode")

    clear_chat(user_id=user_id, mode=mode, chat_id=chat_id)
    msg = f"Cleared chat {chat_id}" if chat_id else f"Cleared all history for {mode} mode"
    return {"status": "success", "message": msg}