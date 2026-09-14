/**
 * Cloudflare Pages Function: /api/server-status
 * 
 * Handles GET requests to check the real-time status of a Server-Side Upload job.
 * Supports Cloudflare KV and automatic CI/CD pipelines run status inspection.
 */

export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Max-Age": "86400"
        }
    });
}

export async function onRequestGet(context) {
    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Content-Type": "application/json",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0"
    };

    try {
        const { request, env } = context;
        const url = new URL(request.url);
        const jobId = url.searchParams.get("jobId");
        const clientGhRepo = url.searchParams.get("githubRepo");
        const clientGhToken = url.searchParams.get("githubToken");

        // API Key Protection (if configured in Cloudflare Pages environment variables)
        const expectedApiKey = (env?.API_KEY || "").trim();
        if (expectedApiKey) {
            const authHeader = request.headers.get("Authorization") || "";
            const xApiKey = request.headers.get("X-API-Key") || "";
            const queryKey = url.searchParams.get("apiKey") || "";
            let clientToken = (xApiKey || queryKey).trim();
            if (!clientToken && authHeader) {
                const parts = authHeader.trim().split(/\s+/);
                clientToken = (parts.length === 2 && parts[0].toLowerCase() === "bearer") ? parts[1] : authHeader.trim();
            }
            if (clientToken !== expectedApiKey) {
                return new Response(JSON.stringify({ error: "Unauthorized: Invalid or missing API key." }), {
                    status: 401,
                    headers: corsHeaders
                });
            }
        }

        if (!jobId) {
            return new Response(JSON.stringify({ error: "Missing 'jobId' query parameter." }), {
                status: 400,
                headers: corsHeaders
            });
        }

        // 1. Check Cloudflare KV if bound
        if (env?.RELAY_KV) {
            const rawData = await env.RELAY_KV.get(`job:${jobId}`);
            if (rawData) {
                const job = JSON.parse(rawData);
                return new Response(JSON.stringify(job), {
                    status: 200,
                    headers: corsHeaders
                });
            }
        }

        // 2. Direct CI/CD pipelines Run Status Fallback
        const githubToken = (env?.GITHUB_TOKEN || clientGhToken || "").trim();
        const githubRepo = (env?.GITHUB_REPO || clientGhRepo || "").trim();

        if (githubToken && githubRepo) {
            try {
                const ghRes = await fetch(`https://api.github.com/repos/${githubRepo}/actions/runs?event=repository_dispatch&per_page=5`, {
                    headers: {
                        "Accept": "application/vnd.github.v3+json",
                        "Authorization": `Bearer ${githubToken}`,
                        "User-Agent": "FetchStream-Server-Status-Checker"
                    }
                });

                if (ghRes.ok) {
                    const ghData = await ghRes.json();
                    const latestRun = ghData.workflow_runs?.[0];

                    if (latestRun) {
                        if (latestRun.status === "completed") {
                            if (latestRun.conclusion === "success") {
                                return new Response(JSON.stringify({
                                    jobId: jobId,
                                    status: "RUNNING",
                                    stage: "FINISHING_UP",
                                    progress: 99,
                                    message: "Runner finished. Waiting for Cloudflare KV URL propagation (can take 10-60s)..."
                                }), {
                                    status: 200,
                                    headers: corsHeaders
                                });
                            } else {
                                return new Response(JSON.stringify({
                                    jobId: jobId,
                                    status: "FAILED",
                                    stage: "FAILED",
                                    error: `GitHub Actions runner ended with: ${latestRun.conclusion}`
                                }), {
                                    status: 200,
                                    headers: corsHeaders
                                });
                            }
                        } else if (latestRun.status === "in_progress") {
                            return new Response(JSON.stringify({
                                jobId: jobId,
                                status: "RUNNING",
                                stage: "PROCESSING",
                                progress: 50,
                                message: "Stream downloading / ffmpeg processing in progress..."
                            }), {
                                status: 200,
                                headers: corsHeaders
                            });
                        } else if (latestRun.status === "queued") {
                            return new Response(JSON.stringify({
                                jobId: jobId,
                                status: "QUEUED",
                                stage: "STARTING_RUNNER",
                                progress: 10,
                                message: "GitHub Actions runner queued..."
                            }), {
                                status: 200,
                                headers: corsHeaders
                            });
                        }
                    }
                }
            } catch (ghErr) {
                // Continue to default fallback response
            }
        }

        // 3. Default Fallback
        return new Response(JSON.stringify({
            jobId: jobId,
            status: "QUEUED",
            stage: "QUEUED",
            progress: 10,
            message: "Job is queued in GitHub Actions runner."
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
