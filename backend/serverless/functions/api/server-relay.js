/**
 * Cloudflare Pages Function: /api/server-relay
 * 
 * Handles POST requests to dispatch the universal server-side stream/file downloading
 * and multi-host uploading workflow via CI/CD pipelines.
 */

export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Max-Age": "86400"
        }
    });
}

export async function onRequestPost(context) {
    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Content-Type": "application/json",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0"
    };

    try {
        const { request, env } = context;
        const payload = await request.json().catch(() => ({}));

        // API Key Protection (if configured in Cloudflare Pages environment variables)
        const expectedApiKey = (env?.API_KEY || "").trim();
        if (expectedApiKey) {
            const authHeader = request.headers.get("Authorization") || "";
            const xApiKey = request.headers.get("X-API-Key") || "";
            let clientToken = xApiKey.trim();
            if (!clientToken && authHeader) {
                const parts = authHeader.trim().split(/\s+/);
                clientToken = (parts.length === 2 && parts[0].toLowerCase() === "bearer") ? parts[1] : authHeader.trim();
            }
            if (!clientToken && payload.apiKey) {
                clientToken = String(payload.apiKey).trim();
            }
            if (clientToken !== expectedApiKey) {
                return new Response(JSON.stringify({
                    error: "Unauthorized: Invalid or missing API Key. Please enter your Server API Key in Extension Settings."
                }), {
                    status: 401,
                    headers: corsHeaders
                });
            }
        }

        const {
            mediaUrl,
            headers = {},
            fileName,
            type = "hls",
            format = "mp4",
            service = "gofile.io",
            credentials = {},
            useFallbackProxy = true,
            githubToken: clientGithubToken,
            githubRepo: clientGithubRepo
        } = payload;

        const targetMediaUrl = (payload.mediaUrl || payload.cdnUrl || "").trim();
        if (!targetMediaUrl) {
            return new Response(JSON.stringify({ error: "Missing required 'mediaUrl' parameter." }), {
                status: 400,
                headers: corsHeaders
            });
        }

        const mergedCreds = { ...(payload.credentials || {}) };
        if (payload.chatId) mergedCreds.chatId = payload.chatId;
        if (payload.botToken) mergedCreds.botToken = payload.botToken;
        if (payload.caption) mergedCreds.caption = payload.caption;
        if (payload.description) mergedCreds.description = payload.description;

        // GitHub Repository and Token Resolution (from Cloudflare env or client payload)
        const githubToken = (env?.GITHUB_TOKEN || clientGithubToken || "").trim();
        const githubRepo = (env?.GITHUB_REPO || clientGithubRepo || "").trim();

        if (!githubToken) {
            return new Response(JSON.stringify({
                error: "GitHub Personal Access Token not configured. Please add GITHUB_TOKEN to Cloudflare Pages Environment Variables or pass it in Extension Settings."
            }), {
                status: 401,
                headers: corsHeaders
            });
        }

        if (!githubRepo) {
            return new Response(JSON.stringify({
                error: "GitHub Repository not configured. Please add GITHUB_REPO (e.g. username/fetchstream) to Cloudflare Pages Environment Variables or Extension Settings."
            }), {
                status: 400,
                headers: corsHeaders
            });
        }

        const jobId = (payload.jobId || payload.id || `srv_relay_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`).trim();
        const origin = new URL(request.url).origin;
        const callbackUrl = expectedApiKey ? `${origin}/api/server-callback?apiKey=${encodeURIComponent(expectedApiKey)}` : `${origin}/api/server-callback`;
        const proxyUrl = expectedApiKey ? `${origin}/api/stream-proxy?apiKey=${encodeURIComponent(expectedApiKey)}` : `${origin}/api/stream-proxy`;

        // Store initial state in Cloudflare KV if bound
        if (env?.RELAY_KV) {
            await env.RELAY_KV.put(`job:${jobId}`, JSON.stringify({
                jobId,
                status: "QUEUED",
                stage: "DISPATCHED",
                progress: 5,
                fileName: fileName || "media.mp4",
                service: service,
                mediaUrl: targetMediaUrl,
                createdAt: Date.now(),
                updatedAt: Date.now()
            }), { expirationTtl: 7200 }); // 2 hours TTL
        }

        // Sanitize headers to remove CORS preflight and restricted browser headers
        const sanitizedHeaders = {};
        const BLOCKED_HEADERS = new Set([
            "host", "connection", "content-length", "transfer-encoding",
            "accept-encoding", "access-control-request-method", "access-control-request-headers",
            "sec-fetch-mode", "sec-fetch-site", "sec-fetch-dest", "sec-fetch-user", "priority"
        ]);

        if (headers && typeof headers === "object") {
            for (const [k, v] of Object.entries(headers)) {
                const lowerK = k.toLowerCase().trim();
                if (!v || BLOCKED_HEADERS.has(lowerK) || lowerK.startsWith("sec-ch-") || lowerK.startsWith("access-control-")) {
                    continue;
                }
                if (lowerK === "origin" && (String(v).includes("chrome-extension://") || String(v).includes("pages.dev"))) {
                    continue;
                }
                sanitizedHeaders[k] = String(v).trim();
            }
        }

        // Trigger CI/CD pipelines repository_dispatch event
        const dispatchUrl = `https://api.github.com/repos/${githubRepo}/dispatches`;
        const dispatchRes = await fetch(dispatchUrl, {
            method: "POST",
            headers: {
                "Accept": "application/vnd.github.v3+json",
                "Authorization": `Bearer ${githubToken}`,
                "User-Agent": "FetchStream-Server-Relay-Worker",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                event_type: "server_relay",
                client_payload: {
                    jobId: jobId,
                    mediaUrl: targetMediaUrl,
                    headers: sanitizedHeaders,
                    fileName: fileName || "media.mp4",
                    type: type,
                    service: service,
                    threads: Number(payload.threads || payload.concurrency) || 8,
                    credentials: mergedCreds,
                    callbackUrl: callbackUrl,
                    proxyConfig: {
                        url: proxyUrl,
                        useFallback: !!useFallbackProxy
                    }
                }
            })
        });

        if (!dispatchRes.ok) {
            const errText = await dispatchRes.text();
            return new Response(JSON.stringify({
                error: `Failed to trigger GitHub Action (${dispatchRes.status}): ${errText}`
            }), {
                status: dispatchRes.status,
                headers: corsHeaders
            });
        }

        return new Response(JSON.stringify({
            success: true,
            jobId: jobId,
            status: "QUEUED",
            message: "Server-side download and upload job dispatched to CI/CD pipeline successfully."
        }), {
            status: 200,
            headers: corsHeaders
        });

    } catch (err) {
        return new Response(JSON.stringify({
            error: `Server error: ${err.message || err}`
        }), {
            status: 500,
            headers: corsHeaders
        });
    }
}

