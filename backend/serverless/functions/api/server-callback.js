/**
 * Cloudflare Pages Function: /api/server-callback
 * 
 * Receives webhook callbacks from CI/CD pipelines runner to update job status,
 * progress, stage (DOWNLOADING, CONVERTING, UPLOADING, COMPLETED), and resulting URLs.
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

        const {
            jobId,
            status,
            stage,
            progress,
            speed,
            url,
            links,
            service,
            fileName,
            fileSize,
            error
        } = payload;

        if (!jobId || !status) {
            return new Response(JSON.stringify({ error: "Missing 'jobId' or 'status'." }), {
                status: 400,
                headers: corsHeaders
            });
        }

        if (env?.RELAY_KV) {
            let existing = {};
            try {
                const prev = await env.RELAY_KV.get(`job:${jobId}`);
                if (prev) existing = JSON.parse(prev);
            } catch (e) {}

            const updated = {
                ...existing,
                jobId,
                status,
                stage: stage || existing.stage || status,
                progress: progress !== undefined ? progress : existing.progress,
                speed: speed !== undefined ? speed : existing.speed,
                url: url || existing.url || "",
                links: links || existing.links || [],
                service: service || existing.service,
                fileName: fileName || existing.fileName,
                fileSize: fileSize || existing.fileSize,
                error: error || existing.error || null,
                updatedAt: Date.now()
            };

            await env.RELAY_KV.put(`job:${jobId}`, JSON.stringify(updated), {
                expirationTtl: 7200 // 2 hours
            });
        }

        return new Response(JSON.stringify({ success: true, jobId, status }), {
            status: 200,
            headers: corsHeaders
        });

    } catch (err) {
        return new Response(JSON.stringify({ error: `Server error: ${err.message || err}` }), {
            status: 500,
            headers: corsHeaders
        });
    }
}
