#!/usr/bin/env python3
"""
FetchStream Standalone Remote Runner Server.
A lightweight, high-performance FastAPI server for self-hosting FetchStream's cloud downloader
and multi-host uploader on any VPS, Home Lab, NAS, or local machine.
"""

import os
import sys
import time
import json
import uuid
import shutil
import subprocess
import threading
from typing import Optional, Dict, Any

from fastapi import FastAPI, HTTPException, Request, Header, BackgroundTasks, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI(
    title="FetchStream Remote Runner",
    version="2.0.0",
    description="Universal API endpoint for remote stream downloading and cloud multi-host uploading."
)

# ─── CORS Middleware ──────────────────────────────────────────────────────────

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── In-Memory Job Storage ────────────────────────────────────────────────────

jobs: Dict[str, Dict[str, Any]] = {}
job_processes: Dict[str, subprocess.Popen] = {}

PORT = int(os.environ.get("PORT", "8000"))
API_KEY = os.environ.get("API_KEY", "").strip()

# ─── Auth Verification Helper ─────────────────────────────────────────────────

def verify_auth(
    authorization: Optional[str] = None,
    x_api_key: Optional[str] = None,
    query_key: Optional[str] = None,
    body_key: Optional[str] = None
):
    if not API_KEY:
        return  # No auth required if API_KEY is not set
    token = (x_api_key or query_key or body_key or "").strip()
    if not token and authorization:
        parts = authorization.strip().split()
        if len(parts) == 2 and parts[0].lower() == "bearer":
            token = parts[1].strip()
        else:
            token = authorization.strip()

    if token != API_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized: Invalid or missing API Key")

# ─── Script Resolver ──────────────────────────────────────────────────────────

def get_uploader_script_path() -> str:
    env_path = os.environ.get("UPLOADER_SCRIPT")
    if env_path and os.path.exists(env_path):
        return os.path.abspath(env_path)

    base_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(base_dir, "scripts", "server_uploader.py"),
        os.path.join(base_dir, "..", "..", "scripts", "server_uploader.py"),
        os.path.join(base_dir, "..", "scripts", "server_uploader.py"),
        "/app/scripts/server_uploader.py",
        "scripts/server_uploader.py"
    ]
    for c in candidates:
        if os.path.exists(c):
            return os.path.abspath(c)
    raise FileNotFoundError("Could not find scripts/server_uploader.py")

# ─── Request Models ───────────────────────────────────────────────────────────

class RelayRequest(BaseModel):
    jobId: Optional[str] = None
    mediaUrl: str
    fileName: Optional[str] = "video.mp4"
    type: Optional[str] = "hls"
    format: Optional[str] = "mp4"
    service: Optional[str] = "gofile.io"
    threads: Optional[int] = 8
    headers: Optional[Dict[str, Any]] = None
    credentials: Optional[Dict[str, Any]] = None
    description: Optional[str] = None
    caption: Optional[str] = None
    apiKey: Optional[str] = None
    useFallbackProxy: Optional[bool] = True

class CallbackRequest(BaseModel):
    jobId: str
    status: str
    stage: Optional[str] = None
    progress: Optional[float] = None
    speed: Optional[str] = None
    url: Optional[str] = None
    links: Optional[list] = None
    service: Optional[str] = None
    fileName: Optional[str] = None
    fileSize: Optional[int] = None
    error: Optional[str] = None

# ─── Background Job Execution ─────────────────────────────────────────────────

def execute_job(job_id: str, req: RelayRequest):
    try:
        script_path = get_uploader_script_path()
    except Exception as e:
        jobs[job_id]["status"] = "FAILED"
        jobs[job_id]["error"] = f"Server configuration error: {str(e)}"
        return

    merged_creds = dict(req.credentials or {})
    if req.caption:
        merged_creds["caption"] = req.caption
    if req.description:
        merged_creds["description"] = req.description

    cmd = [
        sys.executable,
        script_path,
        "--job-id", job_id,
        "--media-url", req.mediaUrl,
        "--file-name", req.fileName or "video.mp4",
        "--type", req.type or "hls",
        "--format", req.format or "mp4",
        "--service", req.service or "gofile.io",
        "--threads", str(req.threads or 8),
        "--callback-url", f"http://127.0.0.1:{PORT}/api/server-callback",
        "--headers-json", json.dumps(req.headers or {}),
        "--credentials-json", json.dumps(merged_creds),
        "--use-fallback", str(req.useFallbackProxy).lower()
    ]

    popen_kwargs = {"stdout": subprocess.PIPE, "stderr": subprocess.PIPE, "text": True}
    if sys.platform != "win32":
        popen_kwargs["preexec_fn"] = os.setsid

    try:
        proc = subprocess.Popen(
            cmd,
            **popen_kwargs
        )
        job_processes[job_id] = proc
        stdout, stderr = proc.communicate()

        if proc.returncode == 0:
            if jobs[job_id].get("status") != "CANCELLED":
                jobs[job_id]["status"] = "COMPLETED"
                jobs[job_id]["stage"] = "COMPLETED"
                jobs[job_id]["progress"] = 100
                jobs[job_id]["speed"] = "Done"
                jobs[job_id]["error"] = None

                # Parse URL from stdout if not already set by callback
                if not jobs[job_id].get("url"):
                    import re
                    url_match = re.search(r"(?:Generated URL|upload succeeded(?:\s*\(curl\))?):\s*(https?://[^\s\n\r]+)", stdout or "")
                    if url_match:
                        found_url = url_match.group(1).strip()
                        jobs[job_id]["url"] = found_url
                        if not jobs[job_id].get("links"):
                            jobs[job_id]["links"] = [{"service": req.service or "Cloud", "url": found_url}]
        elif jobs[job_id].get("status") not in ["COMPLETED", "FAILED", "CANCELLED"]:
            jobs[job_id]["status"] = "FAILED"
            jobs[job_id]["stage"] = "FAILED"
            err_msg = stderr.strip() or stdout.strip() or f"Process exited with code {proc.returncode}"
            print(f"[ERROR] Job {job_id} failed: {err_msg}", file=sys.stderr, flush=True)
            jobs[job_id]["error"] = err_msg[-500:]
            jobs[job_id]["speed"] = f"Failed: {jobs[job_id]['error']}"
    except Exception as ex:
        if jobs[job_id]["status"] not in ["COMPLETED", "CANCELLED"]:
            jobs[job_id]["status"] = "FAILED"
            jobs[job_id]["stage"] = "FAILED"
            jobs[job_id]["error"] = str(ex)
            jobs[job_id]["speed"] = f"Failed: {str(ex)}"
    finally:
        job_processes.pop(job_id, None)

# ─── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/")
@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "service": "FetchStream Remote Runner",
        "version": "2.0.0",
        "active_jobs": len(job_processes),
        "total_jobs": len(jobs),
        "auth_enabled": bool(API_KEY)
    }

@app.post("/api/server-relay")
@app.post("/api/tasks")
async def dispatch_job(
    req: RelayRequest,
    background_tasks: BackgroundTasks,
    authorization: Optional[str] = Header(None),
    x_api_key: Optional[str] = Header(None)
):
    verify_auth(authorization, x_api_key, body_key=req.apiKey)

    if not req.mediaUrl:
        raise HTTPException(status_code=400, detail="Missing required 'mediaUrl' parameter.")

    job_id = req.jobId or f"job_{int(time.time() * 1000)}_{uuid.uuid4().hex[:6]}"

    # Prevent duplicate job dispatching (e.g. race condition between popup and downloader tab)
    if job_id in jobs and jobs[job_id].get("status") in ["QUEUED", "RUNNING"]:
        print(f"[!] Job {job_id} is already queued/running. Ignoring duplicate dispatch request.", flush=True)
        return {
            "jobId": job_id,
            "status": jobs[job_id].get("status", "RUNNING"),
            "message": "Job is already running on remote runner."
        }

    jobs[job_id] = {
        "jobId": job_id,
        "status": "QUEUED",
        "stage": "DISPATCHED",
        "progress": 0,
        "speed": "Initializing...",
        "fileName": req.fileName or "video.mp4",
        "fileSize": 0,
        "url": None,
        "links": [],
        "service": req.service,
        "error": None,
        "createdAt": int(time.time())
    }

    # Start runner in background thread
    background_tasks.add_task(execute_job, job_id, req)

    return {
        "jobId": job_id,
        "status": "QUEUED",
        "message": "Job dispatched successfully to remote runner."
    }

@app.post("/api/server-callback")
async def update_job_status(cb: CallbackRequest):
    if cb.jobId not in jobs:
        jobs[cb.jobId] = {}

    current = jobs[cb.jobId]
    if current.get("status") == "CANCELLED":
        return {"ok": True, "cancelled": True}

    current["jobId"] = cb.jobId
    current["status"] = cb.status
    if cb.stage is not None:
        current["stage"] = cb.stage
    if cb.progress is not None:
        current["progress"] = cb.progress
    if cb.speed is not None:
        current["speed"] = cb.speed
    if cb.url is not None:
        current["url"] = cb.url
        if cb.url and (not current.get("links") or len(current.get("links")) == 0):
            current["links"] = [{"service": current.get("service") or "Cloud", "url": cb.url}]
    if cb.links is not None:
        if isinstance(cb.links, list) and len(cb.links) > 0:
            current["links"] = cb.links
        elif current.get("url") and (not current.get("links") or len(current.get("links")) == 0):
            current["links"] = [{"service": current.get("service") or "Cloud", "url": current["url"]}]
    if cb.fileName is not None:
        current["fileName"] = cb.fileName
    if cb.fileSize is not None:
        current["fileSize"] = cb.fileSize
    if cb.error is not None:
        current["error"] = cb.error
    if cb.status == "FAILED":
        if cb.speed is not None:
            current["speed"] = cb.speed
        elif cb.error is not None:
            current["speed"] = f"Failed: {cb.error}"
        else:
            current["speed"] = "Server task failed"
    elif cb.status in ["RUNNING", "COMPLETED"]:
        current["error"] = None
        if current.get("url") and (not current.get("links") or len(current.get("links")) == 0):
            current["links"] = [{"service": current.get("service") or "Cloud", "url": current["url"]}]

    return {"ok": True}

@app.get("/api/server-status")
@app.get("/api/tasks/{job_id}")
async def get_job_status(
    jobId: Optional[str] = Query(None),
    job_id: Optional[str] = None,
    apiKey: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None),
    x_api_key: Optional[str] = Header(None)
):
    verify_auth(authorization, x_api_key, query_key=apiKey)

    target_id = jobId or job_id
    if not target_id:
        raise HTTPException(status_code=400, detail="Missing required 'jobId' query parameter.")

    job = jobs.get(target_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job '{target_id}' not found.")

    return job

@app.get("/api/server-cancel")
@app.post("/api/server-cancel")
@app.post("/api/tasks/{job_id}/cancel")
async def cancel_job(
    request: Request,
    jobId: Optional[str] = Query(None),
    job_id: Optional[str] = None,
    apiKey: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None),
    x_api_key: Optional[str] = Header(None)
):
    body_data = {}
    try:
        body_data = await request.json()
    except Exception:
        pass

    body_key = body_data.get("apiKey") if isinstance(body_data, dict) else None
    verify_auth(authorization, x_api_key, query_key=apiKey, body_key=body_key)

    target_id = jobId or (body_data and (body_data.get("jobId") or body_data.get("id"))) or job_id
    if not target_id:
        return {"ok": True, "message": "No jobId provided."}

    if target_id not in jobs:
        jobs[target_id] = {}

    jobs[target_id]["jobId"] = target_id
    jobs[target_id]["status"] = "CANCELLED"
    jobs[target_id]["stage"] = "CANCELLED"
    jobs[target_id]["speed"] = "Cancelled by user"
    jobs[target_id]["error"] = "Cancelled by user"

    proc = job_processes.get(target_id)
    if proc:
        try:
            if sys.platform != "win32":
                import signal
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            else:
                proc.kill()
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        job_processes.pop(target_id, None)

    return {"ok": True, "jobId": target_id, "status": "CANCELLED"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
