/**
 * FetchStream Service Limits & Pre-Flight Sizing Engine
 * Evaluates file/stream sizes against destination host limits
 * and provides intelligent warnings and skip recommendations.
 */
const ServiceLimits = (() => {
    const LIMITS = {
        'catbox.moe': {
            name: 'Catbox',
            maxBytes: 200 * 1024 * 1024,
            limitStr: '200 MB',
            warning: 'Catbox strictly limits file uploads to 200 MB. Larger files will be rejected by the server.'
        },
        'catbox': {
            name: 'Catbox',
            maxBytes: 200 * 1024 * 1024,
            limitStr: '200 MB',
            warning: 'Catbox strictly limits file uploads to 200 MB. Larger files will be rejected by the server.'
        },
        'litterbox': {
            name: 'Litterbox',
            maxBytes: 1024 * 1024 * 1024,
            limitStr: '1 GB',
            warning: 'Litterbox max file size limit is 1 GB (1024 MB).'
        },
        'telegram': {
            name: 'Telegram Bot',
            maxBytesStandard: 50 * 1024 * 1024,
            maxBytesRunner: 2000 * 1024 * 1024,
            limitStrStandard: '50 MB',
            limitStrRunner: '2 GB',
            check: (bytes, options, isServerUpload, meta = {}) => {
                const creds = options?.upload?.credentials?.telegram || options?.credentials || {};
                const hasRunnerUrl = Boolean((options?.serverUpload?.relayUrl || '').trim());
                const hasBotServerUrl = Boolean((creds?.serverUrl || '').trim());
                const hasServer = isServerUpload ? true : (hasRunnerUrl || hasBotServerUrl);

                if (!hasServer) {
                    if (bytes > 50 * 1024 * 1024) {
                        return {
                            flagged: true,
                            limitStr: '50 MB',
                            reason: `Standard Telegram Bot API strictly limits uploads to 50 MB. This file/stream (~${formatBytes(bytes)}) exceeds the 50 MB limit and will fail after downloading. To upload files up to 2 GB, configure a Remote Server URL in Server Upload settings or use Server Upload.`
                        };
                    }
                    if (meta?.isHls || (bytes <= 0 && meta?.url && meta.url.toLowerCase().includes('.m3u8'))) {
                        return {
                            flagged: true,
                            limitStr: '50 MB',
                            reason: 'Standard Telegram Bot API strictly limits uploads to 50 MB. Video streams (.m3u8) will almost certainly exceed 50 MB and fail after downloading. To upload files up to 2 GB, configure a Remote Server URL in Server Upload settings, or select another host (e.g. GoFile, Buzzheavier).'
                        };
                    }
                }
                if (bytes > 2000 * 1024 * 1024) {
                    return {
                        flagged: true,
                        limitStr: '2 GB',
                        reason: 'Telegram has a hard ceiling of 2,000 MB (2 GB) for all bot uploads.'
                    };
                }
                return { flagged: false };
            }
        },
        'fuckingfast.co': {
            name: 'FFast',
            maxBytes: 5 * 1024 * 1024 * 1024,
            limitStr: '5 GB',
            warning: 'FFast anonymous uploads may drop or fail on files exceeding ~5 GB.'
        },
        'fuckingfast': {
            name: 'FFast',
            maxBytes: 5 * 1024 * 1024 * 1024,
            limitStr: '5 GB',
            warning: 'FFast anonymous uploads may drop or fail on files exceeding ~5 GB.'
        },
        'storage.to': {
            name: 'Storage.to',
            maxBytes: 5 * 1024 * 1024 * 1024,
            limitStr: '5 GB',
            warning: 'Storage.to free upload limit is 5 GB.'
        },
        'storage': {
            name: 'Storage.to',
            maxBytes: 5 * 1024 * 1024 * 1024,
            limitStr: '5 GB',
            warning: 'Storage.to free upload limit is 5 GB.'
        },
        'pixeldrain.com': {
            name: 'Pixeldrain',
            maxBytes: 10 * 1024 * 1024 * 1024,
            limitStr: '10 GB',
            warning: 'Pixeldrain anonymous uploads are capped at 10 GB per file.'
        },
        'pixeldrain': {
            name: 'Pixeldrain',
            maxBytes: 10 * 1024 * 1024 * 1024,
            limitStr: '10 GB',
            warning: 'Pixeldrain anonymous uploads are capped at 10 GB per file.'
        },
        'buzzheavier.com': {
            name: 'Buzzheavier',
            maxBytes: null,
            limitStr: 'Unrestricted (50 GB+)',
            warning: null
        },
        'buzzheavier': {
            name: 'Buzzheavier',
            maxBytes: null,
            limitStr: 'Unrestricted (50 GB+)',
            warning: null
        },
        'gofile.io': {
            name: 'GoFile',
            maxBytes: null,
            limitStr: 'Unrestricted',
            warning: null
        },
        'gofile': {
            name: 'GoFile',
            maxBytes: null,
            limitStr: 'Unrestricted',
            warning: null
        },
        's3_compatible': {
            name: 'S3-Compatible Storage',
            maxBytes: null,
            limitStr: 'Plan Quota Dependent',
            warning: null
        },
        'hf_buckets': {
            name: 'Hugging Face Buckets',
            maxBytes: null,
            limitStr: 'Plan Quota Dependent',
            warning: null
        }
    };

    const RUNNER_STORAGE_THRESHOLD = 10 * 1024 * 1024 * 1024; // 10 GB

    function formatBytes(bytes, decimals = 1) {
        if (!bytes || bytes <= 0) return '0 B';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }

    function parseServiceList(serviceInput, credentials = {}) {
        if (Array.isArray(serviceInput)) return serviceInput;
        if (!serviceInput || typeof serviceInput !== 'string') return [];
        if (serviceInput === 'all') {
            const list = ['gofile.io', 'buzzheavier.com', 'fuckingfast.co', 'storage.to', 'catbox.moe'];
            if (credentials['pixeldrain.com']?.apiKey || credentials['pixeldrain']?.apiKey || credentials?.apiKey) {
                list.push('pixeldrain.com');
            }
            if (credentials['telegram']?.botToken && credentials['telegram']?.chatId) {
                list.push('telegram');
            }
            if (credentials['s3_compatible']?.endpoint && credentials['s3_compatible']?.bucket) {
                list.push('s3_compatible');
            }
            if (credentials['hf_buckets']?.bucket && (credentials['hf_buckets']?.accessKeyId || credentials['hf_buckets']?.token)) {
                list.push('hf_buckets');
            }
            return list;
        }
        if (serviceInput.includes(',')) {
            return serviceInput.split(',').map(s => s.trim()).filter(Boolean);
        }
        return [serviceInput.trim()];
    }

    function check(sizeBytes, serviceInput, options = {}, isServerUpload = false, meta = {}) {
        const creds = options?.upload?.credentials || options?.credentials || {};
        const services = parseServiceList(serviceInput, creds);
        const problematic = [];
        const safe = [];

        services.forEach(s => {
            const key = s.toLowerCase().trim();
            const def = LIMITS[key];
            const serviceName = def ? def.name : s;

            if (key === 'telegram') {
                const tgRes = LIMITS.telegram.check(sizeBytes, options, isServerUpload, meta);
                if (tgRes.flagged) {
                    problematic.push({
                        service: s,
                        name: serviceName,
                        limitStr: tgRes.limitStr,
                        reason: tgRes.reason
                    });
                } else {
                    safe.push({ service: s, name: serviceName });
                }
            } else if (def && def.maxBytes && sizeBytes > def.maxBytes) {
                problematic.push({
                    service: s,
                    name: serviceName,
                    limitStr: def.limitStr,
                    reason: def.warning || `${serviceName} file size limit is ${def.limitStr}.`
                });
            } else {
                safe.push({ service: s, name: serviceName });
            }
        });

        const runnerWarning = isServerUpload && sizeBytes >= RUNNER_STORAGE_THRESHOLD;

        let displaySize = 'Unknown size';
        if (sizeBytes > 0) {
            displaySize = formatBytes(sizeBytes);
            if (meta?.duration && meta.duration > 0) {
                const mins = Math.round(meta.duration / 60);
                displaySize += ` (~${mins} min stream)`;
            }
        } else if (meta?.isHls) {
            displaySize = 'Unknown (HLS Video Stream)';
        }

        return {
            hasWarnings: problematic.length > 0 || runnerWarning,
            problematic,
            safe,
            runnerWarning,
            canSkipIncompatible: problematic.length > 0 && safe.length > 0,
            formattedSize: displaySize
        };
    }

    function estimateStreamSize(details) {
        if (!details) return 0;
        if (details.fileSize && Number(details.fileSize) > 0) {
            return Number(details.fileSize);
        }
        if (details.contentLength && Number(details.contentLength) > 0) {
            return Number(details.contentLength);
        }
        if (details.size && Number(details.size) > 0) {
            return Number(details.size);
        }
        // Check HLS bitrate & duration
        const duration = Number(details.duration || details.estimatedDuration || 0);
        const bandwidth = Number(details.bandwidth || details.bitrate || 0);
        if (duration > 0 && bandwidth > 0) {
            return Math.round((bandwidth / 8) * duration);
        }
        if (details.estimatedSize && Number(details.estimatedSize) > 0) {
            return Number(details.estimatedSize);
        }
        return 0;
    }

    /**
     * Quickly probes an HLS manifest (.m3u8) to compute stream duration,
     * variant bitrate, segment count, and estimated total bytes.
     */
    async function probeStreamSize(details) {
        if (!details) return 0;
        const staticSize = estimateStreamSize(details);
        if (staticSize > 0) return staticSize;

        const targetUrl = details.selectedVariantUrl || details.url;
        const isHls = details.type === 'hls' || 
                      (targetUrl && targetUrl.toLowerCase().includes('.m3u8')) || 
                      (details.format && details.format.toLowerCase() === 'm3u8');

        if (!isHls || !targetUrl || !targetUrl.startsWith('http')) {
            return 0;
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2500);
            const reqHeaders = details.headers || {};
            const res = await fetch(targetUrl, { headers: reqHeaders, signal: controller.signal });
            clearTimeout(timeoutId);

            if (!res.ok) return 0;
            const text = await res.text();
            if (!text.includes('#EXTM3U')) return 0;

            let totalDuration = 0;
            let detectedBandwidth = 0;
            let segCount = 0;

            if (text.includes('#EXT-X-STREAM-INF')) {
                // Master playlist - extract variant with highest/relevant bandwidth
                const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                let bestVariantUrl = null;
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                        const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/i);
                        const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
                        if (bw > detectedBandwidth) {
                            detectedBandwidth = bw;
                            if (lines[i + 1] && !lines[i + 1].startsWith('#')) {
                                bestVariantUrl = lines[i + 1];
                            }
                        }
                    }
                }

                if (bestVariantUrl) {
                    try {
                        const targetMediaUrl = bestVariantUrl.startsWith('http') ? bestVariantUrl : new URL(bestVariantUrl, targetUrl).href;
                        const subCtrl = new AbortController();
                        const subTimeout = setTimeout(() => subCtrl.abort(), 2000);
                        const subRes = await fetch(targetMediaUrl, { headers: reqHeaders, signal: subCtrl.signal });
                        clearTimeout(subTimeout);
                        if (subRes.ok) {
                            const subText = await subRes.text();
                            const subMatches = subText.matchAll(/#EXTINF:([\d.]+)/g);
                            for (const m of subMatches) {
                                totalDuration += parseFloat(m[1]) || 0;
                                segCount++;
                            }
                        }
                    } catch (subErr) {}
                }
            } else {
                // Media playlist directly
                const matches = text.matchAll(/#EXTINF:([\d.]+)/g);
                for (const m of matches) {
                    totalDuration += parseFloat(m[1]) || 0;
                    segCount++;
                }
            }

            if (totalDuration > 0) {
                details.estimatedDuration = totalDuration;
                // Typical bitrate fallback: ~2.0 Mbps (250 KB/s) if not detected
                const bytesPerSec = detectedBandwidth > 0 ? (detectedBandwidth / 8) : (250 * 1024);
                const calculated = Math.round(bytesPerSec * totalDuration);
                details.estimatedSize = calculated;
                details.segmentCount = segCount;
                return calculated;
            } else if (segCount > 0) {
                const calculated = Math.round(segCount * 1.8 * 1024 * 1024); // ~1.8 MB / seg
                details.estimatedSize = calculated;
                details.segmentCount = segCount;
                return calculated;
            }
        } catch (err) {
            // Manifest fetch failed or timed out; will fall back to meta indicators
        }
        return 0;
    }

    return {
        LIMITS,
        RUNNER_STORAGE_THRESHOLD,
        formatBytes,
        parseServiceList,
        check,
        estimateStreamSize,
        probeStreamSize
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = ServiceLimits;
}

