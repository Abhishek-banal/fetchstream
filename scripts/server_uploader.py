#!/usr/bin/env python3
"""
FetchStream Universal Server-Side Stream Downloader & Cloud Uploader.
Handles:
1. M3U8/HLS stream downloading, decoding, and transmuxing via FFmpeg.
2. Automatic Cloudflare Pages edge proxy fallback if origin CDN blocks GitHub runner Azure IPs (HTTP 403).
3. Direct file downloading for non-HLS assets.
4. Universal cloud uploading to GoFile, Buzzheavier, FFast, Storage.to, Pixeldrain, Catbox, S3/R2/B2, Hugging Face, and Telegram.
5. Real-time progress callbacks to Cloudflare Pages callback URL.
"""

import sys
import os
import time
import json
import re
import argparse
import subprocess
import threading
import concurrent.futures
import tempfile
import shutil
import io
import urllib.parse
import hashlib
import hmac
from datetime import datetime
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import mimetypes
import ssl
import requests
import requests.adapters

# ─── TLS 1.2 Adapter ────────────────────────────────────────────────────────
# Certain hosting edge servers (e.g. Buzzheavier / FFast) crash
# when Python's urllib3 negotiates TLS 1.3 with Post-Quantum key exchange
# (X25519MLKEM768). Capping at TLS 1.2 resolves the SSLEOFError immediately.
class TLS12Adapter(requests.adapters.HTTPAdapter):
    def init_poolmanager(self, *args, **kwargs):
        ctx = ssl.create_default_context()
        ctx.maximum_version = ssl.TLSVersion.TLSv1_2
        kwargs['ssl_context'] = ctx
        return super().init_poolmanager(*args, **kwargs)

try:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    HAS_CRYPTOGRAPHY = True
except ImportError:
    HAS_CRYPTOGRAPHY = False

try:
    import pyrogram.utils
    # Fix Pyrogram 32-bit channel ID overflow for modern Telegram 64-bit channels (e.g. -1001234567890)
    pyrogram.utils.MIN_CHANNEL_ID = -10099999999999
    pyrogram.utils.MAX_CHANNEL_ID = -1000000000000
except Exception:
    pass

# ─── Progress Callback Helper ───────────────────────────────────────────────

_global_callback_url = ""
_global_job_id = ""
_callback_session = None

def get_callback_session():
    global _callback_session
    if _callback_session is None:
        _callback_session = requests.Session()
        adapter = requests.adapters.HTTPAdapter(pool_connections=10, pool_maxsize=10, max_retries=0)
        _callback_session.mount("http://", adapter)
        _callback_session.mount("https://", adapter)
    return _callback_session

def send_callback(callback_url, job_id, status, stage=None, progress=None, speed=None, url=None, links=None, service=None, file_name=None, file_size=None, error=None):
    if not callback_url:
        return
    payload = {
        "jobId": job_id,
        "status": status,
        "stage": stage or status,
        "progress": progress,
        "speed": speed,
        "url": url,
        "links": links or [],
        "service": service,
        "fileName": file_name,
        "fileSize": file_size,
        "error": error
    }
    try:
        sess = get_callback_session()
        sess.post(callback_url, json=payload, timeout=3)
    except Exception:
        pass

class ProgressFileReader:
    """
    Streaming file reader that triggers callbacks during chunked HTTP uploads
    so users can see real-time byte counts and upload speeds in the extension.
    """
    def __init__(self, file_path, callback=None):
        self.file_obj = open(file_path, "rb")
        self.total_size = os.path.getsize(file_path)
        self.bytes_read = 0
        self.callback = callback
        self.start_time = time.time()
        self.last_cb_time = time.time()

    def read(self, size=-1):
        chunk = self.file_obj.read(size)
        if chunk:
            self.bytes_read += len(chunk)
            now = time.time()
            if self.callback and (now - self.last_cb_time >= 0.5 or self.bytes_read >= self.total_size):
                self.last_cb_time = now
                elapsed = max(now - self.start_time, 0.05)
                speed_mb = (self.bytes_read / (1024 * 1024)) / elapsed
                try:
                    self.callback(self.bytes_read, self.total_size, speed_mb)
                except Exception:
                    pass
        return chunk

    def seek(self, offset, whence=io.SEEK_SET):
        return self.file_obj.seek(offset, whence)

    def tell(self):
        return self.file_obj.tell()

    def close(self):
        self.file_obj.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def __len__(self):
        return self.total_size

def get_upload_file_stream(file_path, service_name="Cloud"):
    def on_progress(bytes_sent, total_bytes, speed_mb):
        if not _global_callback_url or not _global_job_id:
            return
        pct = 75 + int((bytes_sent / total_bytes) * 23)  # 75% to 98%
        sent_mb = bytes_sent / (1024 * 1024)
        tot_mb = total_bytes / (1024 * 1024)
        pct_int = int((bytes_sent / total_bytes) * 100)
        speed_str = f"{service_name} • {sent_mb:.1f}/{tot_mb:.1f} MB ({pct_int}%) • {speed_mb:.1f} MB/s"
        send_callback(_global_callback_url, _global_job_id, "RUNNING", stage="UPLOADING", progress=pct, speed=speed_str)

    return ProgressFileReader(file_path, callback=on_progress)

# ─── Local Cloudflare Forwarding Proxy ──────────────────────────────────────

DISALLOWED_FORWARD_HEADERS = {
    "host", "connection", "content-length", "content-type", "range",
    "transfer-encoding", "accept-encoding", "access-control-request-method",
    "access-control-request-headers", "sec-fetch-mode", "sec-fetch-site",
    "sec-fetch-dest", "sec-fetch-user", "priority"
}

def sanitize_headers(headers_dict):
    clean = {}
    for k, v in (headers_dict or {}).items():
        lk = str(k).lower().strip()
        if not v or lk in DISALLOWED_FORWARD_HEADERS or lk.startswith("sec-ch-") or lk.startswith("access-control-"):
            continue
        if lk == "origin" and ("chrome-extension://" in str(v) or "pages.dev" in str(v)):
            continue
        clean[str(k).strip()] = str(v).strip().replace("\r", "").replace("\n", "")
    return clean

_proxy_session = None

def get_proxy_session():
    global _proxy_session
    if _proxy_session is None:
        _proxy_session = requests.Session()
        adapter = requests.adapters.HTTPAdapter(
            pool_connections=25,
            pool_maxsize=25,
            max_retries=requests.adapters.Retry(total=2, backoff_factor=0.2)
        )
        _proxy_session.mount("http://", adapter)
        _proxy_session.mount("https://", adapter)
    return _proxy_session

class CloudflareHlsProxyHandler(BaseHTTPRequestHandler):
    proxy_url = ""
    custom_headers = {}
    segment_counter = 0

    def log_message(self, format, *args):
        pass  # Suppress default request logs

    def do_GET(self):
        parsed_path = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed_path.query)
        target_url = query.get("url", [""])[0]

        if not target_url:
            self.send_response(400)
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(b"Missing 'url' query parameter")
            self.close_connection = 1
            return

        try:
            req_headers = sanitize_headers(self.custom_headers)
            session = get_proxy_session()
            resp = session.post(
                self.proxy_url,
                json={"url": target_url, "headers": req_headers},
                timeout=45
            )

            content_type = resp.headers.get("content-type", "").lower()
            is_m3u8 = ("mpegurl" in content_type or "m3u8" in target_url.lower() or parsed_path.path == "/m3u8")

            if resp.status_code != 200:
                err_text = ""
                try:
                    err_text = resp.text[:200].strip()
                except Exception:
                    pass
                print(f"[!] [Proxy] Origin HTTP {resp.status_code} for {target_url[:80]} -> {err_text}", flush=True)

            if resp.status_code == 200 and is_m3u8:
                playlist_text = resp.content.decode("utf-8", errors="replace")
                rewritten_lines = []
                port = self.server.server_address[1]
                effective_base_url = resp.headers.get("x-final-url") or resp.url or target_url

                for line in playlist_text.splitlines():
                    trimmed = line.strip()
                    if not trimmed:
                        rewritten_lines.append(line)
                        continue

                    if trimmed.startswith("#"):
                        if 'URI=' in trimmed:
                            def rewrite_uri(match):
                                orig = match.group(2)
                                resolved = urllib.parse.urljoin(effective_base_url, orig)
                                proxied = f"http://127.0.0.1:{port}/segment?url={urllib.parse.quote(resolved)}"
                                return f'URI="{proxied}"'
                            rewritten_lines.append(re.sub(r'URI=(["\']?)([^"\',\s>]+)\1', rewrite_uri, trimmed))
                        else:
                            rewritten_lines.append(line)
                    else:
                        resolved_seg = urllib.parse.urljoin(effective_base_url, trimmed)
                        rewritten_lines.append(f"http://127.0.0.1:{port}/segment?url={urllib.parse.quote(resolved_seg)}")

                body_bytes = "\n".join(rewritten_lines).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/vnd.apple.mpegurl")
                self.send_header("Content-Length", str(len(body_bytes)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body_bytes)
                self.close_connection = 1
                print(f"[+] [Proxy] Rewrote & served M3U8 playlist ({len(body_bytes)} bytes)", flush=True)
                return

            CloudflareHlsProxyHandler.segment_counter += 1
            body_bytes = resp.content
            content_len = len(body_bytes)
            self.send_response(resp.status_code)
            out_ctype = resp.headers.get("content-type") or "video/MP2T"
            self.send_header("Content-Type", out_ctype)
            self.send_header("Content-Length", str(content_len))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body_bytes)
            self.close_connection = 1

            if CloudflareHlsProxyHandler.segment_counter % 5 == 1:
                seg_mb = content_len / (1024 * 1024)
                print(f"[Proxy] Segment #{CloudflareHlsProxyHandler.segment_counter} fetched via Cloudflare Edge ({seg_mb:.2f} MB)", flush=True)

        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as err:
            try:
                self.send_response(502)
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(str(err).encode("utf-8"))
                self.close_connection = 1
            except Exception:
                pass

class SilentThreadingHTTPServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        exc_type, _, _ = sys.exc_info()
        if exc_type in (ConnectionResetError, BrokenPipeError):
            return  # Suppress harmless client disconnect
        super().handle_error(request, client_address)

def start_local_proxy_forwarder(proxy_url, custom_headers, port=8889):
    CloudflareHlsProxyHandler.proxy_url = proxy_url
    CloudflareHlsProxyHandler.custom_headers = custom_headers
    CloudflareHlsProxyHandler.segment_counter = 0
    server = SilentThreadingHTTPServer(("127.0.0.1", port), CloudflareHlsProxyHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(f"[+] Started local Cloudflare multi-threaded proxy forwarder on 127.0.0.1:{port} -> {proxy_url}", flush=True)
    return server

# ─── M3U8 / HLS Stream Processing ──────────────────────────────────────────

def format_ffmpeg_headers(headers_dict):
    valid_lines = []
    clean_dict = sanitize_headers(headers_dict)
    has_ua = False
    for k, v in clean_dict.items():
        if k.lower() == "user-agent":
            has_ua = True
        valid_lines.append(f"{k}: {v}\r\n")
    if not has_ua:
        valid_lines.append("User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36\r\n")
    return "".join(valid_lines)

def build_ffmpeg_cmd(input_url, headers_str, output_path):
    cmd = [
        "ffmpeg", "-y",
        "-reconnect", "1",
        "-reconnect_at_eof", "1",
        "-reconnect_streamed", "1",
        "-reconnect_delay_max", "5",
        "-analyzeduration", "10M",
        "-probesize", "10M",
        "-protocol_whitelist", "file,http,https,tcp,tls,crypto,data"
    ]
    if headers_str and headers_str.strip():
        cmd.extend(["-headers", headers_str])

    cmd.extend([
        "-i", input_url,
        "-c", "copy",
        "-movflags", "+faststart",
        "-fflags", "+genpts+discardcorrupt",
        output_path
    ])
    return cmd

def extract_ffmpeg_error(stderr_lines):
    meaningful = []
    skip_prefixes = (
        "ffmpeg version", "built with", "configuration:",
        "libavutil", "libavcodec", "libavformat", "libavdevice",
        "libavfilter", "libswscale", "libswresample", "libpostproc"
    )
    for line in stderr_lines:
        clean = line.strip()
        if clean and not any(clean.startswith(p) for p in skip_prefixes):
            meaningful.append(clean)
    if meaningful:
        return " | ".join(meaningful[-6:])
    return "".join(stderr_lines[-3:]).strip()

# ─── High-Speed Parallel HLS Engine ─────────────────────────────────────────

def parse_hls_key_tag(tag_line, base_url):
    """
    Parses #EXT-X-KEY tag, extracting METHOD, URI, and IV.
    Example: #EXT-X-KEY:METHOD=AES-128,URI="https://.../key.bin",IV=0x0123...
    """
    method_match = re.search(r'METHOD=([^,\s]+)', tag_line)
    method = method_match.group(1).upper() if method_match else "NONE"
    if method == "NONE":
        return None

    uri_match = re.search(r'URI=(["\']?)([^"\',\s>]+)\1', tag_line)
    key_uri = urllib.parse.urljoin(base_url, uri_match.group(2)) if uri_match else None

    iv_match = re.search(r'IV=(0x[0-9a-fA-F]+)', tag_line)
    iv_bytes = bytes.fromhex(iv_match.group(1)[2:].zfill(32)) if iv_match else None

    return {
        "method": method,
        "uri": key_uri,
        "iv": iv_bytes,
        "key_bytes": None
    }

def decrypt_hls_segment(data, key_bytes, iv_bytes):
    """
    Decodes an AES-128-CBC encrypted TS segment and strips PKCS7 padding.
    """
    if not HAS_CRYPTOGRAPHY:
        raise RuntimeError("cryptography library required for AES-128 HLS streams")
    cipher = Cipher(algorithms.AES(key_bytes), modes.CBC(iv_bytes))
    decryptor = cipher.decryptor()
    decrypted = decryptor.update(data) + decryptor.finalize()
    if len(decrypted) > 0:
        pad_len = decrypted[-1]
        if 1 <= pad_len <= 16 and decrypted[-pad_len:] == bytes([pad_len]) * pad_len:
            decrypted = decrypted[:-pad_len]
    return decrypted

def download_hls_parallel(media_url, headers_dict, output_path, callback_url, job_id, threads=8, proxy_url=None):
    threads = max(2, min(int(threads), 24))
    print(f"[*] Commencing Turbo Parallel HLS Downloader with {threads} concurrent threads...", flush=True)
    send_callback(callback_url, job_id, "RUNNING", stage="DOWNLOADING", progress=10, speed=f"Parsing M3U8 ({threads} threads)...")

    clean_headers = sanitize_headers(headers_dict)
    session = requests.Session()
    try:
        https_adapter = TLS12Adapter(
            pool_connections=threads + 5,
            pool_maxsize=threads + 5,
            max_retries=requests.adapters.Retry(total=3, backoff_factor=0.3)
        )
        session.mount("https://", https_adapter)
    except Exception:
        https_adapter = requests.adapters.HTTPAdapter(
            pool_connections=threads + 5,
            pool_maxsize=threads + 5,
            max_retries=requests.adapters.Retry(total=3, backoff_factor=0.3)
        )
        session.mount("https://", https_adapter)

    http_adapter = requests.adapters.HTTPAdapter(
        pool_connections=threads + 5,
        pool_maxsize=threads + 5,
        max_retries=requests.adapters.Retry(total=3, backoff_factor=0.3)
    )
    session.mount("http://", http_adapter)
    session.headers.update(clean_headers)
    if not any(k.lower() == "user-agent" for k in clean_headers):
        session.headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"

    # 1. Fetch Playlist (direct with retries & TLS fallbacks, edge proxy if configured)
    resp = None
    last_fetch_error = None
    for attempt in range(3):
        try:
            resp = session.get(media_url, timeout=25)
            if resp.status_code == 200:
                break
            elif resp.status_code in [401, 403, 500, 502, 503, 504]:
                time.sleep(0.5 * (attempt + 1))
        except Exception as ex:
            last_fetch_error = ex
            print(f"[*] M3U8 playlist fetch attempt {attempt + 1} notice: {type(ex).__name__} ({ex})", flush=True)
            if attempt == 1:
                # Attempt 2: fallback with standard session (in case host requires TLS 1.3 or specific cipher)
                try:
                    fb_sess = requests.Session()
                    fb_sess.headers.update(session.headers)
                    resp = fb_sess.get(media_url, timeout=25, verify=False)
                    if resp.status_code == 200:
                        session = fb_sess
                        break
                except Exception as fb_ex:
                    last_fetch_error = fb_ex
            time.sleep(0.5 * (attempt + 1))

    if (resp is None or resp.status_code != 200) and proxy_url:
        print(f"[*] Direct M3U8 returned {resp.status_code if resp is not None else 'Error'}. Routing playlist via Cloudflare Edge...", flush=True)
        try:
            resp = session.post(proxy_url, json={"url": media_url, "headers": clean_headers}, timeout=45)
        except Exception as pe:
            print(f"[!] Proxy playlist fetch error: {pe}", flush=True)

    if resp is None or resp.status_code != 200:
        err_detail = f"HTTP {resp.status_code}" if resp is not None else f"{type(last_fetch_error).__name__} ({last_fetch_error})"
        raise RuntimeError(f"Failed to fetch M3U8 playlist: {err_detail}")

    effective_url = resp.url or media_url
    playlist_text = resp.text

    # Master playlist check
    if "#EXT-X-STREAM-INF:" in playlist_text:
        print("[*] Master playlist detected. Selecting highest bandwidth variant stream...", flush=True)
        lines = playlist_text.splitlines()
        best_bw = -1
        variant_url = None
        for i, line in enumerate(lines):
            line_str = line.strip()
            if line_str.startswith("#EXT-X-STREAM-INF:"):
                bw_match = re.search(r'BANDWIDTH=(\d+)', line_str)
                bw = int(bw_match.group(1)) if bw_match else 0
                for next_line in lines[i+1:]:
                    nxt = next_line.strip()
                    if nxt and not nxt.startswith("#"):
                        if bw >= best_bw:
                            best_bw = bw
                            variant_url = urllib.parse.urljoin(effective_url, nxt)
                        break
        if variant_url:
            print(f"[*] Selected variant playlist: {variant_url} (bandwidth: {best_bw})", flush=True)
            v_resp = None
            v_err = None
            for v_attempt in range(3):
                try:
                    v_resp = session.get(variant_url, timeout=25)
                    if v_resp.status_code == 200:
                        break
                except Exception as ve:
                    v_err = ve
                    time.sleep(0.5 * (v_attempt + 1))
            if (v_resp is None or v_resp.status_code != 200) and proxy_url:
                try:
                    v_resp = session.post(proxy_url, json={"url": variant_url, "headers": clean_headers}, timeout=45)
                except Exception:
                    pass
            if v_resp is None or v_resp.status_code != 200:
                v_detail = f"HTTP {v_resp.status_code}" if v_resp is not None else f"{type(v_err).__name__} ({v_err})"
                raise RuntimeError(f"Failed to fetch variant playlist: {v_detail}")
            effective_url = v_resp.url or variant_url
            playlist_text = v_resp.text

    # 2. Parse Segments, Keys, and Init maps
    segments = []
    current_key_info = None
    current_init_map = None
    key_cache = {}

    for line in playlist_text.splitlines():
        trimmed = line.strip()
        if not trimmed:
            continue
        if trimmed.startswith("#EXT-X-KEY:"):
            parsed_key = parse_hls_key_tag(trimmed, effective_url)
            if parsed_key and parsed_key.get("uri"):
                k_uri = parsed_key["uri"]
                if k_uri not in key_cache:
                    print(f"[*] Fetching AES key: {k_uri[:60]}...", flush=True)
                    kr = None
                    try:
                        kr = session.get(k_uri, timeout=15)
                    except Exception:
                        pass
                    if (not kr or kr.status_code != 200 or len(kr.content) != 16) and proxy_url:
                        try:
                            kr = session.post(proxy_url, json={"url": k_uri, "headers": clean_headers}, timeout=30)
                        except Exception:
                            pass
                    if kr and kr.status_code == 200 and len(kr.content) == 16:
                        key_cache[k_uri] = kr.content
                    else:
                        raise RuntimeError(f"Could not retrieve AES key from {k_uri}: HTTP {kr.status_code if kr else 'Unreachable'}")
                parsed_key["key_bytes"] = key_cache.get(k_uri)
            current_key_info = parsed_key
        elif trimmed.startswith("#EXT-X-MAP:"):
            map_match = re.search(r'URI=(["\']?)([^"\',\s>]+)\1', trimmed)
            if map_match:
                current_init_map = urllib.parse.urljoin(effective_url, map_match.group(2))
        elif not trimmed.startswith("#"):
            seg_resolved = urllib.parse.urljoin(effective_url, trimmed)
            segments.append({
                "index": len(segments),
                "url": seg_resolved,
                "key": current_key_info,
                "init_map": current_init_map
            })

    total_segs = len(segments)
    if total_segs == 0:
        raise ValueError("No media segments found in parsed M3U8 playlist.")

    print(f"[+] Parsed {total_segs} media segments. Downloading all segments in parallel ({threads} threads)...", flush=True)

    temp_dir = tempfile.mkdtemp(prefix=f"fs_{job_id}_")
    try:
        # Download init map if present (for fMP4 streams)
        if current_init_map:
            print(f"[*] Fetching fMP4 initialization header: {current_init_map[:60]}...", flush=True)
            init_resp = None
            try:
                init_resp = session.get(current_init_map, timeout=20)
            except Exception:
                pass
            if (not init_resp or init_resp.status_code != 200) and proxy_url:
                try:
                    init_resp = session.post(proxy_url, json={"url": current_init_map, "headers": clean_headers}, timeout=30)
                except Exception:
                    pass
            if init_resp and init_resp.status_code == 200:
                with open(os.path.join(temp_dir, "init.mp4"), "wb") as f_init:
                    f_init.write(init_resp.content)

        def fetch_segment(seg_info):
            s_idx = seg_info["index"]
            s_url = seg_info["url"]
            k_info = seg_info["key"]

            for attempt in range(4):
                try:
                    # 1. Try direct connection
                    s_res = session.get(s_url, timeout=30)
                    if s_res.status_code == 200:
                        seg_data = s_res.content
                    elif (s_res.status_code in (401, 403)) and proxy_url:
                        # Direct connection blocked by origin CDN -> route via Cloudflare proxy in parallel
                        proxied_res = session.post(proxy_url, json={"url": s_url, "headers": clean_headers}, timeout=45)
                        if proxied_res.status_code == 200:
                            seg_data = proxied_res.content
                        else:
                            raise RuntimeError(f"Proxy HTTP {proxied_res.status_code} for segment #{s_idx}")
                    else:
                        raise RuntimeError(f"HTTP {s_res.status_code} for segment #{s_idx}")

                    if k_info and k_info.get("method") == "AES-128" and k_info.get("key_bytes"):
                        iv = k_info.get("iv") or s_idx.to_bytes(16, byteorder="big")
                        seg_data = decrypt_hls_segment(seg_data, k_info["key_bytes"], iv)

                    dest_file = os.path.join(temp_dir, f"seg_{s_idx:06d}.ts")
                    with open(dest_file, "wb") as sf:
                        sf.write(seg_data)
                    return s_idx, len(seg_data)
                except (requests.RequestException, IOError, RuntimeError) as ex:
                    if attempt == 3:
                        raise RuntimeError(f"Failed to fetch segment #{s_idx} after 4 attempts: {ex}")
                    time.sleep(0.25 * (attempt + 1))

        completed_count = 0
        total_downloaded_bytes = 0
        start_time = time.time()
        last_cb_time = time.time()

        send_callback(
            callback_url, job_id, "RUNNING", stage="DOWNLOADING", progress=12,
            speed=f"Starting parallel download of {total_segs} segments ({threads} threads)..."
        )

        with concurrent.futures.ThreadPoolExecutor(max_workers=threads) as executor:
            future_to_idx = {executor.submit(fetch_segment, seg): seg["index"] for seg in segments}
            for future in concurrent.futures.as_completed(future_to_idx):
                s_idx, s_bytes = future.result()
                completed_count += 1
                total_downloaded_bytes += s_bytes

                now = time.time()
                if (now - last_cb_time >= 1.5) or (completed_count == total_segs):
                    last_cb_time = now
                    progress_pct = 12 + int((completed_count / total_segs) * 58)
                    elapsed = max(now - start_time, 0.05)
                    speed_mb = (total_downloaded_bytes / (1024 * 1024)) / elapsed
                    total_mb = total_downloaded_bytes / (1024 * 1024)
                    speed_str = f"Seg {completed_count}/{total_segs} ({int(completed_count/total_segs*100)}%) • {speed_mb:.1f} MB/s • {total_mb:.1f} MB"
                    send_callback(callback_url, job_id, "RUNNING", stage="DOWNLOADING", progress=progress_pct, speed=speed_str)

        total_download_time = max(time.time() - start_time, 0.1)
        final_mb = total_downloaded_bytes / (1024 * 1024)
        avg_speed = final_mb / total_download_time
        print(f"[+] All {total_segs} segments downloaded in {total_download_time:.1f}s ({final_mb:.2f} MB at {avg_speed:.1f} MB/s)!", flush=True)

        # 3. Local FFmpeg Concat Remux (0 internet downloading, strictly disk-to-disk packaging)
        send_callback(callback_url, job_id, "RUNNING", stage="CONVERTING", progress=71, speed="Remuxing into MP4 container (0-transcode copy)...")

        concat_txt = os.path.join(temp_dir, "concat.txt")
        with open(concat_txt, "w") as cf:
            for i in range(total_segs):
                cf.write(f"file 'seg_{i:06d}.ts'\n")

        remux_cmd = [
            "ffmpeg", "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", concat_txt,
            "-c", "copy",
            "-movflags", "+faststart",
            "-fflags", "+genpts+discardcorrupt",
            output_path
        ]
        t_remux_start = time.time()
        p = subprocess.run(remux_cmd, cwd=temp_dir, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        if p.returncode != 0 or not os.path.exists(output_path) or os.path.getsize(output_path) < 1024:
            print("[!] Concat demuxer failed, attempting binary direct stream merge...", flush=True)
            merged_ts = os.path.join(temp_dir, "merged.ts")
            with open(merged_ts, "wb") as out_ts:
                for i in range(total_segs):
                    seg_p = os.path.join(temp_dir, f"seg_{i:06d}.ts")
                    if os.path.exists(seg_p):
                        with open(seg_p, "rb") as in_seg:
                            shutil.copyfileobj(in_seg, out_ts)
            remux_cmd_direct = [
                "ffmpeg", "-y",
                "-i", merged_ts,
                "-c", "copy",
                "-movflags", "+faststart",
                "-fflags", "+genpts+discardcorrupt",
                output_path
            ]
            p2 = subprocess.run(remux_cmd_direct, cwd=temp_dir, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if p2.returncode != 0:
                err_text = p2.stderr.decode("utf-8", errors="ignore")[-400:]
                raise RuntimeError(f"FFmpeg MP4 remuxing failed: {err_text}")

        remux_time = max(time.time() - t_remux_start, 0.1)
        out_size_mb = os.path.getsize(output_path) / (1024 * 1024)
        print(f"[+] MP4 container remuxed in {remux_time:.1f}s! Size: {out_size_mb:.2f} MB", flush=True)
        send_callback(callback_url, job_id, "RUNNING", stage="CONVERTING", progress=74, speed=f"MP4 ready ({out_size_mb:.1f} MB)")
        return True

    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

def download_media(media_url, headers_dict, output_path, callback_url, job_id, proxy_url=None, use_fallback=True, threads=8):
    is_hls = (media_url.lower().endswith(".m3u8") or ".m3u8" in media_url.lower() or "hls" in media_url.lower())

    if is_hls:
        print(f"[*] Target media is an HLS stream. Launching Turbo Parallel Downloader with {threads} threads...", flush=True)
        try:
            download_hls_parallel(
                media_url, headers_dict, output_path, callback_url, job_id,
                threads=threads, proxy_url=(proxy_url if use_fallback else None)
            )
            return
        except Exception as parallel_err:
            print(f"[!] Turbo Parallel Downloader notice ({parallel_err}). Falling back to native FFmpeg engine...", flush=True)
            send_callback(
                callback_url, job_id, "RUNNING", stage="FALLBACK_FFMPEG", progress=15,
                speed="Parallel download fell back, starting native FFmpeg stream capture..."
            )
            try:
                run_ffmpeg_download(
                    media_url, headers_dict, output_path, callback_url, job_id,
                    proxy_url=proxy_url, use_fallback=use_fallback
                )
                return
            except Exception as ffmpeg_err:
                raise RuntimeError(f"All HLS capture engines failed: Parallel ({parallel_err}) | FFmpeg ({ffmpeg_err})")
    else:
        print(f"[*] Target media is a direct file. Launching direct file downloader...", flush=True)
        download_direct_file(
            media_url, headers_dict, output_path, callback_url, job_id,
            proxy_url=proxy_url, use_fallback=use_fallback
        )
        return

def run_ffmpeg_download(media_url, headers_dict, output_path, callback_url, job_id, proxy_url=None, use_fallback=True):
    headers_str = format_ffmpeg_headers(headers_dict)
    last_callback = time.time()

    # 1. Primary Attempt: Cloudflare Edge Network Proxy (if proxy_url configured)
    if proxy_url and use_fallback:
        print(f"[*] [Primary] Starting FFmpeg HLS capture via Cloudflare Edge Proxy: {media_url}", flush=True)
        send_callback(callback_url, job_id, "RUNNING", stage="PROXY_CONNECTING", progress=15, speed="Routing via Cloudflare Edge Network...")

        proxy_port = 8889
        proxy_server = start_local_proxy_forwarder(proxy_url, headers_dict, port=proxy_port)

        proxied_input_url = f"http://127.0.0.1:{proxy_port}/m3u8?url={urllib.parse.quote(media_url)}"
        proxy_cmd = build_ffmpeg_cmd(proxied_input_url, "", output_path)

        proxy_proc = subprocess.Popen(
            proxy_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True
        )

        proxy_stderr = []
        last_log_print = time.time()
        last_progress_time = time.time()

        while True:
            line = proxy_proc.stderr.readline()
            if not line and proxy_proc.poll() is not None:
                break
            if line:
                proxy_stderr.append(line)
                clean_line = line.strip()
                if "time=" in line or "frame=" in line or "size=" in line or "Error" in line or "Opening" in line:
                    last_progress_time = time.time()
                    if time.time() - last_log_print > 2 or "Error" in line:
                        print(f"[FFmpeg] {clean_line}", flush=True)
                        last_log_print = time.time()

                if "time=" in line and time.time() - last_callback > 3:
                    time_match = re.search(r"time=(\d+:\d+:\d+\.\d+)", line)
                    size_match = re.search(r"size=\s*(\d+\w+)", line)
                    time_str = time_match.group(1) if time_match else ""
                    size_str = size_match.group(1) if size_match else ""
                    send_callback(callback_url, job_id, "RUNNING", stage="CONVERTING_PROXY", progress=45, speed=f"Transmuxing via Cloudflare Edge • {time_str} ({size_str})")
                    last_callback = time.time()

            # Watchdog: if no progress produced for 45s, terminate proxy attempt and fallback to direct
            if time.time() - last_progress_time > 45:
                print("[!] Cloudflare proxy stream stalled (no progress for 45s). Terminating proxy attempt and falling back to direct connection...", flush=True)
                proxy_proc.terminate()
                break

        proxy_res = proxy_proc.wait()
        try:
            proxy_server.shutdown()
        except Exception:
            pass

        if proxy_res == 0 and os.path.exists(output_path) and os.path.getsize(output_path) > 1024:
            size_mb = os.path.getsize(output_path) / (1024 * 1024)
            print(f"[+] Cloudflare Edge Proxy capture succeeded: {size_mb:.2f} MB", flush=True)
            return True

        proxy_err = extract_ffmpeg_error(proxy_stderr)
        print(f"[!] Cloudflare Edge Proxy attempt did not succeed (exit code {proxy_res}): {proxy_err}. Falling back to direct GitHub runner...", flush=True)
        send_callback(callback_url, job_id, "RUNNING", stage="FALLBACK_DIRECT", progress=20, speed="Cloudflare proxy finished/failed, trying direct connection...")

    # 2. Fallback Attempt: Direct GitHub Runner Connection
    print(f"[*] [Direct] Executing direct FFmpeg capture from GitHub runner: {media_url}", flush=True)
    send_callback(callback_url, job_id, "RUNNING", stage="STREAM_CONNECTING", progress=20, speed="Connecting directly from runner...")

    base_cmd = build_ffmpeg_cmd(media_url, headers_str, output_path)
    process = subprocess.Popen(
        base_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True
    )

    stderr_output = []
    last_log_print = time.time()
    while True:
        line = process.stderr.readline()
        if not line and process.poll() is not None:
            break
        if line:
            stderr_output.append(line)
            clean_line = line.strip()
            if "time=" in line or "frame=" in line or "size=" in line or "Error" in line or "Opening" in line:
                if time.time() - last_log_print > 2 or "Error" in line:
                    print(f"[FFmpeg] {clean_line}", flush=True)
                    last_log_print = time.time()

            if "time=" in line and time.time() - last_callback > 3:
                time_match = re.search(r"time=(\d+:\d+:\d+\.\d+)", line)
                size_match = re.search(r"size=\s*(\d+\w+)", line)
                time_str = time_match.group(1) if time_match else ""
                size_str = size_match.group(1) if size_match else ""
                speed_str = f"Transmuxing • Time: {time_str} ({size_str})"
                send_callback(callback_url, job_id, "RUNNING", stage="CONVERTING", progress=45, speed=speed_str)
                last_callback = time.time()

    return_code = process.wait()

    if return_code == 0 and os.path.exists(output_path) and os.path.getsize(output_path) > 1024:
        size_mb = os.path.getsize(output_path) / (1024 * 1024)
        print(f"[+] Direct FFmpeg download succeeded: {size_mb:.2f} MB", flush=True)
        return True

    err_summary = extract_ffmpeg_error(stderr_output)
    raise RuntimeError(f"FFmpeg failed with exit code {return_code}: {err_summary[:1000]}")

# ─── Direct File Downloading ───────────────────────────────────────────────

def download_direct_file(media_url, headers_dict, output_path, callback_url, job_id, proxy_url=None, use_fallback=True):
    clean_headers = sanitize_headers(headers_dict)
    req_headers = {
        "User-Agent": clean_headers.get("User-Agent") or clean_headers.get("user-agent") or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    }
    for k, v in clean_headers.items():
        if k.lower() != "user-agent":
            req_headers[k] = str(v)

    last_callback = time.time()

    # 1. Primary Attempt: Direct GitHub Runner Connection (Full Bandwidth)
    try:
        print(f"[*] [Direct] Downloading directly from GitHub runner: {media_url}", flush=True)
        send_callback(callback_url, job_id, "RUNNING", stage="DOWNLOADING", progress=20, speed="Downloading file directly...")

        with requests.get(media_url, headers=req_headers, stream=True, timeout=90) as r:
            r.raise_for_status()
            total_length = r.headers.get("content-length")
            total_bytes = int(total_length) if total_length else 0
            downloaded = 0
            last_log_print = time.time()

            with open(output_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=4 * 1024 * 1024):
                    if chunk:
                        f.write(chunk)
                        downloaded += len(chunk)
                        if time.time() - last_callback > 3:
                            pct = 20 + int((downloaded / total_bytes) * 45) if total_bytes > 0 else 45
                            speed_str = f"Downloaded {downloaded / (1024*1024):.1f} MB" + (f" / {total_bytes / (1024*1024):.1f} MB" if total_bytes > 0 else "")
                            send_callback(callback_url, job_id, "RUNNING", stage="DOWNLOADING", progress=pct, speed=speed_str)
                            last_callback = time.time()
                        if time.time() - last_log_print > 3:
                            print(f"[Direct Downloader] {downloaded / (1024*1024):.1f} MB downloaded...", flush=True)
                            last_log_print = time.time()

        if os.path.exists(output_path) and os.path.getsize(output_path) > 1024:
            print(f"[+] Direct file download complete: {os.path.getsize(output_path) / (1024*1024):.2f} MB", flush=True)
            return os.path.getsize(output_path)
    except Exception as direct_err:
        print(f"[!] Direct download notice ({direct_err}).", flush=True)
        if not (proxy_url and use_fallback):
            raise

    # 2. Fallback Attempt: Cloudflare Edge Network Proxy (if proxy_url configured)
    if proxy_url and use_fallback:
        print(f"[*] [Fallback Proxy] Routing direct media file via Cloudflare Edge Proxy: {media_url}", flush=True)
        send_callback(callback_url, job_id, "RUNNING", stage="PROXY_DOWNLOADING", progress=20, speed="Downloading via Cloudflare Edge Network...")
        try:
            with requests.post(proxy_url, json={"url": media_url, "headers": req_headers}, stream=True, timeout=90) as r:
                r.raise_for_status()
                total_length = r.headers.get("content-length")
                total_bytes = int(total_length) if total_length else 0
                downloaded = 0
                last_log_print = time.time()
                with open(output_path, "wb") as f:
                    for chunk in r.iter_content(chunk_size=4 * 1024 * 1024):
                        if chunk:
                            f.write(chunk)
                            downloaded += len(chunk)
                            if time.time() - last_callback > 3:
                                pct = 20 + int((downloaded / total_bytes) * 45) if total_bytes > 0 else 45
                                speed_str = f"Cloudflare Proxy: {downloaded / (1024*1024):.1f} MB" + (f" / {total_bytes / (1024*1024):.1f} MB" if total_bytes > 0 else "")
                                send_callback(callback_url, job_id, "RUNNING", stage="DOWNLOADING", progress=pct, speed=speed_str)
                                last_callback = time.time()
                            if time.time() - last_log_print > 3:
                                print(f"[Proxy Downloader] {downloaded / (1024*1024):.1f} MB downloaded...", flush=True)
                                last_log_print = time.time()

            if os.path.exists(output_path) and os.path.getsize(output_path) > 1024:
                print(f"[+] Download via Cloudflare Edge Proxy complete: {os.path.getsize(output_path) / (1024*1024):.2f} MB", flush=True)
                return os.path.getsize(output_path)
        except Exception as proxy_err:
            raise RuntimeError(f"Both direct and proxy downloads failed: {proxy_err}")

    return os.path.getsize(output_path)

# ─── Universal Cloud Uploaders ─────────────────────────────────────────────

def upload_gofile(file_path, file_name, creds):
    print("[*] Uploading to GoFile...")
    token = str(creds.get("token") or "").strip()
    folder_id = str(creds.get("folderId") or "").strip()

    # If no user token provided, obtain a guest account session and root folder
    if not token:
        try:
            print("[*] Requesting GoFile guest session...", flush=True)
            acc_res = requests.post("https://api.gofile.io/accounts", timeout=15)
            if acc_res.ok:
                acc_data = acc_res.json()
                if acc_data.get("status") == "ok" and acc_data.get("data"):
                    token = acc_data["data"].get("token", "").strip()
                    if not folder_id:
                        folder_id = acc_data["data"].get("rootFolder", "").strip()
                    print(f"[+] GoFile guest session initialized (folder: {folder_id[:8]}...)", flush=True)
        except Exception as ex:
            print(f"[!] Warning initializing GoFile guest session: {ex}", flush=True)

    upload_url = "https://upload.gofile.io/uploadfile"
    try:
        srv_res = requests.get("https://api.gofile.io/servers", timeout=10)
        if srv_res.ok:
            data = srv_res.json()
            if data.get("status") == "ok" and data.get("data", {}).get("servers"):
                best_server = data["data"]["servers"][0]["name"]
                upload_url = f"https://{best_server}.gofile.io/contents/uploadfile"
    except Exception as e:
        print(f"[!] Warning fetching GoFile servers ({e}), using default endpoint {upload_url}")

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"

    data_payload = {}
    if folder_id:
        data_payload["folderId"] = folder_id

    def try_post(target_url):
        with get_upload_file_stream(file_path, "GoFile") as f:
            return requests.post(
                target_url,
                files={"file": (file_name, f, "application/octet-stream")},
                data=data_payload,
                headers=headers,
                timeout=1200
            )

    r = try_post(upload_url)

    # If storage-specific upload returned error and was not the default endpoint, retry via default upload.gofile.io
    if not r.ok and upload_url != "https://upload.gofile.io/uploadfile":
        print(f"[!] Primary GoFile upload failed ({r.status_code}), trying default endpoint https://upload.gofile.io/uploadfile...", flush=True)
        try:
            r = try_post("https://upload.gofile.io/uploadfile")
        except Exception as retry_ex:
            print(f"[!] Retry endpoint error: {retry_ex}", flush=True)

    if not r.ok:
        raise RuntimeError(f"GoFile HTTP error ({r.status_code}): {r.text[:200]}")

    try:
        res = r.json()
    except Exception:
        raise RuntimeError(f"GoFile non-JSON response ({r.status_code}): {r.text[:200]}")

    if res.get("status") == "ok" and res.get("data"):
        data = res["data"]
        page = data.get("downloadPage") or data.get("directLink")
        
        # Ensure uploaded folder and file are publicly visible to anyone with the link
        active_token = (token or data.get("guestToken") or "").strip()
        parent_folder = data.get("parentFolder")
        file_id = data.get("id")
        
        if active_token:
            auth_h = {"Authorization": f"Bearer {active_token}", "Content-Type": "application/json"}
            if parent_folder:
                try:
                    upd_res = requests.put(
                        f"https://api.gofile.io/contents/{parent_folder}/update",
                        headers=auth_h,
                        json={"attribute": "public", "attributeValue": "true"},
                        timeout=10
                    )
                    if upd_res.ok:
                        print(f"[+] GoFile parent folder set to public ({parent_folder})", flush=True)
                except Exception as ex:
                    print(f"[!] Warning setting GoFile parent folder public: {ex}", flush=True)
            if file_id:
                try:
                    requests.put(
                        f"https://api.gofile.io/contents/{file_id}/update",
                        headers=auth_h,
                        json={"attribute": "public", "attributeValue": "true"},
                        timeout=10
                    )
                except Exception:
                    pass

        if page:
            print(f"[+] GoFile upload succeeded: {page}")
            return page
    raise RuntimeError(f"GoFile upload error: {res.get('status') or r.text[:200]}")

def upload_buzzheavier(file_path, file_name, creds):
    print("[*] Uploading to Buzzheavier...")
    upload_url = f"https://w.buzzheavier.com/{urllib.parse.quote(file_name)}"
    headers = {
        "Content-Type": "application/octet-stream",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    }
    account_id = creds.get("accountId") or creds.get("token") or creds.get("apiKey")
    auth_header = []
    if account_id and str(account_id).strip():
        headers["Authorization"] = f"Bearer {str(account_id).strip()}"
        auth_header = ["-H", f"Authorization: Bearer {str(account_id).strip()}"]

    # 1. Primary attempt via curl (native HTTP/1.1 with TLS 1.3 - works reliably on Buzzheavier reverse proxy)
    curl_cmd = ["curl", "--http1.1", "--retry", "3", "--retry-all-errors", "-sS", "-w", "\n%{http_code}",
                "-H", "Content-Type: application/octet-stream",
                "-H", f"User-Agent: {headers['User-Agent']}"] + auth_header + ["-T", file_path, upload_url]
    try:
        print("[*] Uploading to Buzzheavier via curl (HTTP/1.1)...", flush=True)
        result = subprocess.run(curl_cmd, capture_output=True, text=True, timeout=1200)
        lines = (result.stdout or "").strip().splitlines()
        status_code = lines[-1].strip() if lines else "000"
        body = "\n".join(lines[:-1]).strip()
        if status_code.isdigit() and 200 <= int(status_code) < 300:
            try:
                data = json.loads(body)
                file_id = data.get("data", {}).get("id") or data.get("id")
                if file_id:
                    final_url = f"https://buzzheavier.com/{file_id}"
                    print(f"[+] Buzzheavier upload succeeded: {final_url}")
                    return final_url
            except Exception:
                pass
            if body.strip().startswith("http"):
                return body.strip()
            return f"https://buzzheavier.com/{urllib.parse.quote(file_name)}"
    except Exception as curl_ex:
        print(f"[!] Buzzheavier curl attempt notice: {curl_ex}", flush=True)

    # 2. Fallback attempt via requests
    try:
        session = requests.Session()
        with get_upload_file_stream(file_path, "Buzzheavier") as f:
            r = session.put(upload_url, data=f, headers=headers, timeout=1200)
        if r.ok:
            try:
                data = r.json()
                file_id = data.get("data", {}).get("id") or data.get("id")
                if file_id:
                    final_url = f"https://buzzheavier.com/{file_id}"
                    print(f"[+] Buzzheavier upload succeeded: {final_url}")
                    return final_url
            except Exception:
                pass
            if r.text.strip().startswith("http"):
                return r.text.strip()
            return f"https://buzzheavier.com/{urllib.parse.quote(file_name)}"
        raise RuntimeError(f"Buzzheavier failed ({r.status_code}): {r.text[:250]}")
    except Exception as req_ex:
        raise RuntimeError(f"Buzzheavier upload failed: {req_ex}")

def upload_fuckingfast(file_path, file_name, creds):
    print("[*] Uploading to FFast...")
    upload_url = f"https://w.fuckingfast.net/{urllib.parse.quote(file_name)}"
    headers = {
        "Content-Type": "application/octet-stream",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    }
    account_id = creds.get("accountId") or creds.get("token") or creds.get("apiKey")
    auth_header = []
    if account_id and str(account_id).strip():
        headers["Authorization"] = f"Bearer {str(account_id).strip()}"
        auth_header = ["-H", f"Authorization: Bearer {str(account_id).strip()}"]

    # 1. Primary attempt via curl (native HTTP/1.1 with TLS 1.3 - works reliably on FFast reverse proxy)
    curl_cmd = ["curl", "--http1.1", "--retry", "3", "--retry-all-errors", "-sS", "-w", "\n%{http_code}",
                "-H", "Content-Type: application/octet-stream",
                "-H", f"User-Agent: {headers['User-Agent']}"] + auth_header + ["-T", file_path, upload_url]
    try:
        print("[*] Uploading to FFast via curl (HTTP/1.1)...", flush=True)
        result = subprocess.run(curl_cmd, capture_output=True, text=True, timeout=1200)
        lines = (result.stdout or "").strip().splitlines()
        status_code = lines[-1].strip() if lines else "000"
        body = "\n".join(lines[:-1]).strip()
        if status_code.isdigit() and 200 <= int(status_code) < 300:
            try:
                data = json.loads(body)
                file_id = data.get("data", {}).get("id") or data.get("id")
                if file_id:
                    final_url = f"https://fuckingfast.net/{file_id}"
                    print(f"[+] FFast upload succeeded: {final_url}")
                    return final_url
            except Exception:
                pass
            if body.strip().startswith("http"):
                return body.strip()
            return f"https://fuckingfast.net/{urllib.parse.quote(file_name)}"
    except Exception as curl_ex:
        print(f"[!] FFast curl attempt notice: {curl_ex}", flush=True)

    # 2. Fallback attempt via requests
    try:
        session = requests.Session()
        with get_upload_file_stream(file_path, "FFast") as f:
            r = session.put(upload_url, data=f, headers=headers, timeout=1200)
        if r.ok:
            try:
                data = r.json()
                file_id = data.get("data", {}).get("id") or data.get("id")
                if file_id:
                    final_url = f"https://fuckingfast.net/{file_id}"
                    print(f"[+] FFast upload succeeded: {final_url}")
                    return final_url
            except Exception:
                pass
            if r.text.strip().startswith("http"):
                return r.text.strip()
            return f"https://fuckingfast.net/{urllib.parse.quote(file_name)}"
        raise RuntimeError(f"FFast failed ({r.status_code}): {r.text[:250]}")
    except Exception as req_ex:
        raise RuntimeError(f"FFast upload failed: {req_ex}")

def upload_storage_to(file_path, file_name, creds):
    print("[*] Uploading to Storage.to...")
    content_type = mimetypes.guess_type(file_name)[0] or "application/octet-stream"
    file_size = os.path.getsize(file_path)

    browser_ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"

    # Step 1: Initialize upload
    init_res = requests.post(
        "https://storage.to/api/upload/init",
        json={
            "filename": file_name,
            "content_type": content_type,
            "size": file_size
        },
        headers={"Content-Type": "application/json", "User-Agent": browser_ua},
        timeout=30
    )
    if not init_res.ok:
        raise RuntimeError(f"Storage.to init failed ({init_res.status_code}): {init_res.text[:200]}")

    init_data = init_res.json()
    r2_key = init_data.get("r2_key")
    if not r2_key:
        raise RuntimeError("Storage.to did not return an r2_key.")

    upload_id = init_data.get("upload_id")
    multipart_parts = []

    # Step 2: Upload bytes (single or multipart)
    if init_data.get("type") == "multipart" and init_data.get("initial_urls"):
        part_size = init_data.get("part_size", 10 * 1024 * 1024)
        initial_urls = init_data["initial_urls"]
        total_parts = init_data.get("total_parts") or len(initial_urls)

        with open(file_path, "rb") as f:
            for part_num in range(1, total_parts + 1):
                part_url = initial_urls.get(str(part_num))
                if not part_url:
                    raise RuntimeError(f"Storage.to missing URL for part {part_num}")
                chunk = f.read(part_size)
                if not chunk:
                    break
                part_res = requests.put(part_url, data=chunk, headers={"User-Agent": browser_ua}, timeout=300)
                if not part_res.ok:
                    raise RuntimeError(f"Storage.to part {part_num} failed ({part_res.status_code}): {part_res.text[:150]}")
                etag = part_res.headers.get("ETag") or part_res.headers.get("etag")
                if not etag:
                    raise RuntimeError(f"Storage.to part {part_num} missing ETag")
                multipart_parts.append({"partNumber": part_num, "etag": etag})
                pct = 75 + int((part_num / total_parts) * 23)
                pct_int = int((part_num / total_parts) * 100)
                send_callback(_global_callback_url, _global_job_id, "RUNNING", stage="UPLOADING", progress=pct, speed=f"Storage.to • Part {part_num}/{total_parts} ({pct_int}%)")

        # Complete multipart
        comp_headers = {"Content-Type": "application/json", "User-Agent": browser_ua}
        if init_data.get("owner_token"):
            comp_headers["Authorization"] = f"Owner {init_data['owner_token']}"
        comp_res = requests.post(
            "https://storage.to/api/upload/complete-multipart",
            json={"upload_id": upload_id, "parts": multipart_parts},
            headers=comp_headers,
            timeout=60
        )
        if not comp_res.ok:
            raise RuntimeError(f"Storage.to multipart completion failed ({comp_res.status_code}): {comp_res.text[:200]}")

    elif init_data.get("upload_url"):
        with get_upload_file_stream(file_path, "Storage.to") as f:
            put_res = requests.put(
                init_data["upload_url"],
                data=f,
                headers={"Content-Type": content_type, "User-Agent": browser_ua},
                timeout=1200
            )
        if not put_res.ok:
            raise RuntimeError(f"Storage.to PUT failed ({put_res.status_code}): {put_res.text[:200]}")
    else:
        raise RuntimeError("Storage.to returned no upload_url or initial_urls.")

    # Step 3: Confirm upload to get shareable URL
    conf_res = requests.post(
        "https://storage.to/api/upload/confirm",
        json={
            "filename": file_name,
            "content_type": content_type,
            "size": file_size,
            "r2_key": r2_key
        },
        headers={"Content-Type": "application/json", "User-Agent": browser_ua},
        timeout=30
    )
    if not conf_res.ok:
        raise RuntimeError(f"Storage.to confirmation failed ({conf_res.status_code}): {conf_res.text[:200]}")

    conf_data = conf_res.json()
    file_info = conf_data.get("file") if isinstance(conf_data.get("file"), dict) else {}
    final_url = file_info.get("url") or conf_data.get("url") or (f"https://storage.to/{file_info.get('id')}" if file_info.get("id") else None)
    if final_url:
        print(f"[+] Storage.to upload succeeded: {final_url}")
        return final_url

    raise RuntimeError(f"Storage.to confirmation returned no URL: {conf_data}")

def upload_litterbox(file_path, file_name, headers=None):
    print("[*] Uploading to Litterbox (Catbox 72h temporary cloud)...", flush=True)
    if headers is None:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
        }
    payload = {"reqtype": "fileupload", "time": "72h"}
    with get_upload_file_stream(file_path, "Litterbox") as f:
        r = requests.post(
            "https://litterbox.catbox.moe/resources/internals/api.php",
            data=payload,
            files={"fileToUpload": (file_name, f, "application/octet-stream")},
            headers=headers,
            timeout=1200
        )
    url = r.text.strip()
    if url.startswith("http"):
        print(f"[+] Litterbox upload succeeded: {url}")
        return url
    raise RuntimeError(f"Litterbox failed: {url[:250]}")

def upload_catbox(file_path, file_name, creds):
    print("[*] Uploading to Catbox.moe...")
    file_size = os.path.getsize(file_path)
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    }

    # Catbox permanent has a 200MB limit. For files between 200MB and 1GB, route to Litterbox.
    if file_size > 200 * 1024 * 1024:
        if file_size <= 1024 * 1024 * 1024:
            return upload_litterbox(file_path, file_name, headers)
        else:
            raise ValueError(f"File size ({file_size / (1024*1024):.1f} MB) exceeds Catbox / Litterbox upload capacity. Please select GoFile, Buzzheavier, Hugging Face, or Pixeldrain.")

    payload = {"reqtype": "fileupload"}
    userhash = str(creds.get("userhash", "")).strip() if isinstance(creds, dict) else ""
    if userhash:
        payload["userhash"] = userhash

    try:
        with get_upload_file_stream(file_path, "Catbox") as f:
            r = requests.post(
                "https://catbox.moe/user/api.php",
                data=payload,
                files={"fileToUpload": (file_name, f, "application/octet-stream")},
                headers=headers,
                timeout=1200
            )
        url = r.text.strip()
        if url.startswith("http"):
            print(f"[+] Catbox upload succeeded: {url}")
            return url
        print(f"[!] Catbox returned '{url[:120]}'. Automatically falling back to Litterbox...", flush=True)
    except Exception as e:
        print(f"[!] Catbox error ({e}). Automatically falling back to Litterbox...", flush=True)

    return upload_litterbox(file_path, file_name, headers)

def upload_pixeldrain(file_path, file_name, creds):
    print("[*] Uploading to Pixeldrain...")
    api_key = ""
    if isinstance(creds, dict):
        api_key = (
            creds.get("apiKey")
            or creds.get("api_key")
            or creds.get("key")
            or creds.get("token")
            or (creds.get("pixeldrain.com", {}).get("apiKey") if isinstance(creds.get("pixeldrain.com"), dict) else None)
            or (creds.get("pixeldrain.com", {}).get("api_key") if isinstance(creds.get("pixeldrain.com"), dict) else None)
            or (creds.get("pixeldrain", {}).get("apiKey") if isinstance(creds.get("pixeldrain"), dict) else None)
            or (creds.get("pixeldrain", {}).get("api_key") if isinstance(creds.get("pixeldrain"), dict) else None)
            or ""
        )
    elif isinstance(creds, str):
        api_key = creds

    api_key = str(api_key or "").strip()
    if not api_key:
        raise ValueError("Pixeldrain requires a free API key for uploads. Generate one at https://pixeldrain.com/user/api_keys and paste it in Extension Settings.")

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    }
    auth = ("", api_key)

    # Official Pixeldrain domains maintained to bypass ISP / regional blocks
    pixeldrain_hosts = [
        "pixeldrain.com",
        "pixeldrain.net",
        "pixeldrain.nl",
        "pixeldrain.biz",
        "pixeldrain.tech",
        "pixeldrain.dev"
    ]

    last_err = None
    for host in pixeldrain_hosts:
        try:
            print(f"[*] Uploading to Pixeldrain via {host}...", flush=True)
            with get_upload_file_stream(file_path, "Pixeldrain") as f:
                r = requests.put(
                    f"https://{host}/api/file/{urllib.parse.quote(file_name)}",
                    data=f,
                    auth=auth,
                    headers=headers,
                    timeout=1200
                )
            if not r.ok:
                raise RuntimeError(f"Pixeldrain HTTP error ({r.status_code}): {r.text[:200]}")

            data = r.json()
            if data.get("id"):
                # Use the successful host so the returned link can be opened in the user's region
                final_url = f"https://{host}/u/{data['id']}"
                print(f"[+] Pixeldrain upload succeeded via {host}: {final_url}", flush=True)
                return final_url
            raise RuntimeError(f"Pixeldrain invalid response: {r.text[:250]}")
        except Exception as ex:
            print(f"[!] Pixeldrain host '{host}' failed ({ex}), trying next official mirror...", flush=True)
            last_err = ex
            continue

    raise RuntimeError(f"Pixeldrain upload failed on all available mirrors: {last_err}")

def sign_s3_v4(method, endpoint, bucket, path, region, access_key_id, secret_access_key):
    now = datetime.utcnow()
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    clean_endpoint = endpoint.rstrip("/")
    parsed = urllib.parse.urlparse(clean_endpoint)
    host = parsed.netloc

    endpoint_path = parsed.path.strip("/")
    if endpoint_path:
        full_path = f"{endpoint_path}/{bucket.strip('/')}/{path.lstrip('/')}" if bucket else f"{endpoint_path}/{path.lstrip('/')}"
    else:
        full_path = f"{bucket.strip('/')}/{path.lstrip('/')}" if bucket else path.lstrip('/')
    canonical_uri = "/" + "/".join(urllib.parse.quote(urllib.parse.unquote(seg), safe="") for seg in full_path.split("/"))
    canonical_headers = f"host:{host}\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:{amz_date}\n"
    signed_headers = "host;x-amz-content-sha256;x-amz-date"
    payload_hash = "UNSIGNED-PAYLOAD"

    canonical_req = f"{method}\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    credential_scope = f"{date_stamp}/{region}/s3/aws4_request"
    hashed_req = hashlib.sha256(canonical_req.encode("utf-8")).hexdigest()
    string_to_sign = f"AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{hashed_req}"

    def hmac_sha256(key, val):
        return hmac.new(key, val.encode("utf-8"), hashlib.sha256).digest()

    k_date = hmac_sha256(f"AWS4{secret_access_key}".encode("utf-8"), date_stamp)
    k_region = hmac.new(k_date, region.encode("utf-8"), hashlib.sha256).digest()
    k_service = hmac.new(k_region, b"s3", hashlib.sha256).digest()
    k_signing = hmac.new(k_service, b"aws4_request", hashlib.sha256).digest()
    signature = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    auth_header = f"AWS4-HMAC-SHA256 Credential={access_key_id}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}"
    return {
        "url": f"{parsed.scheme}://{host}{canonical_uri}",
        "headers": {
            "Host": host,
            "x-amz-date": amz_date,
            "x-amz-content-sha256": payload_hash,
            "Authorization": auth_header
        }
    }

def presign_s3_url(endpoint, bucket, path, region, access_key_id, secret_access_key, expires_in=604800):
    now = datetime.utcnow()
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    clean_endpoint = endpoint.rstrip("/")
    parsed = urllib.parse.urlparse(clean_endpoint)
    host = parsed.netloc

    endpoint_path = parsed.path.strip("/")
    if endpoint_path:
        full_path = f"{endpoint_path}/{bucket.strip('/')}/{path.lstrip('/')}" if bucket else f"{endpoint_path}/{path.lstrip('/')}"
    else:
        full_path = f"{bucket.strip('/')}/{path.lstrip('/')}" if bucket else path.lstrip('/')
    canonical_uri = "/" + "/".join(urllib.parse.quote(urllib.parse.unquote(seg), safe="") for seg in full_path.split("/"))
    credential_scope = f"{date_stamp}/{region}/s3/aws4_request"

    query_params = {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": f"{access_key_id}/{credential_scope}",
        "X-Amz-Date": amz_date,
        "X-Amz-Expires": str(expires_in),
        "X-Amz-SignedHeaders": "host"
    }

    sorted_query = urllib.parse.urlencode(sorted(query_params.items()), quote_via=urllib.parse.quote)
    canonical_headers = f"host:{host}\n"
    canonical_req = f"GET\n{canonical_uri}\n{sorted_query}\n{canonical_headers}\nhost\nUNSIGNED-PAYLOAD"
    hashed_req = hashlib.sha256(canonical_req.encode("utf-8")).hexdigest()
    string_to_sign = f"AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{hashed_req}"

    def hmac_sha256(key, val):
        return hmac.new(key, val.encode("utf-8"), hashlib.sha256).digest()

    k_date = hmac_sha256(f"AWS4{secret_access_key}".encode("utf-8"), date_stamp)
    k_region = hmac.new(k_date, region.encode("utf-8"), hashlib.sha256).digest()
    k_service = hmac.new(k_region, b"s3", hashlib.sha256).digest()
    k_signing = hmac.new(k_service, b"aws4_request", hashlib.sha256).digest()
    signature = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    return f"{parsed.scheme}://{host}{canonical_uri}?{sorted_query}&X-Amz-Signature={signature}"

def upload_s3_compatible(file_path, file_name, creds):
    print("[*] Uploading to S3 Compatible / R2 Storage...")
    endpoint = creds.get("endpoint", "").strip()
    bucket = creds.get("bucket", "").strip()
    region = creds.get("region", "auto").strip() or "auto"
    access_key = creds.get("accessKeyId", "").strip()
    secret_key = creds.get("secretAccessKey", "").strip()
    prefix = creds.get("prefix", "").strip()

    # Hugging Face S3 is strictly single-region in us-east-1
    if "hf.co" in endpoint:
        region = "us-east-1"

    # Sanitize file_name - strip query params or invalid path chars
    safe_name = re.sub(r'[\?\#\&].*$', '', file_name).strip()
    safe_name = os.path.basename(safe_name) or "file.bin"

    clean_prefix = f"{prefix.strip('/')}/" if prefix else ""
    target_path = f"{clean_prefix}{safe_name}"

    signed = sign_s3_v4("PUT", endpoint, bucket, target_path, region, access_key, secret_key)

    import mimetypes
    content_type = mimetypes.guess_type(safe_name)[0]
    if not content_type:
        ext = safe_name.split('.')[-1].lower() if '.' in safe_name else ''
        custom_mimes = {
            'webp': 'image/webp',
            'avif': 'image/avif',
            'svg': 'image/svg+xml',
            'ico': 'image/x-icon',
            'bmp': 'image/bmp',
            'iso': 'application/x-iso9660-image',
            'img': 'application/octet-stream',
            'bin': 'application/octet-stream',
            'dmg': 'application/x-apple-diskimage',
            'vmdk': 'application/octet-stream',
            '7z': 'application/x-7z-compressed',
            'rar': 'application/vnd.rar',
            'tar': 'application/x-tar',
            'gz': 'application/gzip',
            'bz2': 'application/x-bzip2',
            'xz': 'application/x-xz',
            'apk': 'application/vnd.android.package-archive',
            'ipa': 'application/octet-stream',
            'flac': 'audio/flac',
            'opus': 'audio/opus',
            'mkv': 'video/x-matroska',
            'weba': 'audio/webm'
        }
        content_type = custom_mimes.get(ext, 'application/octet-stream')
    upload_headers = dict(signed["headers"])
    upload_headers["Content-Type"] = content_type

    with get_upload_file_stream(file_path, "S3") as f:
        r = requests.put(signed["url"], data=f, headers=upload_headers, timeout=1200)
    if not r.ok:
        raise RuntimeError(f"S3 upload error ({r.status_code}): {r.text[:200]}")

    presigned = presign_s3_url(endpoint, bucket, target_path, region, access_key, secret_key)
    if "s3.hf.co" in endpoint or "hf.co" in endpoint:
        return resolve_hf_cdn_url(presigned)
    return presigned

def resolve_hf_cdn_url(presigned_url):
    if not presigned_url or "s3.hf.co" not in presigned_url:
        return presigned_url
    try:
        res = requests.get(
            presigned_url,
            headers={"Range": "bytes=0-0", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
            allow_redirects=True,
            timeout=15,
            stream=True
        )
        if res.url and ("cdn.hf.co" in res.url or "xet-bridge" in res.url or res.url != presigned_url):
            final_url = res.url
            res.close()
            print(f"[+] Resolved anonymous Hugging Face CDN URL: {final_url[:120]}...", flush=True)
            return final_url
        res.close()
    except Exception as e:
        print(f"[!] Warning: Could not resolve direct HF CDN redirect, using presigned URL: {e}")
    return presigned_url

def upload_hf_bucket(file_path, file_name, creds):
    print("[*] Uploading to Hugging Face Buckets...")
    bucket = creds.get("bucket", "").strip()
    access_key = creds.get("accessKeyId", "").strip()
    secret_key = creds.get("secretAccessKey", "").strip()
    prefix = creds.get("prefix", "").strip()
    safe_name = re.sub(r'[\?\#\&].*$', '', file_name).strip()
    safe_name = os.path.basename(safe_name) or "video.mp4"
    if not safe_name.endswith(('.mp4', '.mp3', '.mkv', '.ts', '.m4a')):
        safe_name = f"{safe_name}.mp4"

    clean_prefix = f"{prefix.strip('/')}/" if prefix else ""
    target_path = f"{clean_prefix}{safe_name}"

    if not bucket or not access_key or not secret_key:
        raise ValueError("Missing Hugging Face Bucket Name, Access Key ID, or Secret Key.")

    endpoint = "https://s3.hf.co"
    signed = sign_s3_v4("PUT", endpoint, bucket, target_path, "us-east-1", access_key, secret_key)

    import mimetypes
    content_type = mimetypes.guess_type(safe_name)[0] or "video/mp4"
    upload_headers = dict(signed["headers"])
    upload_headers["Content-Type"] = content_type

    print(f"[*] Uploading to {signed['url']}...")
    with get_upload_file_stream(file_path, "Hugging Face") as f:
        r = requests.put(signed["url"], data=f, headers=upload_headers, timeout=1200)
    if not r.ok:
        raise RuntimeError(f"HF upload error ({r.status_code}): {r.text[:300]}")

    presigned = presign_s3_url(endpoint, bucket, target_path, "us-east-1", access_key, secret_key, expires_in=604800)
    final_url = resolve_hf_cdn_url(presigned)
    print(f"[+] Hugging Face upload complete: {final_url}")
    return final_url

def get_video_metadata(file_path):
    width, height, duration = 0, 0, 0
    thumb_path = None
    try:
        cmd = [
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height,duration",
            "-of", "json",
            file_path
        ]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
        if res.returncode == 0:
            data = json.loads(res.stdout)
            streams = data.get("streams", [])
            if streams:
                width = int(streams[0].get("width") or 0)
                height = int(streams[0].get("height") or 0)
                duration = int(float(streams[0].get("duration") or 0))
    except Exception:
        pass

    try:
        thumb_candidate = file_path + ".thumb.jpg"
        ss_time = min(max(1, duration // 10), 5) if duration > 0 else 1
        t_cmd = [
            "ffmpeg", "-y", "-ss", str(ss_time),
            "-i", file_path,
            "-vframes", "1",
            "-vf", "scale=320:-1",
            "-q:v", "2",
            thumb_candidate
        ]
        t_res = subprocess.run(t_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        if t_res.returncode == 0 and os.path.exists(thumb_candidate) and os.path.getsize(thumb_candidate) > 100:
            thumb_path = thumb_candidate
    except Exception:
        pass

    return width, height, duration, thumb_path

async def upload_telegram_pyrogram(file_path, file_name, chat_id, bot_token, api_id, api_hash, caption=None):
    from pyrogram import Client
    import pyrogram.utils
    # Fix Pyrogram 32-bit channel ID overflow for modern Telegram 64-bit channels (e.g. -1001234567890)
    pyrogram.utils.MIN_CHANNEL_ID = -10099999999999
    pyrogram.utils.MAX_CHANNEL_ID = -1000000000000

    print("[*] Uploading via Pyrogram MTProto to Telegram (Native 2GB engine)...")
    app = Client("fs_server_bot", api_id=int(api_id), api_hash=str(api_hash), bot_token=str(bot_token), in_memory=True)
    async with app:
        target_chat = int(chat_id) if (chat_id.startswith("-") or chat_id.isdigit()) else chat_id

        def tg_progress(current, total):
            if not _global_callback_url or not _global_job_id:
                return
            pct = 75 + int((current / total) * 23)
            sent_mb = current / (1024 * 1024)
            tot_mb = total / (1024 * 1024)
            pct_int = int((current / total) * 100)
            speed_str = f"Telegram • {sent_mb:.1f}/{tot_mb:.1f} MB ({pct_int}%)"
            send_callback(_global_callback_url, _global_job_id, "RUNNING", stage="UPLOADING", progress=pct, speed=speed_str)

        lower_name = file_name.lower()
        is_video = lower_name.endswith((".mp4", ".mkv", ".mov", ".webm", ".m4v", ".avi"))
        is_audio = lower_name.endswith((".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".wav"))

        thumb_file = None
        try:
            if is_video:
                width, height, duration, thumb_file = get_video_metadata(file_path)
                print(f"[*] Sending as native streamable video (dim: {width}x{height}, dur: {duration}s, thumb: {bool(thumb_file)})...", flush=True)
                msg = await app.send_video(
                    chat_id=target_chat,
                    video=file_path,
                    file_name=file_name,
                    caption=caption or f"🎬 {file_name}",
                    duration=duration,
                    width=width,
                    height=height,
                    thumb=thumb_file,
                    supports_streaming=True,
                    progress=tg_progress
                )
            elif is_audio:
                print("[*] Sending as native streamable audio...", flush=True)
                msg = await app.send_audio(
                    chat_id=target_chat,
                    audio=file_path,
                    file_name=file_name,
                    caption=caption or f"🎵 {file_name}",
                    progress=tg_progress
                )
            else:
                msg = await app.send_document(
                    chat_id=target_chat,
                    document=file_path,
                    file_name=file_name,
                    caption=caption or f"📁 {file_name}",
                    progress=tg_progress
                )
        finally:
            if thumb_file and os.path.exists(thumb_file):
                try:
                    os.remove(thumb_file)
                except Exception:
                    pass

        msg_id = msg.id
        if str(target_chat).startswith("-100"):
            cid = str(target_chat).replace("-100", "")
            return f"https://t.me/c/{cid}/{msg_id}"
        return f"Telegram Message ID: {msg_id}"

def normalize_service(service):
    s = (service or "").strip().lower()
    if "," in s:
        return s
    mapping = {
        "gofile": "gofile.io",
        "gofile.io": "gofile.io",
        "buzzheavier": "buzzheavier.com",
        "buzzheavier.com": "buzzheavier.com",
        "fuckingfast": "fuckingfast.co",
        "fuckingfast.co": "fuckingfast.co",
        "storage": "storage.to",
        "storage.to": "storage.to",
        "catbox": "catbox.moe",
        "catbox.moe": "catbox.moe",
        "pixeldrain": "pixeldrain.com",
        "pixeldrain.com": "pixeldrain.com",
        "s3": "s3_compatible",
        "s3_compatible": "s3_compatible",
        "hf": "hf_buckets",
        "hf_buckets": "hf_buckets",
        "telegram": "telegram",
        "s3_hf_telegram": "s3_hf_telegram",
        "s3_aws_hf_telegram": "s3_hf_telegram",
        "hf_telegram": "hf_telegram",
        "s3_telegram": "s3_telegram",
        "all": "all",
        "custom": "custom"
    }
    return mapping.get(s, s)

def get_service_creds(all_creds, service):
    if not isinstance(all_creds, dict):
        return {}
    base_svc = service.split(".")[0]
    return (
        all_creds.get(service)
        or all_creds.get(base_svc)
        or (all_creds if (service not in all_creds and base_svc not in all_creds) else {})
    )

def upload_telegram(file_path, file_name, creds, caption_extra=""):
    bot_token = (creds.get("botToken") or "").strip()
    chat_id = (creds.get("chatId") or "").strip()
    api_id = (creds.get("apiId") or os.environ.get("TG_API_ID") or "6").strip()
    api_hash = (creds.get("apiHash") or os.environ.get("TG_API_HASH") or "eb06d4abfb49dc3eeb1aeb98ae0f581e").strip()

    if not bot_token or not chat_id:
        raise ValueError("Please provide your Telegram Bot Token and Chat ID in Settings.")

    file_size = os.path.getsize(file_path)
    file_size_mb = file_size / (1024 * 1024)

    custom_desc = (creds.get("caption") or creds.get("description") or "").strip()
    if custom_desc:
        caption = custom_desc
    else:
        caption = f"🎬 {file_name}"
        if caption_extra:
            caption += f"\n\n{caption_extra}"

    lower_name = file_name.lower()
    is_video = lower_name.endswith((".mp4", ".mkv", ".mov", ".webm", ".m4v", ".avi"))
    is_audio = lower_name.endswith((".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".wav"))
    method_name = "sendVideo" if is_video else ("sendAudio" if is_audio else "sendDocument")
    field_name = "video" if is_video else ("audio" if is_audio else "document")
    data_payload = {"chat_id": chat_id, "caption": caption}
    if is_video:
        data_payload["supports_streaming"] = "true"

    # Method 1: Local / Custom Telegram Bot API Server on port 8081 (supports up to 2000MB / 2GB)
    local_server = None
    custom_url = (creds.get("serverUrl") or os.environ.get("TG_BOT_SERVER_URL") or "").strip().rstrip("/")
    candidates = [c for c in [custom_url, "http://127.0.0.1:8081", "http://host.docker.internal:8081"] if c]
    for srv in candidates:
        try:
            chk = requests.get(srv, timeout=1.5)
            if chk.status_code in [200, 404]:
                local_server = srv
                break
        except Exception:
            pass

    if local_server:
        print(f"[*] Uploading {file_size_mb:.1f} MB file via local Telegram Bot API Server on port 8081 (2GB mode)...", flush=True)
        try:
            with get_upload_file_stream(file_path, "Telegram") as f:
                r = requests.post(
                    f"{local_server}/bot{bot_token}/{method_name}",
                    data=data_payload,
                    files={field_name: (file_name, f)},
                    timeout=1800
                )
            data = r.json()
            if data.get("ok"):
                msg_id = data["result"]["message_id"]
                clean_chat = str(chat_id)
                if clean_chat.startswith("-100"):
                    clean_chat = clean_chat[4:]
                    return f"https://t.me/c/{clean_chat}/{msg_id}"
                return f"Telegram Message ID: {msg_id}"
            else:
                print(f"[!] Local Bot API error: {data}. Falling back to Pyrogram MTProto...", flush=True)
        except Exception as local_err:
            print(f"[!] Local Bot API failed: {local_err}. Falling back to Pyrogram MTProto...", flush=True)

    # Method 2: Pyrogram MTProto Client (Native 2GB engine for files > 48MB or when credentials present)
    if file_size > 48 * 1024 * 1024 or (api_id and api_hash):
        print(f"[*] Uploading {file_size_mb:.1f} MB file via Pyrogram MTProto (Native 2GB engine)...", flush=True)
        try:
            import asyncio
            return asyncio.run(upload_telegram_pyrogram(file_path, file_name, chat_id, bot_token, api_id, api_hash, caption=caption))
        except Exception as pyro_err:
            print(f"[!] Pyrogram MTProto upload failed: {pyro_err}", flush=True)
            if file_size > 50 * 1024 * 1024:
                raise RuntimeError(
                    f"Telegram 2GB upload failed for {file_size_mb:.1f} MB file: {pyro_err}. "
                    "Official bot API strictly rejects files > 50MB."
                )

    # Method 3: Standard official api.telegram.org (for small files <= 50MB)
    print(f"[*] Uploading {file_size_mb:.1f} MB file via official api.telegram.org...", flush=True)
    with get_upload_file_stream(file_path, "Telegram") as f:
        r = requests.post(
            f"https://api.telegram.org/bot{bot_token}/{method_name}",
            data=data_payload,
            files={field_name: (file_name, f)},
            timeout=600
        )
    try:
        data = r.json()
    except Exception:
        raise RuntimeError(f"Telegram server returned non-JSON response (HTTP {r.status_code}): {r.text[:200]}")

    if data.get("ok"):
        msg_id = data["result"]["message_id"]
        clean_chat = str(chat_id)
        if clean_chat.startswith("-100"):
            clean_chat = clean_chat[4:]
            return f"https://t.me/c/{clean_chat}/{msg_id}"
        return f"Telegram Message ID: {msg_id}"
    raise RuntimeError(data.get("description") or f"Telegram Bot API error: {r.text[:200]}")

def execute_upload(service, file_path, file_name, creds, on_link_added=None):
    all_creds = creds.get("all_credentials", creds) if isinstance(creds, dict) else {}

    if "," in service:
        # Custom Multi-Host Selection
        selected_services = [s.strip() for s in service.split(",") if s.strip()]
        links = []
        errors = []
        for s in selected_services:
            try:
                res = execute_upload(s, file_path, file_name, all_creds, on_link_added=on_link_added)
                if isinstance(res, list):
                    links.extend(res)
                    if on_link_added:
                        on_link_added(links, s)
                elif res and (str(res).startswith("http") or "Telegram" in str(res)):
                    links.append({"service": s, "url": str(res)})
                    if on_link_added:
                        on_link_added(links, s)
            except Exception as e:
                errors.append(f"{s}: {e}")
                print(f"[!] Error uploading to {s}: {e}")
        if not links:
            raise RuntimeError(f"All selected hosts failed in multi-upload: {'; '.join(errors)}")
        return links

    norm_service = normalize_service(service)
    svc_creds = get_service_creds(all_creds, norm_service)

    if norm_service == "gofile.io":
        return upload_gofile(file_path, file_name, svc_creds)
    elif norm_service == "buzzheavier.com":
        return upload_buzzheavier(file_path, file_name, svc_creds)
    elif norm_service == "fuckingfast.co":
        return upload_fuckingfast(file_path, file_name, svc_creds)
    elif norm_service == "storage.to":
        return upload_storage_to(file_path, file_name, svc_creds)
    elif norm_service == "catbox.moe":
        return upload_catbox(file_path, file_name, svc_creds)
    elif norm_service == "pixeldrain.com":
        return upload_pixeldrain(file_path, file_name, svc_creds)
    elif norm_service == "s3_compatible":
        return upload_s3_compatible(file_path, file_name, svc_creds)
    elif norm_service == "hf_buckets":
        return upload_hf_bucket(file_path, file_name, svc_creds)
    elif norm_service == "telegram":
        return upload_telegram(file_path, file_name, svc_creds)
    elif norm_service in ("s3_hf_telegram", "hf_telegram", "s3_telegram"):
        # Combined Cloud Storage + Telegram Exact File Upload
        print(f"[*] Executing Combined Cloud Storage + Telegram 2GB File Relay ({norm_service})...", flush=True)
        hf_creds = all_creds.get("hf_buckets") or {}
        s3_creds = all_creds.get("s3_compatible") or {}
        tg_creds = all_creds.get("telegram") or all_creds.get("s3_hf_telegram") or svc_creds

        has_hf = bool(hf_creds.get("bucket") and hf_creds.get("accessKeyId") and hf_creds.get("secretAccessKey"))
        has_s3 = bool(s3_creds.get("endpoint") and s3_creds.get("bucket") and s3_creds.get("accessKeyId") and s3_creds.get("secretAccessKey"))

        cdn_url = ""
        storage_name = ""
        if norm_service == "hf_telegram" or (norm_service == "s3_hf_telegram" and has_hf):
            if not has_hf:
                raise ValueError("Missing Hugging Face Bucket Name, Access Key ID, or Secret Key in Settings.")
            cdn_url = upload_hf_bucket(file_path, file_name, hf_creds)
            storage_name = "Hugging Face Direct CDN"
        elif norm_service == "s3_telegram" or (norm_service == "s3_hf_telegram" and has_s3):
            if not has_s3:
                raise ValueError("Missing AWS/S3 Endpoint, Bucket, Access Key ID, or Secret Key in Settings.")
            cdn_url = upload_s3_compatible(file_path, file_name, s3_creds)
            storage_name = "AWS / S3 Direct CDN"
        else:
            raise ValueError("Please configure Hugging Face or S3/R2 storage credentials in Settings for S3/HF + Telegram upload.")

        # Step 2: Upload the EXACT VIDEO FILE to Telegram!
        tg_link = ""
        if tg_creds.get("botToken") and tg_creds.get("chatId"):
            print("[*] Uploading exact media file to Telegram channel...", flush=True)
            caption_extra = f"🔗 Direct CDN Mirror: {cdn_url}"
            tg_link = upload_telegram(file_path, file_name, tg_creds, caption_extra=caption_extra)
            print(f"[+] Exact media file uploaded to Telegram: {tg_link}")

        combined_res = [
            {"service": storage_name, "url": cdn_url},
            {"service": "Telegram Document", "url": tg_link or "File uploaded to Telegram"}
        ]
        if on_link_added:
            on_link_added(combined_res, norm_service)
        return combined_res
    elif norm_service == "all" or norm_service == "custom" or "," in norm_service or "," in (service or ""):
        # Multi-host upload - either "all", custom checkboxes, or comma-separated list
        raw_service_str = service if ("," in (service or "")) else norm_service
        if "," in raw_service_str:
            services = [normalize_service(s.strip()) for s in raw_service_str.split(",") if s.strip()]
        elif norm_service == "custom":
            custom_list = all_creds.get("customList") or ["gofile.io", "buzzheavier.com"]
            if isinstance(custom_list, str):
                custom_list = [s.strip() for s in custom_list.split(",") if s.strip()]
            services = [normalize_service(s) for s in custom_list]
        else:
            services = ["gofile.io", "buzzheavier.com", "fuckingfast.co", "storage.to", "catbox.moe"]

            # Include Pixeldrain if API key is configured
            px_creds = get_service_creds(all_creds, "pixeldrain.com")
            if (
                px_creds.get("apiKey")
                or px_creds.get("api_key")
                or all_creds.get("apiKey")
                or (isinstance(all_creds.get("pixeldrain.com"), dict) and all_creds["pixeldrain.com"].get("apiKey"))
                or (isinstance(all_creds.get("pixeldrain"), dict) and all_creds["pixeldrain"].get("apiKey"))
            ):
                services.append("pixeldrain.com")

            # Include Telegram if Bot Token and Chat ID are configured
            tg_creds = get_service_creds(all_creds, "telegram")
            if (
                (tg_creds.get("botToken") and tg_creds.get("chatId"))
                or (isinstance(all_creds.get("telegram"), dict) and all_creds["telegram"].get("botToken"))
            ):
                services.append("telegram")

            # Include S3 Compatible if endpoint and bucket are configured
            s3_creds = get_service_creds(all_creds, "s3_compatible")
            if (
                (s3_creds.get("endpoint") and s3_creds.get("bucket"))
                or (isinstance(all_creds.get("s3_compatible"), dict) and all_creds["s3_compatible"].get("bucket"))
            ):
                services.append("s3_compatible")

            # Include Hugging Face if bucket is configured
            hf_creds = get_service_creds(all_creds, "hf_buckets")
            if (
                (hf_creds.get("bucket") and (hf_creds.get("accessKeyId") or hf_creds.get("token")))
                or (isinstance(all_creds.get("hf_buckets"), dict) and all_creds["hf_buckets"].get("bucket"))
            ):
                services.append("hf_buckets")

        # Deduplicate while preserving order
        unique_services = []
        for s in services:
            if s and s not in unique_services:
                unique_services.append(s)
        services = unique_services

        print(f"[*] Multi-host batch upload queue ({len(services)} hosts): {', '.join(services)}", flush=True)

        links = []
        errors = []
        for s in services:
            try:
                res = execute_upload(s, file_path, file_name, all_creds, on_link_added=on_link_added)
                if isinstance(res, list):
                    links.extend(res)
                    if on_link_added:
                        on_link_added(links, s)
                elif res and (str(res).startswith("http") or "Telegram" in str(res)):
                    links.append({"service": s, "url": str(res)})
                    if on_link_added:
                        on_link_added(links, s)
            except Exception as e:
                errors.append(f"{s}: {e}")
                print(f"[!] Error uploading to {s}: {e}", flush=True)
        if not links:
            raise RuntimeError(f"All hosts failed in multi-upload: {'; '.join(errors)}")
        return links
    else:
        raise ValueError(f"Unsupported upload service: {service}")

# ─── Main Orchestrator ─────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="FetchStream Server-Side Stream Downloader & Uploader")
    parser.add_argument("--job-id", required=True, help="Job identifier")
    parser.add_argument("--media-url", required=True, help="Stream or File URL")
    parser.add_argument("--headers-json", default="{}", help="Captured request headers JSON")
    parser.add_argument("--file-name", default="media.mp4", help="Output file name")
    parser.add_argument("--type", default="hls", help="hls or direct")
    parser.add_argument("--format", default="mp4", help="Output format (mp4 or mp3)")
    parser.add_argument("--service", default="gofile.io", help="Target upload service")
    parser.add_argument("--credentials-json", default="{}", help="Service credentials JSON")
    parser.add_argument("--callback-url", default="", help="Cloudflare Pages callback URL")
    parser.add_argument("--proxy-url", default="", help="Cloudflare Pages stream proxy URL")
    parser.add_argument("--use-fallback", default="true", help="Enable Cloudflare fallback proxy")
    parser.add_argument("--threads", default="8", help="Number of parallel download threads (2 to 24)")

    args = parser.parse_args()

    job_id = args.job_id
    media_url = args.media_url
    file_name = args.file_name
    media_type = args.type.lower()
    service = args.service
    callback_url = args.callback_url
    proxy_url = args.proxy_url
    use_fallback = str(args.use_fallback).lower() in ["true", "1", "yes"]

    try:
        threads = max(2, min(int(args.threads or 8), 24))
    except Exception:
        threads = 8

    global _global_callback_url, _global_job_id
    _global_callback_url = callback_url
    _global_job_id = job_id

    try:
        headers_dict = json.loads(args.headers_json) if args.headers_json else {}
    except Exception:
        headers_dict = {}

    try:
        creds_dict = json.loads(args.credentials_json) if args.credentials_json else {}
    except Exception:
        creds_dict = {}

    output_path = os.path.abspath(f"temp_{job_id}_{file_name}")

    print(f"=== FetchStream Server-Side Runner Starting ===")
    print(f"Job ID: {job_id}")
    print(f"File: {file_name}")
    print(f"Type: {media_type}")
    print(f"Destination: {service}")
    print(f"Parallel Threads: {threads}")
    print(f"Fallback Proxy Configured: {bool(proxy_url and use_fallback)}")
    clean_keys = list(sanitize_headers(headers_dict).keys())
    print(f"Forwarded Headers: {', '.join(clean_keys) if clean_keys else 'None'}")

    send_callback(callback_url, job_id, "RUNNING", stage="STARTING", progress=10, file_name=file_name, service=service)

    try:
        # Step 1: Download & Transmux (0 bytes on user device)
        download_media(media_url, headers_dict, output_path, callback_url, job_id, proxy_url=proxy_url, use_fallback=use_fallback, threads=threads)

        if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
            raise RuntimeError("Downloaded media file is empty or missing.")

        file_size = os.path.getsize(output_path)
        size_mb = file_size / (1024 * 1024)
        print(f"[+] Media preparation complete! Final size: {size_mb:.2f} MB")

        # Step 2: Upload directly to cloud host
        send_callback(callback_url, job_id, "RUNNING", stage="UPLOADING", progress=75, speed=f"Starting upload to {service}...", file_size=file_size)

        def on_link_added(current_links, just_uploaded_svc):
            latest_url = current_links[-1]["url"] if current_links else ""
            num_links = len(current_links)
            intermediate_prog = min(98, 75 + int(num_links * 3))
            print(f"[+] Real-time multi-host update: Uploaded to {just_uploaded_svc} ({num_links} hosts ready): {latest_url}", flush=True)
            send_callback(
                callback_url,
                job_id,
                "RUNNING",
                stage="UPLOADING",
                progress=intermediate_prog,
                speed=f"Uploaded to {just_uploaded_svc} ({num_links} ready)",
                url=latest_url,
                links=list(current_links),
                service=service,
                file_name=file_name,
                file_size=file_size
            )

        result = execute_upload(service, output_path, file_name, creds_dict, on_link_added=on_link_added)

        final_url = ""
        multi_links = []

        if isinstance(result, list):
            multi_links = result
            final_url = result[0]["url"] if len(result) > 0 else ""
        else:
            final_url = str(result).strip()
            if final_url:
                multi_links = [{"service": service, "url": final_url}]

        print(f"[+] Upload successful! Generated URL: {final_url}")
        send_callback(
            callback_url,
            job_id,
            "COMPLETED",
            stage="COMPLETED",
            progress=100,
            speed="Done",
            url=final_url,
            links=multi_links,
            service=service,
            file_name=file_name,
            file_size=file_size
        )

        # Cleanup
        try:
            os.remove(output_path)
        except Exception:
            pass

        print("=== Runner Completed Successfully ===")

    except Exception as err:
        err_msg = str(err)
        print(f"[ERROR] Task failed: {err_msg}", file=sys.stderr)
        send_callback(callback_url, job_id, "FAILED", stage="FAILED", progress=0, speed=f"Failed: {err_msg}", error=err_msg, service=service, file_name=file_name)
        try:
            if os.path.exists(output_path):
                os.remove(output_path)
        except Exception:
            pass
        sys.exit(1)

if __name__ == "__main__":
    main()

