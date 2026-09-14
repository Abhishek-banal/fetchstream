/**
 * FetchStream Universal Multi-Service File Uploader
 * Supports: Pixeldrain, GoFile, Buzzheavier, FFast, Storage.to, Catbox,
 *           AWS S3/R2/Backblaze, Hugging Face, Telegram.
 * Coming Soon: MEGA, Dropbox, Google Drive, OneDrive.
 */

class AwsSigV4 {
    static async hmac(key, string) {
        const enc = new TextEncoder();
        const cryptoKey = await crypto.subtle.importKey(
            "raw",
            typeof key === "string" ? enc.encode(key) : key,
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"]
        );
        return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(string)));
    }

    static async sha256Hex(data) {
        const enc = new TextEncoder();
        const buf = typeof data === "string" ? enc.encode(data) : data;
        const hash = await crypto.subtle.digest("SHA-256", buf);
        return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    static hex(bytes) {
        return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    static async getSignatureKey(key, dateStamp, regionName, serviceName) {
        const kDate = await this.hmac("AWS4" + key, dateStamp);
        const kRegion = await this.hmac(kDate, regionName);
        const kService = await this.hmac(kRegion, serviceName);
        return await this.hmac(kService, "aws4_request");
    }

    static async sign({ method, endpoint, bucket, path, region, accessKeyId, secretAccessKey }) {
        const now = new Date();
        const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
        const dateStamp = amzDate.substr(0, 8);

        const cleanEndpoint = endpoint.replace(/\/+$/, '');
        const urlObj = new URL(cleanEndpoint);
        let host = urlObj.host;

        // Path-style: /bucket/path, prepended with any endpoint path
        const basePath = urlObj.pathname === '/' ? '' : urlObj.pathname;
        let canonicalUri = `${basePath}/${bucket}/${path.replace(/^\/+/, '')}`;
        // Encode URI path components safely
        canonicalUri = canonicalUri.split('/').map(segment => encodeURIComponent(decodeURIComponent(segment))).join('/');

        const payloadHash = "UNSIGNED-PAYLOAD";
        const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
        const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

        const canonicalRequest = [
            method,
            canonicalUri,
            "",
            canonicalHeaders,
            signedHeaders,
            payloadHash
        ].join("\n");

        const hashedCanonicalRequest = await this.sha256Hex(canonicalRequest);
        const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
        const stringToSign = [
            "AWS4-HMAC-SHA256",
            amzDate,
            credentialScope,
            hashedCanonicalRequest
        ].join("\n");

        const signingKey = await this.getSignatureKey(secretAccessKey, dateStamp, region, "s3");
        const signature = this.hex(await this.hmac(signingKey, stringToSign));

        const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

        return {
            url: `${urlObj.origin}${canonicalUri}`,
            headers: {
                "Host": host,
                "x-amz-date": amzDate,
                "x-amz-content-sha256": payloadHash,
                "Authorization": authHeader
            }
        };
    }

    static async presign({ method, endpoint, bucket, path, region, accessKeyId, secretAccessKey, expiresIn }) {
        const now = new Date();
        const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
        const dateStamp = amzDate.substr(0, 8);

        const cleanEndpoint = endpoint.replace(/\/+$/, '');
        const urlObj = new URL(cleanEndpoint);
        const host = urlObj.host;

        // Path-style: /bucket/path, prepended with any endpoint path
        const basePath = urlObj.pathname === '/' ? '' : urlObj.pathname;
        let canonicalUri = `${basePath}/${bucket}/${path.replace(/^\/+/, '')}`;
        canonicalUri = canonicalUri.split('/').map(segment => encodeURIComponent(decodeURIComponent(segment))).join('/');

        const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
        const credential = `${accessKeyId}/${credentialScope}`;

        // Query parameters for presigned URL
        const queryParams = new URLSearchParams();
        queryParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
        queryParams.set('X-Amz-Credential', credential);
        queryParams.set('X-Amz-Date', amzDate);
        queryParams.set('X-Amz-Expires', String(expiresIn || 604800));
        queryParams.set('X-Amz-SignedHeaders', 'host');

        // Sort query params for canonical request
        const sortedParams = new URLSearchParams([...queryParams.entries()].sort());
        const canonicalQueryString = sortedParams.toString();

        const canonicalHeaders = `host:${host}\n`;
        const signedHeaders = 'host';
        const payloadHash = 'UNSIGNED-PAYLOAD';

        const canonicalRequest = [
            method || 'GET',
            canonicalUri,
            canonicalQueryString,
            canonicalHeaders,
            signedHeaders,
            payloadHash
        ].join('\n');

        const hashedCanonicalRequest = await this.sha256Hex(canonicalRequest);
        const stringToSign = [
            'AWS4-HMAC-SHA256',
            amzDate,
            credentialScope,
            hashedCanonicalRequest
        ].join('\n');

        const signingKey = await this.getSignatureKey(secretAccessKey, dateStamp, region, 's3');
        const signature = this.hex(await this.hmac(signingKey, stringToSign));

        queryParams.set('X-Amz-Signature', signature);

        return `${urlObj.origin}${canonicalUri}?${queryParams.toString()}`;
    }
}

class FetchStreamUploader {
    static attachAbortSignal(xhr, signal, reject) {
        if (!signal) return false;
        if (signal.aborted) {
            try { xhr.abort(); } catch(e) {}
            reject(new DOMException('Upload aborted', 'AbortError'));
            return true;
        }
        signal.addEventListener('abort', () => {
            try { xhr.abort(); } catch(e) {}
            reject(new DOMException('Upload aborted', 'AbortError'));
        }, { once: true });
        xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));
        return false;
    }

    static resolveMimeType(name, fallbackType) {
        const ext = ((name || '').split('.').pop() || '').toLowerCase();
        const mimeMap = {
            // Images
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            webp: 'image/webp',
            gif: 'image/gif',
            svg: 'image/svg+xml',
            bmp: 'image/bmp',
            ico: 'image/x-icon',
            avif: 'image/avif',
            tiff: 'image/tiff',
            tif: 'image/tiff',

            // Disk Images & System Binaries
            iso: 'application/x-iso9660-image',
            img: 'application/octet-stream',
            bin: 'application/octet-stream',
            dmg: 'application/x-apple-diskimage',
            vmdk: 'application/octet-stream',

            // Documents
            pdf: 'application/pdf',
            doc: 'application/msword',
            docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            xls: 'application/vnd.ms-excel',
            xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            ppt: 'application/vnd.ms-powerpoint',
            pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            txt: 'text/plain',
            csv: 'text/csv',
            json: 'application/json',
            xml: 'application/xml',

            // Archives
            zip: 'application/zip',
            '7z': 'application/x-7z-compressed',
            rar: 'application/vnd.rar',
            tar: 'application/x-tar',
            gz: 'application/gzip',
            bz2: 'application/x-bzip2',
            xz: 'application/x-xz',

            // Audio
            mp3: 'audio/mpeg',
            m4a: 'audio/mp4',
            aac: 'audio/aac',
            wav: 'audio/wav',
            ogg: 'audio/ogg',
            flac: 'audio/flac',
            opus: 'audio/opus',
            weba: 'audio/webm',

            // Video
            mp4: 'video/mp4',
            m4v: 'video/x-m4v',
            webm: 'video/webm',
            mkv: 'video/x-matroska',
            mov: 'video/quicktime',
            avi: 'video/x-msvideo',
            ts: 'video/mp2t'
        };

        if (mimeMap[ext]) return mimeMap[ext];
        if (fallbackType && fallbackType !== 'video/mp4' && fallbackType !== 'application/octet-stream') {
            return fallbackType;
        }
        return 'application/octet-stream';
    }

    /**
     * Entry point for all uploads.
     * @param {Blob|File} file - Media binary
     * @param {string} name - File name
     * @param {Object} uploadConfig - { service: string, credentials: { [service]: object }, signal?: AbortSignal, onLinkGenerated?: Function }
     * @param {Function} onProgress - (bytesUploaded, bytesTotal) => void
     * @returns {Promise<{ url: string, links?: Array }>}
     */
    static async upload(file, name, uploadConfig, onProgress) {
        const service = uploadConfig?.service;
        const vaultCreds = await this.getVaultCreds();
        const allCreds = Object.assign({}, uploadConfig?.credentials || {}, vaultCreds);
        const creds = Object.assign({}, allCreds[service] || allCreds || {}, {
            signal: uploadConfig?.signal,
            _xhrCallback: uploadConfig?._xhrCallback,
            onLinkGenerated: uploadConfig?.onLinkGenerated
        });

        if (uploadConfig?.signal?.aborted) {
            throw new DOMException('Upload aborted', 'AbortError');
        }

        if (!service || service === 'local') {
            throw new Error("No remote upload destination selected.");
        }

        // Custom Multi-Host Selection (comma-separated list of services)
        if (service.includes(',')) {
            const list = service.split(',').map(s => s.trim()).filter(Boolean);
            return await this.uploadToSelected(file, name, list, uploadConfig, onProgress);
        }

        switch (service) {
            // All Services in parallel/sequence
            case 'all':
                return await this.uploadToAll(file, name, uploadConfig, onProgress);

            // Direct / Public Hosts
            case 'pixeldrain.com':
                return await this.uploadPixeldrain(file, name, creds, onProgress);
            case 'gofile.io':
                return await this.uploadGofile(file, name, creds, onProgress);
            case 'buzzheavier.com':
                return await this.uploadBuzzheavier(file, name, creds, onProgress);
            case 'fuckingfast.co':
                return await this.uploadFuckingFast(file, name, creds, onProgress);
            case 'storage.to':
                return await this.uploadStorageTo(file, name, creds, onProgress);
            case 'catbox.moe':
                return await this.uploadCatbox(file, name, creds, onProgress);

            // Personal Cloud Drives
            case 'mega':
                return await this.uploadMega(file, name, creds, onProgress);
            case 'dropbox':
                return await this.uploadDropbox(file, name, creds, onProgress);
            case 'google_drive':
                return await this.uploadGoogleDrive(file, name, creds, onProgress);
            case 'onedrive':
                return await this.uploadOneDrive(file, name, creds, onProgress);

            // Generic S3-Compatible Storage & Hugging Face
            case 's3_compatible':
                return await this.uploadS3(file, name, creds, onProgress);
            case 'hf_buckets':
                return await this.uploadHuggingFace(file, name, creds, onProgress);

            // Messaging
            case 'telegram':
                return await this.uploadTelegram(file, name, creds, onProgress, allCreds);

            default:
                throw new Error(`Unsupported upload service: ${service}`);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 0. MULTI-SERVICE "UPLOAD TO ALL"
    // ─────────────────────────────────────────────────────────────────────────

    static async uploadToAll(file, name, uploadConfig, onProgress) {
        const vaultCreds = await this.getVaultCreds();
        const allCreds = Object.assign({}, uploadConfig?.credentials || {}, vaultCreds);
        const services = [
            { id: 'gofile.io', name: 'GoFile' },
            { id: 'buzzheavier.com', name: 'Buzzheavier' },
            { id: 'fuckingfast.co', name: 'FFast' },
            { id: 'storage.to', name: 'Storage.to' },
            { id: 'catbox.moe', name: 'Catbox' }
        ];

        if (allCreds['pixeldrain.com']?.apiKey || allCreds['pixeldrain']?.apiKey || allCreds?.apiKey) {
            services.push({ id: 'pixeldrain.com', name: 'Pixeldrain' });
        }
        if (allCreds['telegram']?.botToken && allCreds['telegram']?.chatId) {
            services.push({ id: 'telegram', name: 'Telegram' });
        }
        if (allCreds['s3_compatible']?.endpoint && allCreds['s3_compatible']?.bucket) {
            services.push({ id: 's3_compatible', name: 'S3' });
        }
        if (allCreds['hf_buckets']?.bucket && (allCreds['hf_buckets']?.accessKeyId || allCreds['hf_buckets']?.token)) {
            services.push({ id: 'hf_buckets', name: 'HuggingFace' });
        }

        const results = [];
        const progressMap = {};

        const updateCombined = () => {
            let total = (file.size || 1) * services.length;
            let loaded = 0;
            for (const s of services) {
                loaded += (progressMap[s.id] || 0);
            }
            if (onProgress) onProgress(loaded, total);
        };

        await Promise.allSettled(services.map(async (s) => {
            if (uploadConfig?.signal?.aborted) return;
            try {
                const res = await FetchStreamUploader.upload(file, name, {
                    service: s.id,
                    credentials: allCreds,
                    signal: uploadConfig?.signal,
                    _xhrCallback: uploadConfig?._xhrCallback
                }, (loaded, total) => {
                    progressMap[s.id] = loaded;
                    updateCombined();
                });

                const url = typeof res === 'string' ? res : (res?.url || '');
                if (url && !url.toLowerCase().startsWith('error')) {
                    const linkObj = { service: s.name, serviceId: s.id, url: url };
                    results.push(linkObj);
                    if (uploadConfig?.onLinkGenerated) {
                        try { uploadConfig.onLinkGenerated(linkObj); } catch(e) {}
                    }
                }
            } catch (err) {
                if (err.name === 'AbortError' || uploadConfig?.signal?.aborted) return;
                console.warn(`Multi-upload failed for ${s.name}:`, err);
                const errObj = { service: s.name, serviceId: s.id, url: `Failed: ${err.message || 'Error'}`, error: true };
                results.push(errObj);
                if (uploadConfig?.onLinkGenerated) {
                    try { uploadConfig.onLinkGenerated(errObj); } catch(e) {}
                }
            }
        }));

        const successful = results.filter(r => !r.error);
        if (successful.length === 0) {
            throw new Error("Failed to upload to any of the available services.");
        }

        return {
            url: successful[0].url,
            links: results
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 0.1 MULTI-SERVICE "UPLOAD TO SELECTED" (Custom Checkboxes)
    // ─────────────────────────────────────────────────────────────────────────

    static async getVaultCreds() {
        try {
            const { fs_vault_unlocked } = await chrome.storage.session.get('fs_vault_unlocked');
            if (!fs_vault_unlocked) return {};
            
            // Map flattened vault UI keys back to the nested structure expected by uploader
            return {
                serverUpload: {
                    relayUrl: fs_vault_unlocked.serverRelayUrl,
                    apiKey: fs_vault_unlocked.serverApiKey
                },
                'pixeldrain.com': {
                    apiKey: fs_vault_unlocked.pixeldrainApiKey
                },
                'gofile.io': {
                    token: fs_vault_unlocked.gofileToken,
                    folderId: fs_vault_unlocked.gofileFolderId
                },
                's3_compatible': {
                    endpoint: fs_vault_unlocked.s3Endpoint,
                    bucket: fs_vault_unlocked.s3Bucket,
                    region: fs_vault_unlocked.s3Region,
                    accessKeyId: fs_vault_unlocked.s3AccessKey,
                    secretAccessKey: fs_vault_unlocked.s3SecretKey,
                    prefix: fs_vault_unlocked.s3Prefix
                },
                'telegram': {
                    botToken: fs_vault_unlocked.telegramBotToken,
                    chatId: fs_vault_unlocked.telegramChatId
                }
            };
        } catch(e) {
            return {};
        }
    }

    static async uploadToSelected(file, name, serviceIds, uploadConfig, onProgress) {
        const vaultCreds = await this.getVaultCreds();
        const allCreds = Object.assign({}, uploadConfig?.credentials || {}, vaultCreds);
        const serviceNames = {
            'gofile.io': 'GoFile',
            'buzzheavier.com': 'Buzzheavier',
            'fuckingfast.co': 'FFast',
            'storage.to': 'Storage.to',
            'catbox.moe': 'Catbox',
            'pixeldrain.com': 'Pixeldrain',
            's3_compatible': 'S3 Storage',
            'hf_buckets': 'Hugging Face',
            'telegram': 'Telegram'
        };

        const services = serviceIds.map(id => ({
            id,
            name: serviceNames[id] || id
        }));

        const results = [];
        const progressMap = {};

        const updateCombined = () => {
            let total = (file.size || 1) * services.length;
            let loaded = 0;
            for (const s of services) {
                loaded += (progressMap[s.id] || 0);
            }
            if (onProgress) onProgress(loaded, total);
        };

        await Promise.allSettled(services.map(async (s) => {
            if (uploadConfig?.signal?.aborted) return;
            try {
                const res = await FetchStreamUploader.upload(file, name, {
                    service: s.id,
                    credentials: allCreds,
                    signal: uploadConfig?.signal,
                    _xhrCallback: uploadConfig?._xhrCallback
                }, (loaded, total) => {
                    progressMap[s.id] = loaded;
                    updateCombined();
                });

                const url = typeof res === 'string' ? res : (res?.url || '');
                if (url && !url.toLowerCase().startsWith('error')) {
                    const linkObj = { service: s.name, serviceId: s.id, url: url };
                    results.push(linkObj);

                    if (uploadConfig?.onLinkGenerated) {
                        try { uploadConfig.onLinkGenerated(linkObj); } catch(e) {}
                    }
                }
            } catch (err) {
                if (err.name === 'AbortError' || uploadConfig?.signal?.aborted) return;
                console.warn(`Multi-upload failed for ${s.name}:`, err);
                const errObj = {
                    service: s.name,
                    serviceId: s.id,
                    url: `Failed: ${err.message || 'Error'}`,
                    error: true
                };
                results.push(errObj);
                if (uploadConfig?.onLinkGenerated) {
                    try { uploadConfig.onLinkGenerated(errObj); } catch(e) {}
                }
            }
        }));

        const successful = results.filter(r => !r.error);
        if (successful.length === 0) {
            throw new Error("Failed to upload to any of the selected services.");
        }

        return {
            url: successful[0].url,
            links: results
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. PUBLIC / DIRECT SERVICES
    // ─────────────────────────────────────────────────────────────────────────

    static async uploadPixeldrain(file, name, creds, onProgress) {
        const apiKey = (
            creds?.apiKey
            || creds?.api_key
            || creds?.token
            || creds?.['pixeldrain.com']?.apiKey
            || creds?.['pixeldrain']?.apiKey
            || ''
        ).trim();

        if (!apiKey) {
            throw new Error("Pixeldrain now requires an API key for uploads. Get your free key at pixeldrain.com/user/api_keys and paste it in Settings.");
        }

        const hosts = ['pixeldrain.com', 'pixeldrain.net', 'pixeldrain.nl', 'pixeldrain.biz', 'pixeldrain.tech'];
        let lastErr = null;

        for (const host of hosts) {
            try {
                const res = await new Promise((resolve, reject) => {
                    const formData = new FormData();
                    formData.append('file', file, name);

                    const xhr = new XMLHttpRequest();
                    if (creds?._xhrCallback) creds._xhrCallback(xhr);
                    if (FetchStreamUploader.attachAbortSignal(xhr, creds?.signal, reject)) return;

                    xhr.open('POST', `https://${host}/api/file`, true);
                    xhr.setRequestHeader('Authorization', 'Basic ' + btoa(':' + apiKey));
                    xhr.timeout = 180000;

                    xhr.upload.onprogress = (e) => {
                        const total = (e.lengthComputable && e.total > 0) ? e.total : (file.size || 1);
                        if (onProgress) onProgress(e.loaded, total);
                    };

                    xhr.onload = () => {
                        if (xhr.status >= 200 && xhr.status < 300) {
                            try {
                                const resData = JSON.parse(xhr.responseText);
                                if (resData.id) {
                                    return resolve({ url: `https://${host}/u/${resData.id}` });
                                }
                            } catch (e) {}
                            resolve({ url: `https://${host}/u` });
                        } else {
                            reject(new Error(`Pixeldrain failed (${xhr.status}): ${xhr.responseText.substring(0, 150)}`));
                        }
                    };
                    xhr.onerror = () => reject(new Error(`Network error connecting to ${host}`));
                    xhr.ontimeout = () => reject(new Error(`Timeout connecting to ${host}`));
                    xhr.send(formData);
                });
                return res;
            } catch (err) {
                if (err.name === 'AbortError' || creds?.signal?.aborted) throw err;
                console.warn(`[Pixeldrain] Host ${host} failed (${err.message}), trying next mirror...`);
                lastErr = err;
            }
        }
        throw lastErr || new Error("Pixeldrain failed on all mirrors");
    }

    static async uploadGofile(file, name, creds, onProgress) {
        let token = (creds?.token || '').trim();
        let folderId = (creds?.folderId || '').trim();

        if (!token) {
            try {
                const accRes = await fetch('https://api.gofile.io/accounts', { method: 'POST' });
                if (accRes.ok) {
                    const accData = await accRes.json();
                    if (accData.status === 'ok' && accData.data) {
                        token = (accData.data.token || '').trim();
                        if (!folderId) folderId = (accData.data.rootFolder || '').trim();
                    }
                }
            } catch (e) {
                console.warn('[FetchStream] Could not obtain GoFile guest session:', e);
            }
        }

        return new Promise((resolve, reject) => {
            const formData = new FormData();
            formData.append('file', file, name);
            if (folderId) {
                formData.append('folderId', folderId);
            }

            const xhr = new XMLHttpRequest();
            if (creds?._xhrCallback) creds._xhrCallback(xhr);
            if (FetchStreamUploader.attachAbortSignal(xhr, creds?.signal, reject)) return;
            xhr.open('POST', 'https://upload.gofile.io/uploadfile', true);
            if (token) {
                xhr.setRequestHeader('Authorization', `Bearer ${token}`);
            }

            xhr.upload.onprogress = (e) => {
                const total = (e.lengthComputable && e.total > 0) ? e.total : (file.size || 1);
                if (onProgress) onProgress(e.loaded, total);
            };

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        const res = JSON.parse(xhr.responseText);
                        if (res.status === 'ok' && res.data?.downloadPage) {
                            const page = res.data.downloadPage;
                            const activeToken = (token || res.data.guestToken || '').trim();
                            const parentFolder = res.data.parentFolder;
                            const fileId = res.data.id;
                            if (activeToken && parentFolder) {
                                fetch(`https://api.gofile.io/contents/${parentFolder}/update`, {
                                    method: 'PUT',
                                    headers: {
                                        'Authorization': `Bearer ${activeToken}`,
                                        'Content-Type': 'application/json'
                                    },
                                    body: JSON.stringify({ attribute: 'public', attributeValue: 'true' })
                                }).catch(() => {});
                            }
                            if (activeToken && fileId) {
                                fetch(`https://api.gofile.io/contents/${fileId}/update`, {
                                    method: 'PUT',
                                    headers: {
                                        'Authorization': `Bearer ${activeToken}`,
                                        'Content-Type': 'application/json'
                                    },
                                    body: JSON.stringify({ attribute: 'public', attributeValue: 'true' })
                                }).catch(() => {});
                            }
                            resolve({ url: page });
                            return;
                        }
                        reject(new Error(`GoFile upload failed: ${res.status || 'invalid response'}`));
                    } catch (e) {
                        reject(new Error('GoFile returned an invalid JSON response.'));
                    }
                    if (!xhr.responseText) {
                        reject(new Error('GoFile returned an empty response.'));
                    }
                } else {
                    reject(new Error(`GoFile upload failed (${xhr.status}): ${xhr.responseText}`));
                }
            };
            xhr.onerror = () => reject(new Error("Network error connecting to GoFile"));
            xhr.send(formData);
        });
    }

    static uploadBuzzheavier(file, name, creds, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            if (creds?._xhrCallback) creds._xhrCallback(xhr);
            if (FetchStreamUploader.attachAbortSignal(xhr, creds?.signal, reject)) return;
            const url = `https://w.buzzheavier.com/${encodeURIComponent(name)}`;
            xhr.open('PUT', url, true);
            xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

            if (creds?.accountId && creds.accountId.trim()) {
                xhr.setRequestHeader('Authorization', `Bearer ${creds.accountId.trim()}`);
            }

            xhr.upload.onprogress = (e) => {
                const total = (e.lengthComputable && e.total > 0) ? e.total : (file.size || 1);
                if (onProgress) onProgress(e.loaded, total);
            };

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        const res = JSON.parse(xhr.responseText);
                        const fileId = res.data?.id || res.id;
                        if (fileId) {
                            resolve({ url: `https://buzzheavier.com/${fileId}` });
                            return;
                        }
                    } catch (e) {}
                    resolve({ url: `Upload complete on Buzzheavier` });
                } else {
                    reject(new Error(`Buzzheavier failed (${xhr.status}): ${xhr.responseText}`));
                }
            };
            xhr.onerror = () => reject(new Error("Network error connecting to Buzzheavier"));
            xhr.send(file);
        });
    }

    static uploadFuckingFast(file, name, creds, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            if (creds?._xhrCallback) creds._xhrCallback(xhr);
            if (FetchStreamUploader.attachAbortSignal(xhr, creds?.signal, reject)) return;
            const url = `https://w.fuckingfast.net/${encodeURIComponent(name)}`;
            xhr.open('PUT', url, true);
            xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

            if (creds?.accountId && creds.accountId.trim()) {
                xhr.setRequestHeader('Authorization', `Bearer ${creds.accountId.trim()}`);
            }

            xhr.upload.onprogress = (e) => {
                const total = (e.lengthComputable && e.total > 0) ? e.total : (file.size || 1);
                if (onProgress) onProgress(e.loaded, total);
            };

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        const res = JSON.parse(xhr.responseText);
                        const fileId = res.data?.id || res.id;
                        if (fileId) {
                            resolve({ url: `https://fuckingfast.net/${fileId}` });
                            return;
                        }
                    } catch (e) {}
                    resolve({ url: `Upload complete on FuckingFast` });
                } else {
                    reject(new Error(`FuckingFast failed (${xhr.status}): ${xhr.responseText}`));
                }
            };
            xhr.onerror = () => reject(new Error("Network error connecting to FuckingFast"));
            xhr.send(file);
        });
    }

    static async uploadStorageTo(file, name, creds, onProgress) {
        const contentType = file.type || 'application/octet-stream';
        const initResponse = await fetch('https://storage.to/api/upload/init', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filename: name,
                content_type: contentType,
                size: file.size || 0
            }),
            signal: creds?.signal
        });

        if (!initResponse.ok) {
            throw new Error(`Storage.to initialization failed (${initResponse.status}): ${await initResponse.text()}`);
        }

        const initResult = await initResponse.json();
        if (!initResult.r2_key) {
            throw new Error('Storage.to did not return a file key.');
        }

        const uploadPart = (url, blob, partNumber, baseBytes = 0) => new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            if (creds?._xhrCallback) creds._xhrCallback(xhr);
            if (FetchStreamUploader.attachAbortSignal(xhr, creds?.signal, reject)) return;

            xhr.open('PUT', url, true);
            xhr.upload.onprogress = (e) => {
                const loaded = e.lengthComputable ? e.loaded : 0;
                if (onProgress) onProgress(baseBytes + loaded, file.size || 1);
            };
            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(xhr.getResponseHeader('ETag') || xhr.getResponseHeader('etag'));
                } else {
                    reject(new Error(`Storage.to byte upload failed (${xhr.status}): ${xhr.responseText}`));
                }
            };
            xhr.onerror = () => reject(new Error('Network error uploading bytes to Storage.to'));
            xhr.send(blob);
        });

        let multipartParts = [];
        if (initResult.type === 'multipart' && initResult.initial_urls) {
            const partSize = initResult.part_size;
            const totalParts = initResult.total_parts || Object.keys(initResult.initial_urls).length;
            let uploadedBytes = 0;

            for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
                const start = (partNumber - 1) * partSize;
                const part = file.slice(start, Math.min(start + partSize, file.size));
                const etag = await uploadPart(initResult.initial_urls[String(partNumber)], part, partNumber, uploadedBytes);
                uploadedBytes += part.size;
                if (onProgress) onProgress(uploadedBytes, file.size || 1);
                if (!etag) {
                    throw new Error(`Storage.to did not return an ETag for part ${partNumber}.`);
                }
                multipartParts.push({ partNumber, etag });
            }
        } else if (initResult.upload_url) {
            await uploadPart(initResult.upload_url, file, 1);
            if (onProgress) onProgress(file.size || 0, file.size || 1);
        } else {
            throw new Error('Storage.to did not return an upload URL.');
        }

        if (initResult.upload_id) {
            const completeResponse = await fetch('https://storage.to/api/upload/complete-multipart', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(initResult.owner_token ? { 'Authorization': `Owner ${initResult.owner_token}` } : {})
                },
                body: JSON.stringify({
                    upload_id: initResult.upload_id,
                    parts: multipartParts
                }),
                signal: creds?.signal
            });

            if (!completeResponse.ok) {
                throw new Error(`Storage.to multipart completion failed (${completeResponse.status}): ${await completeResponse.text()}`);
            }
        }

        const confirmResponse = await fetch('https://storage.to/api/upload/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filename: name,
                content_type: contentType,
                size: file.size || 0,
                r2_key: initResult.r2_key
            }),
            signal: creds?.signal
        });

        if (!confirmResponse.ok) {
            throw new Error(`Storage.to confirmation failed (${confirmResponse.status}): ${await confirmResponse.text()}`);
        }

        const confirmResult = await confirmResponse.json();
        if (!confirmResult.success || !confirmResult.file?.url) {
            throw new Error('Storage.to confirmation did not return a shareable URL.');
        }

        return { url: confirmResult.file.url };
    }

    static uploadCatbox(file, name, creds, onProgress) {
        return new Promise((resolve, reject) => {
            const formData = new FormData();
            formData.append('reqtype', 'fileupload');
            if (creds?.userhash && creds.userhash.trim()) {
                formData.append('userhash', creds.userhash.trim());
            }

            let endpoint = 'https://catbox.moe/user/api.php';
            if (file.size > 200 * 1024 * 1024) {
                if (file.size <= 1024 * 1024 * 1024) {
                    formData.append('time', '72h');
                    endpoint = 'https://litterbox.catbox.moe/resources/internals/api.php';
                } else {
                    return reject(new Error(`File size (${(file.size / (1024*1024)).toFixed(1)} MB) exceeds Catbox / Litterbox upload capacity. Please select GoFile, Buzzheavier, Hugging Face, or Pixeldrain.`));
                }
            }

            formData.append('fileToUpload', file, name);

            const xhr = new XMLHttpRequest();
            if (creds?._xhrCallback) creds._xhrCallback(xhr);
            if (FetchStreamUploader.attachAbortSignal(xhr, creds?.signal, reject)) return;
            xhr.open('POST', endpoint, true);

            xhr.upload.onprogress = (e) => {
                const total = (e.lengthComputable && e.total > 0) ? e.total : (file.size || 1);
                if (onProgress) onProgress(e.loaded, total);
            };

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    const url = xhr.responseText.trim();
                    if (url.startsWith('http')) {
                        resolve({ url: url });
                    } else {
                        reject(new Error(`Catbox error: ${url}`));
                    }
                } else {
                    reject(new Error(`Catbox upload failed (${xhr.status}): ${xhr.responseText}`));
                }
            };
            xhr.onerror = () => reject(new Error("Network error connecting to Catbox"));
            xhr.send(formData);
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. PERSONAL CLOUD DRIVES
    // ─────────────────────────────────────────────────────────────────────────

    static async uploadMega(file, name, creds, onProgress) {
        throw new Error("MEGA integration is Coming Soon. Please select another upload destination.");
    }

    static uploadDropbox(file, name, creds, onProgress) {
        throw new Error("Dropbox integration is Coming Soon. Please select another upload destination.");
    }

    static async uploadGoogleDrive(file, name, creds, onProgress) {
        throw new Error("Google Drive integration is Coming Soon. Please select another upload destination.");
    }

    static async uploadOneDrive(file, name, creds, onProgress) {
        throw new Error("OneDrive integration is Coming Soon. Please select another upload destination.");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. OBJECT STORAGE (S3-COMPATIBLE & HUGGING FACE)
    // ─────────────────────────────────────────────────────────────────────────

    static async uploadS3(file, name, creds, onProgress) {
        const endpoint = creds?.endpoint?.trim();
        const bucket = creds?.bucket?.trim();
        const accessKeyId = creds?.accessKeyId?.trim();
        const secretAccessKey = creds?.secretAccessKey?.trim();
        const region = creds?.region?.trim() || 'auto';
        const prefix = (creds?.prefix || '').trim().replace(/^\/+|\/+$/g, '');

        if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
            throw new Error("Missing required S3 fields: Endpoint, Bucket, Access Key ID, or Secret Key.");
        }

        const fullPath = prefix ? `${prefix}/${name}` : name;
        const signed = await AwsSigV4.sign({
            method: 'PUT',
            endpoint: endpoint,
            bucket: bucket,
            path: fullPath,
            region: region,
            accessKeyId: accessKeyId,
            secretAccessKey: secretAccessKey
        });

        await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            if (creds?._xhrCallback) creds._xhrCallback(xhr);
            if (FetchStreamUploader.attachAbortSignal(xhr, creds?.signal, reject)) return;
            xhr.open('PUT', signed.url, true);
            for (const [k, v] of Object.entries(signed.headers)) {
                if (k.toLowerCase() !== 'host') {
                    xhr.setRequestHeader(k, v);
                }
            }
            const resolvedContentType = FetchStreamUploader.resolveMimeType(name, file?.type);
            xhr.setRequestHeader('Content-Type', resolvedContentType);

            xhr.upload.onprogress = (e) => {
                const total = (e.lengthComputable && e.total > 0) ? e.total : (file.size || 1);
                if (onProgress) onProgress(e.loaded, total);
            };

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve();
                } else {
                    reject(new Error(`S3 upload failed (${xhr.status}): ${xhr.responseText}`));
                }
            };
            xhr.onerror = () => reject(new Error("Network error uploading to S3 endpoint"));
            xhr.send(file);
        });

        // Generate presigned download URL (max 7 days = 604800 seconds)
        const presignedUrl = await AwsSigV4.presign({
            method: 'GET',
            endpoint: endpoint,
            bucket: bucket,
            path: fullPath,
            region: region,
            accessKeyId: accessKeyId,
            secretAccessKey: secretAccessKey,
            expiresIn: 604800
        });

        // If endpoint is Hugging Face S3, resolve direct CDN URL without username/bucket
        let finalUrl = presignedUrl;
        if (endpoint && endpoint.includes('hf.co')) {
            finalUrl = await this.resolveHfCdnUrl(presignedUrl);
        }

        return { url: finalUrl };
    }

    /**
     * Resolves the direct CloudFront CDN download URL (us.aws.cdn.hf.co/xet-bridge-us/...) from an s3.hf.co URL.
     * This strips out the username, bucket name, and secret access keys, returning a clean direct CDN link.
     */
    static async resolveHfCdnUrl(url, maxRetries = 2) {
        if (!url || typeof url !== 'string' || !url.includes('s3.hf.co')) {
            return url;
        }

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    await new Promise(r => setTimeout(r, 600));
                }

                const controller = new AbortController();
                const timeoutId = setTimeout(() => {
                    try { controller.abort(); } catch(e) {}
                }, 8000);

                const res = await fetch(url, {
                    method: 'GET',
                    headers: { 'Range': 'bytes=0-0' },
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (res.url && (res.url.includes('cdn.hf.co') || res.url.includes('xet-bridge') || res.url !== url)) {
                    try {
                        if (res.body && typeof res.body.cancel === 'function') {
                            res.body.cancel().catch(() => {});
                        }
                    } catch(e) {}
                    try { controller.abort(); } catch(e) {}
                    return res.url;
                }
            } catch (err) {
                if (attempt === maxRetries) {
                    console.warn("Could not resolve direct HF CDN redirect, using presigned URL:", err);
                }
            }
        }

        return url;
    }

    static async uploadHuggingFace(file, name, creds, onProgress) {
        const bucket = creds?.bucket?.trim();
        const accessKeyId = creds?.accessKeyId?.trim();
        const secretAccessKey = creds?.secretAccessKey?.trim();
        const prefix = (creds?.prefix || '').trim();

        if (!bucket || !accessKeyId || !secretAccessKey) {
            throw new Error("Missing Hugging Face Bucket Name, Access Key ID, or Secret Key.");
        }

        const fullPath = prefix ? `${prefix.replace(/^\/+|\/+$/g, '')}/${name}` : name;

        // Upload the file
        await this.uploadS3(file, name, {
            endpoint: 'https://s3.hf.co',
            bucket: bucket,
            region: 'us-east-1',
            accessKeyId: accessKeyId,
            secretAccessKey: secretAccessKey,
            prefix: prefix,
            _xhrCallback: creds?._xhrCallback
        }, onProgress);

        // Generate presigned download URL (max 7 days = 604800 seconds)
        const presignedUrl = await AwsSigV4.presign({
            method: 'GET',
            endpoint: 'https://s3.hf.co',
            bucket: bucket,
            path: fullPath,
            region: 'us-east-1',
            accessKeyId: accessKeyId,
            secretAccessKey: secretAccessKey,
            expiresIn: 604800
        });

        // Resolve direct CDN download URL (us.aws.cdn.hf.co/xet-bridge-us/...) with no username or bucket name
        const cdnUrl = await this.resolveHfCdnUrl(presignedUrl);

        return { url: cdnUrl };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. MESSAGING
    // ─────────────────────────────────────────────────────────────────────────

    static async uploadTelegram(file, name, creds, onProgress, allCreds = {}) {
        const botToken = creds?.botToken?.trim();
        const chatId = creds?.chatId?.trim();

        if (!botToken || !chatId) {
            throw new Error("Please enter your Telegram Bot Token and Chat ID in Settings.");
        }

        const serverUrl = (creds?.serverUrl || allCreds?.telegram?.serverUrl || '').trim().replace(/\/+$/, '');
        const lowerName = (name || '').toLowerCase();
        const isVideo = lowerName.endsWith('.mp4') || lowerName.endsWith('.mkv') || lowerName.endsWith('.mov') || lowerName.endsWith('.webm') || lowerName.endsWith('.m4v');
        const isAudio = lowerName.endsWith('.mp3') || lowerName.endsWith('.m4a') || lowerName.endsWith('.aac') || lowerName.endsWith('.ogg') || lowerName.endsWith('.opus') || lowerName.endsWith('.flac') || lowerName.endsWith('.wav');
        const method = isVideo ? 'sendVideo' : (isAudio ? 'sendAudio' : 'sendDocument');
        const fieldName = isVideo ? 'video' : (isAudio ? 'audio' : 'document');

        let endpoint = `https://api.telegram.org/bot${botToken}/${method}`;

        if (serverUrl) {
            // Self-hosted Bot API server running with --local supports extended file limits
            endpoint = `${serverUrl}/bot${botToken}/${method}`;
        } else if (file.size > 50 * 1024 * 1024) {
            const sizeStr = (file.size / (1024 * 1024)).toFixed(1) + ' MB';
            throw new Error(`File size (${sizeStr}) exceeds the standard 50 MB Telegram Bot API limit. If you have Remote Server URL configured in Server Upload settings, please use 'Server Upload' to send files up to 2 GB via your runner.`);
        }

        return new Promise((resolve, reject) => {
            const formData = new FormData();
            formData.append('chat_id', chatId);
            formData.append(fieldName, file, name);
            const customCaption = (creds?.caption !== undefined && creds.caption !== null && creds.caption.trim()) 
                ? creds.caption.trim() 
                : (allCreds?.telegram?.caption ? allCreds.telegram.caption.trim() : "");
            const defaultCaption = isVideo ? `🎬 ${name}` : (isAudio ? `🎵 ${name}` : `📄 ${name}`);
            const captionText = customCaption ? customCaption : defaultCaption;
            formData.append('caption', captionText);
            if (isVideo) {
                formData.append('supports_streaming', 'true');
            }

            const xhr = new XMLHttpRequest();
            if (creds?._xhrCallback) creds._xhrCallback(xhr);
            if (FetchStreamUploader.attachAbortSignal(xhr, creds?.signal, reject)) return;
            xhr.open('POST', endpoint, true);

            xhr.upload.onprogress = (e) => {
                const total = (e.lengthComputable && e.total > 0) ? e.total : (file.size || 1);
                if (onProgress) onProgress(e.loaded, total);
            };

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        const res = JSON.parse(xhr.responseText);
                        if (res.ok && res.result) {
                            const messageId = res.result.message_id;
                            let telegramLink = '';

                            if (chatId.startsWith('@')) {
                                telegramLink = `https://t.me/${chatId.replace('@', '')}/${messageId}`;
                            } else if (chatId.startsWith('-100')) {
                                const channelId = chatId.replace('-100', '');
                                telegramLink = `https://t.me/c/${channelId}/${messageId}`;
                            } else {
                                const cleanId = chatId.replace('-', '');
                                telegramLink = `https://t.me/c/${cleanId}/${messageId}`;
                            }

                            const linkLabel = serverUrl ? 'Telegram (Self-Hosted Server)' : 'Telegram';
                            const linkObj = { service: linkLabel, serviceId: 'telegram', url: telegramLink };
                            if (creds?.onLinkGenerated) {
                                try { creds.onLinkGenerated(linkObj); } catch(e) {}
                            }

                            resolve({
                                url: telegramLink,
                                links: [linkObj]
                            });
                            return;
                        }
                        if (res.ok === false) {
                            reject(new Error(`Telegram API error: ${res.description || 'Upload rejected'}`));
                            return;
                        }
                    } catch (e) {
                        reject(new Error(`Telegram response error: ${e.message}`));
                        return;
                    }
                    resolve({ url: `Sent to Telegram: ${chatId}` });
                } else {
                    reject(new Error(`Telegram upload failed (${xhr.status}): ${xhr.responseText}`));
                }
            };
            xhr.onerror = () => reject(new Error("Network error connecting to Telegram Bot API"));
            xhr.send(formData);
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. COMBINED STORAGE + CLOUD RUNNER RELAY
    // ═══════════════════════════════════════════════════════════════════════════

    static async uploadCombinedStorageToTelegram(file, name, allCreds, creds, onProgress) {
        const hfCreds = allCreds?.hf_buckets || {};
        const s3Creds = allCreds?.s3_compatible || {};

        const hasHf = Boolean(hfCreds.bucket && hfCreds.accessKeyId && hfCreds.secretAccessKey);
        const hasS3 = Boolean(s3Creds.endpoint && s3Creds.bucket && s3Creds.accessKeyId && s3Creds.secretAccessKey);

        const preferred = creds?.preferredProvider || allCreds?.s3_hf_telegram?.preferredProvider || 'auto';

        let chosenStorage = null;
        if (preferred === 'hf_buckets' && hasHf) {
            chosenStorage = 'hf_buckets';
        } else if (preferred === 's3_compatible' && hasS3) {
            chosenStorage = 's3_compatible';
        } else if (hasHf) {
            chosenStorage = 'hf_buckets';
        } else if (hasS3) {
            chosenStorage = 's3_compatible';
        }

        if (!chosenStorage) {
            throw new Error("Please configure either Hugging Face or AWS/S3 Storage credentials in Settings first.");
        }

        return await this.uploadStorageToTelegram(file, name, chosenStorage, allCreds, creds, onProgress);
    }

    static async uploadStorageToTelegram(file, name, storageType, allCreds, creds, onProgress) {
        let cdnUrl = '';
        const telegramCreds = allCreds?.telegram || {};
        const botToken = (creds?.botToken || telegramCreds?.botToken || '').trim();
        const chatId = (creds?.chatId || telegramCreds?.chatId || '').trim();
        const relayUrl = (creds?.relayUrl || allCreds?.s3_hf_telegram?.relayUrl || telegramCreds?.relayUrl || '').trim().replace(/\/+$/, '');

        if (!botToken || !chatId) {
            throw new Error("Please enter your Telegram Bot Token and Chat ID in Settings.");
        }

        if (!relayUrl) {
            throw new Error("Please enter your Remote Server URL in Settings under Telegram or S3/HF + Telegram.");
        }

        // 1. Upload to Storage Provider (0% -> 50% progress)
        const storageDisplayName = storageType === 'hf_buckets' ? 'Hugging Face' : 'AWS / S3';
        if (storageType === 'hf_buckets') {
            const hfCreds = allCreds?.hf_buckets || {};
            if (!hfCreds.bucket || !hfCreds.accessKeyId || !hfCreds.secretAccessKey) {
                throw new Error("Missing Hugging Face Bucket Name, Access Key ID, or Secret Key in Settings.");
            }
            if (onProgress) onProgress(0, file.size * 2);
            const hfRes = await this.uploadHuggingFace(file, name, Object.assign({}, hfCreds, {
                signal: creds?.signal,
                _xhrCallback: creds?._xhrCallback
            }), (loaded, total) => {
                if (onProgress) onProgress(loaded, total * 2);
            });
            cdnUrl = hfRes.url;
        } else if (storageType === 's3_compatible') {
            const s3Creds = allCreds?.s3_compatible || {};
            if (!s3Creds.endpoint || !s3Creds.bucket || !s3Creds.accessKeyId || !s3Creds.secretAccessKey) {
                throw new Error("Missing S3 Endpoint, Bucket Name, Access Key, or Secret Key in Settings.");
            }
            if (onProgress) onProgress(0, file.size * 2);
            const s3Res = await this.uploadS3(file, name, Object.assign({}, s3Creds, {
                signal: creds?.signal,
                _xhrCallback: creds?._xhrCallback
            }), (loaded, total) => {
                if (onProgress) onProgress(loaded, total * 2);
            });
            cdnUrl = s3Res.url;
        } else {
            throw new Error(`Unsupported storage type: ${storageType}`);
        }

        if (!cdnUrl) {
            throw new Error("Storage upload succeeded but failed to resolve a download CDN URL.");
        }

        // Display CDN direct download URL immediately
        const cdnLinkObj = {
            service: `${storageDisplayName} Direct CDN`,
            serviceId: storageType,
            url: cdnUrl
        };
        if (creds?.onLinkGenerated) {
            try { creds.onLinkGenerated(cdnLinkObj); } catch(e) {}
        }

        // 2. Queue Remote Upload via Generic Server API
        if (onProgress) onProgress(file.size, file.size * 2);

        const apiKey = (creds?.apiKey || allCreds?.serverUpload?.apiKey || allCreds?.s3_hf_telegram?.apiKey || '').trim();
        const reqHeaders = { 'Content-Type': 'application/json' };
        if (apiKey) {
            reqHeaders['Authorization'] = `Bearer ${apiKey}`;
            reqHeaders['X-API-Key'] = apiKey;
        }

        let relayRes;
        try {
            relayRes = await fetch(`${relayUrl}/api/server-relay`, {
                method: 'POST',
                headers: reqHeaders,
                body: JSON.stringify({
                    mediaUrl: cdnUrl,
                    fileName: name,
                    type: 'direct',
                    service: 'telegram',
                    credentials: {
                        chatId: chatId,
                        botToken: botToken,
                        caption: creds?.caption || allCreds?.telegram?.caption || ""
                    }
                }),
                signal: creds?.signal
            });
        } catch (fetchErr) {
            throw new Error(`Failed to contact Remote Server at ${relayUrl}: ${fetchErr.message}`);
        }

        const relayData = await relayRes.json().catch(() => ({}));
        if (!relayRes.ok || !relayData.jobId) {
            throw new Error(relayData.error || `Relay server rejected job (${relayRes.status})`);
        }

        const jobId = relayData.jobId;

        // 3. Poll /api/server-status until completed or failed
        const maxWaitMs = 45 * 60 * 1000; // 45 minutes
        const startTime = Date.now();

        const statusHeaders = {};
        if (apiKey) {
            statusHeaders['Authorization'] = `Bearer ${apiKey}`;
            statusHeaders['X-API-Key'] = apiKey;
        }

        while (Date.now() - startTime < maxWaitMs) {
            if (creds?.signal?.aborted) {
                throw new DOMException('Upload aborted', 'AbortError');
            }

            await new Promise(resolve => setTimeout(resolve, 3500));

            try {
                const statusUrl = `${relayUrl}/api/server-status?jobId=${encodeURIComponent(jobId)}`;

                const statusRes = await fetch(statusUrl, {
                    headers: statusHeaders,
                    signal: creds?.signal,
                    cache: 'no-store'
                });
                if (!statusRes.ok) continue;

                const statusData = await statusRes.json();

                if (statusData.status === 'QUEUED') {
                    if (onProgress) onProgress(file.size + (file.size * 0.1), file.size * 2);
                } else if (statusData.status === 'DOWNLOADING') {
                    const dlPct = statusData.progress ? (statusData.progress / 100) : 0.3;
                    if (onProgress) onProgress(file.size + (file.size * 0.5 * dlPct), file.size * 2);
                } else if (statusData.status === 'UPLOADING') {
                    const upPct = statusData.progress ? (statusData.progress / 100) : 0.5;
                    if (onProgress) onProgress(file.size + (file.size * (0.5 + 0.5 * upPct)), file.size * 2);
                } else if (statusData.status === 'COMPLETED') {
                    if (onProgress) onProgress(file.size * 2, file.size * 2);
                    let tgUrl = statusData.telegramUrl;
                    if (!tgUrl) {
                        if (chatId.startsWith('@')) {
                            tgUrl = `https://t.me/${chatId.replace('@', '')}`;
                        } else if (chatId.startsWith('-100')) {
                            tgUrl = `https://t.me/c/${chatId.replace('-100', '')}`;
                        } else {
                            tgUrl = `https://t.me/c/${chatId.replace('-', '')}`;
                        }
                    }
                    const tgLinkObj = { service: 'Telegram (Remote Runner)', serviceId: 'telegram', url: tgUrl };
                    if (creds?.onLinkGenerated) {
                        try { creds.onLinkGenerated(tgLinkObj); } catch(e) {}
                    }
                    return {
                        url: tgUrl,
                        links: [
                            tgLinkObj,
                            cdnLinkObj
                        ]
                    };
                } else if (statusData.status === 'FAILED') {
                    throw new Error(`Telegram remote runner failed: ${statusData.error || statusData.speed || 'Unknown error'}`);
                } else if (statusData.status === 'CANCELLED') {
                    throw new DOMException('Server upload cancelled by user', 'AbortError');
                }
            } catch (pollErr) {
                if (pollErr.name === 'AbortError' || pollErr.message?.startsWith('Telegram remote runner failed:')) {
                    throw pollErr;
                }
            }
        }

        throw new Error("Telegram transfer timed out waiting for remote runner (45 minutes exceeded).");
    }

    /**
     * Direct remote URL upload for supported hosts (e.g. Catbox.moe, Pixeldrain)
     * when the file is a direct URL without custom auth headers.
     */
    static async uploadViaDirectUrl(url, name, service, creds = {}) {
        if (service === 'catbox.moe') {
            const form = new FormData();
            form.append('reqtype', 'urlupload');
            form.append('url', url);
            if (creds?.userhash) form.append('userhash', creds.userhash);

            const res = await fetch('https://catbox.moe/user/api.php', {
                method: 'POST',
                body: form
            });
            const text = (await res.text()).trim();
            if (text.startsWith('http')) {
                return { url: text, links: [{ service: 'Catbox.moe', url: text }] };
            }
            throw new Error(text || 'Catbox URL upload failed');
        }

        if (service === 'pixeldrain.com') {
            const headers = { 'Content-Type': 'application/json' };
            if (creds?.apiKey) {
                headers['Authorization'] = 'Basic ' + btoa(':' + creds.apiKey);
            }
            const res = await fetch('https://pixeldrain.com/api/file/url', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ url: url, name: name })
            });
            const data = await res.json();
            if (data?.id) {
                const finalUrl = `https://pixeldrain.com/u/${data.id}`;
                return { url: finalUrl, links: [{ service: 'Pixeldrain', url: finalUrl }] };
            }
            throw new Error(data?.message || 'Pixeldrain URL upload failed');
        }

        throw new Error(`Direct remote URL upload is not natively supported by ${service}.`);
    }

    /**
     * Universal Server-Side Upload Dispatcher (Cloud Runner)
     * Offloads the entire stream/file download and upload to the remote runner.
     * Zero local bandwidth used on the user's computer.
     */
    static async dispatchServerUpload(taskData, serverConfig, onProgress) {
        const vaultCreds = await this.getVaultCreds();
        taskData.credentials = Object.assign({}, taskData.credentials || {}, vaultCreds);
        const relayUrl = (serverConfig?.relayUrl || vaultCreds?.serverUpload?.relayUrl || '').replace(/\/+$/, '');
        const apiKey = serverConfig?.apiKey || vaultCreds?.serverUpload?.apiKey;
        if (!relayUrl) {
            throw new Error('Remote Server URL is not configured. Please set your server URL in Settings (or see the Server Setup Guide).');
        }

        // 1. Direct Remote URL shortcut check (only for direct files without auth headers)
        const isHls = taskData.type === 'hls' || (taskData.url && taskData.url.toLowerCase().includes('.m3u8'));
        const hasAuthHeaders = taskData.headers && Object.keys(taskData.headers).some(k => ['cookie', 'authorization'].includes(k.toLowerCase()));

        if (!isHls && !hasAuthHeaders && (taskData.service === 'catbox.moe' || taskData.service === 'pixeldrain.com')) {
            try {
                if (onProgress) onProgress({ status: 'UPLOADING', stage: 'DIRECT_URL_UPLOAD', progress: 50, speed: 'Sending URL directly to host...' });
                const directRes = await this.uploadViaDirectUrl(taskData.url, taskData.name, taskData.service, taskData.credentials);
                if (onProgress) onProgress({ status: 'COMPLETED', stage: 'COMPLETED', progress: 100, speed: 'Direct URL Upload Complete' });
                return directRes;
            } catch (directErr) {
                console.warn('Direct URL upload failed, falling back to server runner:', directErr);
            }
        }

        // 2. Dispatch Server Relay Job via Remote Server API
        if (onProgress) onProgress({ status: 'QUEUED', stage: 'DISPATCHING', progress: 5, speed: 'Dispatching job to Remote Server...' });

        // Clean headers: strip out CORS preflight and browser-internal headers
        const cleanHeaders = {};
        const BLOCKED_HEADERS = new Set([
            'host', 'connection', 'content-length', 'transfer-encoding',
            'accept-encoding', 'access-control-request-method', 'access-control-request-headers',
            'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest', 'sec-fetch-user', 'priority'
        ]);
        if (taskData.headers && typeof taskData.headers === 'object') {
            for (const [k, v] of Object.entries(taskData.headers)) {
                const lowerK = k.toLowerCase().trim();
                if (!v || BLOCKED_HEADERS.has(lowerK) || lowerK.startsWith('sec-ch-') || lowerK.startsWith('access-control-')) {
                    continue;
                }
                if (lowerK === 'origin' && String(v).includes('chrome-extension://')) {
                    continue;
                }
                cleanHeaders[k] = String(v).trim();
            }
        }

        const reqHeaders = { 'Content-Type': 'application/json' };
        if (apiKey) {
            reqHeaders['Authorization'] = `Bearer ${apiKey}`;
            reqHeaders['X-API-Key'] = apiKey;
        }

        let jobId = taskData.id;
        if (!taskData.isDispatched) {
            let relayRes;
            try {
                relayRes = await fetch(`${relayUrl}/api/server-relay`, {
                    method: 'POST',
                    headers: reqHeaders,
                    body: JSON.stringify({
                        jobId: taskData.id,
                        mediaUrl: taskData.url,
                        headers: cleanHeaders,
                        fileName: taskData.name,
                        type: isHls ? 'hls' : 'direct',
                        format: taskData.format || 'mp4',
                        service: taskData.service || 'gofile.io',
                        threads: Number(taskData.threads || serverConfig.threads) || 8,
                        credentials: taskData.credentials || {},
                        useFallbackProxy: serverConfig.useFallbackProxy !== false
                    }),
                    signal: taskData.signal
                });
            } catch (fetchErr) {
                throw new Error(`Could not contact Remote Server at ${relayUrl}: ${fetchErr.message}`);
            }

            const relayData = await relayRes.json().catch(() => ({}));
            if (!relayRes.ok || !relayData.jobId) {
                throw new Error(relayData.error || `Server rejected relay job (${relayRes.status})`);
            }
            jobId = relayData.jobId;
        }
        // 3. Poll /api/server-status until completed or failed (every 1.5s for live smooth progress)
        const maxWaitMs = 60 * 60 * 1000; // 60 minutes
        const startTime = Date.now();

        let notFoundCount = 0;
        while (Date.now() - startTime < maxWaitMs) {
            if (taskData.signal?.aborted) {
                throw new DOMException('Server upload cancelled by user', 'AbortError');
            }

            await new Promise(resolve => setTimeout(resolve, 1000));

            try {
                const statusHeaders = {};
                if (apiKey) {
                    statusHeaders['Authorization'] = `Bearer ${apiKey}`;
                    statusHeaders['X-API-Key'] = apiKey;
                }

                const statusUrl = `${relayUrl}/api/server-status?jobId=${encodeURIComponent(jobId)}`;

                const statusRes = await fetch(statusUrl, { headers: statusHeaders, signal: taskData.signal, cache: 'no-store' });
                if (!statusRes.ok) {
                    if (statusRes.status === 404) {
                        notFoundCount++;
                        if (notFoundCount >= 3) {
                            throw new Error(`Job '${jobId}' not found on remote runner (404).`);
                        }
                    }
                    continue;
                }
                notFoundCount = 0;

                const statusData = await statusRes.json();

                if (onProgress) {
                    onProgress({
                        status: statusData.status || 'RUNNING',
                        stage: statusData.stage || statusData.status,
                        progress: statusData.progress || 20,
                        speed: statusData.speed || statusData.message || 'Processing in cloud...',
                        url: (statusData.url && !statusData.url.includes('.m3u8')) ? statusData.url : null,
                        links: Array.isArray(statusData.links) ? statusData.links.filter(l => l.url && !l.url.includes('.m3u8')) : [],
                        error: statusData.status === 'FAILED' ? (statusData.error || statusData.speed) : null
                    });
                }

                if (statusData.status === 'COMPLETED') {
                    const rawUrl = statusData.url || (statusData.links && statusData.links[0]?.url) || '';
                    const finalUrl = (rawUrl && !rawUrl.includes('.m3u8')) ? rawUrl : '';
                    const validLinks = (Array.isArray(statusData.links) && statusData.links.length > 0)
                        ? statusData.links.filter(l => l.url && !l.url.includes('.m3u8'))
                        : (finalUrl ? [{ service: taskData.service, url: finalUrl }] : []);
                    return {
                        url: finalUrl,
                        links: validLinks,
                        jobId: jobId,
                        fileSize: statusData.fileSize || 0
                    };
                } else if (statusData.status === 'FAILED') {
                    throw new Error(`Server runner failed: ${statusData.error || statusData.speed || 'Unknown error'}`);
                } else if (statusData.status === 'CANCELLED') {
                    throw new DOMException('Server upload cancelled by user', 'AbortError');
                }
            } catch (pollErr) {
                if (pollErr.name === 'AbortError' || pollErr.message?.startsWith('Server runner failed:') || pollErr.message?.includes('not found on remote runner')) {
                    throw pollErr;
                }
            }
        }

        throw new Error("Server upload timed out waiting for remote runner (60 minutes exceeded).");
    }
}

if (typeof window !== 'undefined') {
    window.FetchStreamUploader = FetchStreamUploader;
    window.Uploader = FetchStreamUploader;
}
if (typeof globalThis !== 'undefined') {
    globalThis.FetchStreamUploader = FetchStreamUploader;
    globalThis.Uploader = FetchStreamUploader;
}
if (typeof self !== 'undefined') {
    self.FetchStreamUploader = FetchStreamUploader;
    self.Uploader = FetchStreamUploader;
}

