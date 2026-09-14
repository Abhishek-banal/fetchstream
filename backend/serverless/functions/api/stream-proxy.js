/**
 * Cloudflare Pages Function: /api/stream-proxy
 * 
 * Acts as an edge proxy to fetch media streams, playlists (.m3u8), AES keys,
 * and chunks (.ts/.m4s) from origin CDNs using Cloudflare's edge network
 * when remote runner datacenter IP ranges are restricted (HTTP 403 / Forbidden).
 */

export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Max-Age": "86400"
        }
    });
}

export async function onRequest(context) {
    const { request } = context;

    if (request.method === "OPTIONS") {
        return onRequestOptions();
    }

    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "*"
    };

    try {
        const { request, env } = context;
        const urlObj = new URL(request.url);

        // API Key Protection (if configured in Cloudflare Pages environment variables)
        const expectedApiKey = (env?.API_KEY || "").trim();
        if (expectedApiKey) {
            const authHeader = request.headers.get("Authorization") || "";
            const xApiKey = request.headers.get("X-API-Key") || "";
            const queryKey = urlObj.searchParams.get("apiKey") || "";
            let clientToken = (xApiKey || queryKey).trim();
            if (!clientToken && authHeader) {
                const parts = authHeader.trim().split(/\s+/);
                clientToken = (parts.length === 2 && parts[0].toLowerCase() === "bearer") ? parts[1] : authHeader.trim();
            }
            if (clientToken !== expectedApiKey) {
                return new Response(JSON.stringify({ error: "Unauthorized: Invalid or missing API key." }), {
                    status: 401,
                    headers: { ...corsHeaders, "Content-Type": "application/json" }
                });
            }
        }

        let targetUrl = "";
        let customHeaders = {};

        if (request.method === "POST") {
            const body = await request.json().catch(() => ({}));
            targetUrl = body.url || "";
            customHeaders = body.headers || {};
        } else {
            targetUrl = urlObj.searchParams.get("url") || "";

            // Check for forwarded headers
            const cookie = request.headers.get("x-fs-cookie");
            if (cookie) customHeaders["Cookie"] = cookie;
            const referer = request.headers.get("x-fs-referer");
            if (referer) customHeaders["Referer"] = referer;
            const auth = request.headers.get("x-fs-authorization");
            if (auth) customHeaders["Authorization"] = auth;
            const ua = request.headers.get("x-fs-user-agent");
            if (ua) customHeaders["User-Agent"] = ua;
        }

        if (!targetUrl || !targetUrl.startsWith("http")) {
            return new Response(JSON.stringify({ error: "Missing or invalid 'url' parameter." }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        // Prepare outbound fetch headers
        const fetchHeaders = new Headers();
        fetchHeaders.set("User-Agent", customHeaders["User-Agent"] || customHeaders["user-agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36");

        const BLOCKED_HEADERS = new Set([
            "host",
            "connection",
            "content-length",
            "transfer-encoding",
            "accept-encoding",
            "access-control-request-method",
            "access-control-request-headers",
            "sec-fetch-mode",
            "sec-fetch-site",
            "sec-fetch-dest",
            "sec-fetch-user",
            "priority"
        ]);

        for (const [k, v] of Object.entries(customHeaders)) {
            const lowerK = k.toLowerCase().trim();
            if (!v || BLOCKED_HEADERS.has(lowerK) || lowerK.startsWith("sec-ch-") || lowerK.startsWith("access-control-")) {
                continue;
            }
            if (lowerK === "origin" && (String(v).includes("chrome-extension://") || String(v).includes("pages.dev"))) {
                continue;
            }
            try {
                fetchHeaders.set(k, String(v).trim());
            } catch (e) {}
        }

        // Fetch through Cloudflare edge network
        const originRes = await fetch(targetUrl, {
            method: "GET",
            headers: fetchHeaders,
            redirect: "follow"
        });

        const responseHeaders = new Headers(originRes.headers);
        responseHeaders.set("Access-Control-Allow-Origin", "*");
        responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        responseHeaders.set("Access-Control-Allow-Headers", "*");
        responseHeaders.set("Access-Control-Expose-Headers", "*");
        responseHeaders.set("x-final-url", originRes.url || targetUrl);
        responseHeaders.delete("content-encoding");
        responseHeaders.delete("content-length");

        return new Response(originRes.body, {
            status: originRes.status,
            statusText: originRes.statusText,
            headers: responseHeaders
        });

    } catch (err) {
        return new Response(JSON.stringify({ error: `Proxy fetch error: ${err.message || err}` }), {
            status: 502,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }
}
