/**
 * FetchStream Unified Multi-Task Downloads Manager
 *
 * Streams HLS/M3U8 segments directly to disk using the Origin Private File System (OPFS)
 * for near-zero RAM usage, with AES-128 processing, parallel segment fetching,
 * and reliable file saving via chrome.downloads API.
 *
 * Falls back to in-memory buffering when OPFS is unavailable (e.g. incognito).
 */

// ─── Lightweight M3U8 Manifest Parser ───────────────────────────────────

class HlsParser {
    static parse(text, baseUrl) {
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
        if (!lines.some(l => l.startsWith('#EXTM3U'))) {
            throw new Error('Invalid HLS playlist: Missing #EXTM3U header');
        }
        const isMaster = lines.some(l => l.startsWith('#EXT-X-STREAM-INF'));
        return isMaster ? this.parseMaster(lines, baseUrl) : this.parseMedia(lines, baseUrl);
    }

    static parseMaster(lines, baseUrl) {
        const variants = [];
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                const attrs = this.parseAttributes(lines[i]);
                const nextLine = lines[i + 1];
                if (nextLine && !nextLine.startsWith('#')) {
                    variants.push({
                        bandwidth: parseInt(attrs['BANDWIDTH'], 10) || 0,
                        resolution: attrs['RESOLUTION'] || '',
                        codecs: attrs['CODECS'] || '',
                        url: this.resolveUrl(nextLine, baseUrl)
                    });
                    i++;
                }
            }
        }
        variants.sort((a, b) => b.bandwidth - a.bandwidth);
        return { type: 'master', variants };
    }

    static parseMedia(lines, baseUrl) {
        const segments = [];
        let currentKey = null;
        let initSegment = null;
        let totalDuration = 0;
        let currentByteOffset = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (line.startsWith('#EXT-X-KEY')) {
                const attrs = this.parseAttributes(line);
                if (attrs['METHOD'] === 'NONE') {
                    currentKey = null;
                } else {
                    currentKey = {
                        METHOD: attrs['METHOD'],
                        URI: attrs['URI'] ? this.resolveUrl(attrs['URI'], baseUrl) : null,
                        IV: attrs['IV'] || null
                    };
                }
            }

            if (line.startsWith('#EXT-X-MAP')) {
                const attrs = this.parseAttributes(line);
                if (attrs['URI']) {
                    initSegment = { url: this.resolveUrl(attrs['URI'], baseUrl), byteRange: null };
                    if (attrs['BYTERANGE']) {
                        const parts = attrs['BYTERANGE'].split('@');
                        const length = parseInt(parts[0], 10);
                        const offset = parts.length > 1 ? parseInt(parts[1], 10) : 0;
                        initSegment.byteRange = `bytes=${offset}-${offset + length - 1}`;
                    }
                }
            }

            if (line.startsWith('#EXTINF')) {
                const durationMatch = line.match(/#EXTINF:([\d.]+)/);
                const duration = durationMatch ? parseFloat(durationMatch[1]) : 0;
                let byteRangeHeader = null;
                let url = null;
                let j = i + 1;

                while (j < lines.length) {
                    const lookAhead = lines[j].trim();
                    if (lookAhead.startsWith('#EXT-X-BYTERANGE:')) {
                        const val = lookAhead.substring(17).trim();
                        const parts = val.split('@');
                        const length = parseInt(parts[0], 10);
                        if (parts.length > 1) {
                            currentByteOffset = parseInt(parts[1], 10);
                        }
                        byteRangeHeader = `bytes=${currentByteOffset}-${currentByteOffset + length - 1}`;
                        currentByteOffset += length;
                        j++;
                    } else if (lookAhead.startsWith('#')) {
                        if (lookAhead.startsWith('#EXTINF')) break;
                        j++;
                    } else if (lookAhead.length > 0) {
                        url = lookAhead;
                        break;
                    } else {
                        j++;
                    }
                }

                if (url) {
                    totalDuration += duration;
                    segments.push({
                        duration,
                        url: this.resolveUrl(url, baseUrl),
                        key: currentKey ? { ...currentKey } : null,
                        byteRange: byteRangeHeader
                    });
                    i = j;
                }
            }
        }

        return { type: 'media', segments, initSegment, totalDuration };
    }

    static parseAttributes(line) {
        const attrs = {};
        const colonIdx = line.indexOf(':');
        if (colonIdx < 0) return attrs;
        const str = line.substring(colonIdx + 1);
        const regex = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/gi;
        let match;
        while ((match = regex.exec(str)) !== null) {
            attrs[match[1].toUpperCase()] = match[2] !== undefined ? match[2] : match[3];
        }
        return attrs;
    }

    static resolveUrl(url, baseUrl) {
        if (!url) return url;
        url = url.trim();
        if (url.startsWith('http://') || url.startsWith('https://')) return url;
        try {
            return new URL(url, baseUrl).href;
        } catch (e) {
            return url;
        }
    }
}

// ─── Disk-Backed Segment Storage (OPFS with in-memory fallback) ─────────

class SegmentStorage {
    constructor(taskId) {
        this.taskId = taskId;
        this.useOpfs = false;
        this.opfsRoot = null;
        this.opfsWritable = null;
        this.opfsFileHandle = null;
        this.tempFileName = null;
        this.fallbackBuffers = [];
        this.totalBytesWritten = 0;
    }

    async init() {
        try {
            this.opfsRoot = await navigator.storage.getDirectory();
            this.tempFileName = `fs_dl_${this.taskId}.tmp`;
            this.opfsFileHandle = await this.opfsRoot.getFileHandle(this.tempFileName, { create: true });
            this.opfsWritable = await this.opfsFileHandle.createWritable();
            // Actively test write permissions
            await this.opfsWritable.write(new Uint8Array([0]));
            await this.opfsWritable.truncate(0);
            this.useOpfs = true;
        } catch (e) {
            this.useOpfs = false;
        }
    }

    async append(buffer) {
        if (!buffer || buffer.byteLength === 0) return;
        this.totalBytesWritten += buffer.byteLength;
        if (this.useOpfs) {
            await this.opfsWritable.write(buffer);
        } else {
            this.fallbackBuffers.push(buffer);
            if (!this.warnedOOM && this.totalBytesWritten > 250 * 1024 * 1024) {
                this.warnedOOM = true;
                const proceed = await CustomDialog.confirm("WARNING: Memory limit exceeded!\n\nYour browser is blocking disk writes (OPFS disabled). This download is consuming over 250MB of RAM and may crash the page if it continues.\n\nDo you want to continue downloading at your own risk?");
                if (!proceed) {
                    throw new Error("Aborted by user to prevent Memory/RAM exhaustion.");
                }
            }
        }
    }

    async finalize(mimeType) {
        if (this.useOpfs) {
            if (this.opfsWritable) {
                await this.opfsWritable.close();
                this.opfsWritable = null;
            }
            const file = await this.opfsFileHandle.getFile();
            return new Blob([file], { type: mimeType });
        }
        return new Blob(this.fallbackBuffers, { type: mimeType });
    }

    async dispose() {
        try {
            if (this.opfsWritable) {
                await this.opfsWritable.close().catch(() => {});
                this.opfsWritable = null;
            }
        } catch (e) {}
        try {
            if (this.useOpfs && this.opfsRoot && this.tempFileName) {
                await this.opfsRoot.removeEntry(this.tempFileName).catch(() => {});
            }
        } catch (e) {}
        this.fallbackBuffers.length = 0;
    }
}

// ─── Individual Download Task Controller ─────────────────────────────────

class DownloadTask {
    constructor(data, manager) {
        this.manager = manager;
        this.id = data.id || `dl_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

        let initialName = (data.name ? data.name.trim() : '').replace(/[\\/:*?"<>|]/g, '_');
        try {
            initialName = decodeURIComponent(initialName);
        } catch (e) {}

        this.url = data.selectedUrl || data.url;
        this.headers = data.headers || {};
        this.format = (data.format || '').toLowerCase();
        this.type = data.type || ((this.url && this.url.includes('.m3u8')) ? 'hls' : 'media');

        if (!this.format) {
            if (this.type === 'hls' || (this.url && this.url.includes('.m3u8'))) {
                this.format = 'm3u8';
            } else if (initialName.includes('.')) {
                this.format = initialName.split('.').pop().toLowerCase();
            } else {
                this.format = 'mp4';
            }
        }

        const isHls = (this.format === 'm3u8' || this.type === 'hls' || (this.url && this.url.includes('.m3u8')));
        const expectedExt = isHls ? '.mp4' : `.${this.format || 'mp4'}`;

        if (!initialName) {
            this.name = this.format === 'mp3' ? 'audio.mp3' : (isHls ? 'video.mp4' : `file.${this.format || 'bin'}`);
        } else {
            // Strip any .m3u8 / .m3u extension so it is never saved or uploaded as m3u8
            let clean = initialName.replace(/\.m3u8?$/i, '');
            const dotIdx = clean.lastIndexOf('.');
            if (dotIdx !== -1) {
                const curExt = clean.substring(dotIdx).toLowerCase();
                if (this.format === 'mp3' && (curExt === '.mp4' || curExt === '.m4a' || curExt === '.ts')) {
                    this.name = clean.substring(0, dotIdx) + '.mp3';
                } else if (isHls && (curExt === '.ts' || curExt === '.m4s' || curExt === '.bin')) {
                    this.name = clean.substring(0, dotIdx) + '.mp4';
                } else {
                    this.name = clean;
                }
            } else {
                this.name = clean + expectedExt;
            }
        }

        // Final enforcement: ONLY HLS video streams must always have .mp4 extension
        if (isHls && !this.name.toLowerCase().endsWith('.mp4') && !this.name.toLowerCase().endsWith('.mp3')) {
            this.name = this.name.replace(/\.[^.]+$/, '') + '.mp4';
        }

        this.resolution = data.selectedResolution || data.resolution || '';
        this.action = data.action || 'download';
        this.uploadService = data.uploadService || null;
        this.expectedSize = data.size || 0;
        this.telegramCaption = data.telegramCaption || data.caption || '';
        this.preFlightConfirmed = Boolean(data.preFlightConfirmed);

        this.state = 'INITIALIZING';
        this.totalSegments = 0;
        this.completedSegments = 0;
        this.totalSize = 0;
        this.speed = '0 KB/s';
        this.bytesSinceLastSample = 0;
        this.lastSampleTime = Date.now();
        this.startTime = 0;
        this.concurrency = 6;
        this.retries = 3;
        this.ruleId = 0;
        this.decryptionKeys = {};

        this.storage = null;
        this.segmentMap = {};
        this._pausePromise = null;
        this._pauseResolve = null;
        this.chromeDownloadId = null;

        this.dom = {};
        this.createCard();
        this.init();
    }

    getMimeType() {
        const fmt = (this.format || '').toLowerCase();
        const ext = (this.name ? this.name.split('.').pop() : '').toLowerCase();
        const target = fmt || ext;

        if (this.type === 'hls' || fmt === 'm3u8') {
            return target === 'mp3' ? 'audio/mpeg' : 'video/mp4';
        }

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

            // Disk Images & Binaries
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

        return mimeMap[target] || mimeMap[ext] || mimeMap[fmt] || 'application/octet-stream';
    }

    // ─── UI Card Creation ───────────────────────────────────────────────

    createCard() {
        const card = document.createElement('div');
        card.className = 'task-card';
        card.id = `task_${this.id}`;

        const isHls = this.type === 'hls' || this.format === 'm3u8';
        const formatLabel = isHls ? 'HLS' : (this.format || 'MEDIA').toUpperCase();
        const resDisplay = this.resolution
            ? `<span class="badge bg-info bg-opacity-10 text-primary border border-info border-opacity-25" style="font-size: 0.7rem;">${this.resolution}</span>`
            : '';

        card.innerHTML = `
            <div class="d-flex justify-content-between align-items-start gap-2 mb-2">
                <div class="d-flex align-items-center gap-2 overflow-hidden flex-grow-1">
                    <div class="rounded-circle p-2 bg-light text-primary d-flex align-items-center justify-content-center flex-shrink-0" style="width: 38px; height: 38px;">
                        <i class="bi bi-file-earmark-play-fill fs-5"></i>
                    </div>
                    <div class="overflow-hidden">
                        <h6 class="mb-0 fw-bold text-dark text-truncate task-title"></h6>
                        <div class="d-flex align-items-center gap-1.5 mt-0.5 flex-wrap">
                            <span class="badge bg-primary bg-opacity-10 text-primary border border-primary border-opacity-25" style="font-size: 0.7rem;">${formatLabel}</span>
                            ${resDisplay}
                            <span class="badge bg-primary font-monospace status-badge" style="font-size: 0.7rem;">STARTING</span>
                            <span class="badge bg-success bg-opacity-10 text-success border border-success border-opacity-25 storage-badge d-none" style="font-size: 0.65rem;"><i class="bi bi-hdd me-1"></i>Disk</span>
                        </div>
                    </div>
                </div>
                <div class="d-flex align-items-center gap-1.5 flex-shrink-0">
                    <button class="btn btn-sm btn-outline-warning pause-btn py-1 px-2" title="Pause"><i class="bi bi-pause-fill"></i></button>
                    <button class="btn btn-sm btn-outline-success resume-btn py-1 px-2 d-none" title="Resume"><i class="bi bi-play-fill"></i></button>
                    <button class="btn btn-sm btn-outline-danger cancel-btn py-1 px-2" title="Cancel"><i class="bi bi-x-lg"></i></button>
                    <button class="btn btn-sm btn-success save-again-btn py-1 px-2.5 d-none" title="Save File Again"><i class="bi bi-download me-1"></i> Save</button>
                </div>
            </div>
            <div class="progress mb-2">
                <div class="progress-bar progress-bar-striped progress-bar-animated" role="progressbar" style="width: 0%;"></div>
            </div>
            <div class="d-flex justify-content-between align-items-center small text-muted font-monospace stats-row">
                <span class="stats-left">
                    <span class="text-primary fw-bold progress-text">0%</span>
                    <span class="segments-text text-muted"> &bull; Initializing...</span>
                    <span class="size-text text-muted"> &bull; 0 MB</span>
                </span>
                <span class="speed-text fw-semibold text-dark">0 KB/s</span>
            </div>
            <div class="alert alert-success py-2 px-3 mt-2 mb-0 small d-none complete-alert d-flex align-items-center justify-content-between">
                <div class="d-flex align-items-center gap-2">
                    <i class="bi bi-check-circle-fill text-success fs-5"></i>
                    <div>
                        <strong class="d-block">Download Complete</strong>
                        <span class="text-muted" style="font-size: 0.75rem;">File saved to your downloads folder.</span>
                    </div>
                </div>
                <button class="btn btn-sm btn-outline-success save-btn-mini py-1 px-2.5">Save Again</button>
            </div>
            <div class="alert alert-danger py-2 px-3 mt-2 mb-0 small d-none error-alert d-flex align-items-center justify-content-between">
                <div class="d-flex align-items-center gap-2">
                    <i class="bi bi-exclamation-triangle-fill text-danger fs-5"></i>
                    <span class="error-text">Download failed.</span>
                </div>
            </div>
        `;

        this.dom = {
            card,
            title: card.querySelector('.task-title'),
            statusBadge: card.querySelector('.status-badge'),
            storageBadge: card.querySelector('.storage-badge'),
            pauseBtn: card.querySelector('.pause-btn'),
            resumeBtn: card.querySelector('.resume-btn'),
            cancelBtn: card.querySelector('.cancel-btn'),
            saveAgainBtn: card.querySelector('.save-again-btn'),
            progressBar: card.querySelector('.progress-bar'),
            progressText: card.querySelector('.progress-text'),
            segmentsText: card.querySelector('.segments-text'),
            sizeText: card.querySelector('.size-text'),
            speedText: card.querySelector('.speed-text'),
            completeAlert: card.querySelector('.complete-alert'),
            errorAlert: card.querySelector('.error-alert'),
            errorText: card.querySelector('.error-text'),
            saveBtnMini: card.querySelector('.save-btn-mini')
        };

        if (this.dom.title) {
            this.dom.title.textContent = this.name;
            this.dom.title.setAttribute('title', this.name);
        }

        this.dom.pauseBtn.onclick = () => this.pause();
        this.dom.resumeBtn.onclick = () => this.resume();
        this.dom.cancelBtn.onclick = () => this.cancel();
        this.dom.saveAgainBtn.onclick = () => this.saveAgain();
        this.dom.saveBtnMini.onclick = () => this.saveAgain();

        this.manager.addTaskElement(card);
    }

    // ─── Initialization ─────────────────────────────────────────────────

    async init() {
        try {
            this.dom.errorAlert.classList.add('d-none');
            this.dom.completeAlert.classList.add('d-none');
            this.dom.saveAgainBtn.classList.add('d-none');
            this.dom.pauseBtn.classList.remove('d-none');
            this.dom.resumeBtn.classList.add('d-none');
            this.dom.cancelBtn.classList.remove('d-none');

            try {
                const { options } = await chrome.storage.local.get(['options']);
                if (options) {
                    if (options.concurrency) this.concurrency = Math.min(16, Math.max(2, options.concurrency));
                    if (options.retries) this.retries = Math.min(5, Math.max(1, options.retries));
                }
            } catch (e) {}

            chrome.runtime.sendMessage({
                cmd: 'REGISTER_DOWNLOAD',
                parameter: { id: this.id, url: this.url, name: this.name, type: this.type, format: this.format, resolution: this.resolution }
            });

            this.state = 'DOWNLOADING';
            this.startTime = Date.now();
            this.lastSampleTime = Date.now();
            this.totalSize = 0;
            this.bytesSinceLastSample = 0;
            this.completedSegments = 0;
            this.segmentMap = {};

            this.dom.statusBadge.textContent = 'DOWNLOADING';
            this.dom.statusBadge.className = 'badge bg-primary font-monospace status-badge';

            // Initialize disk-backed storage
            this.storage = new SegmentStorage(this.id);
            await this.storage.init();

            if (this.storage.useOpfs) {
                this.dom.storageBadge.classList.remove('d-none');
            }

            if (this.type === 'hls' || this.format === 'm3u8' || this.format === 'm3u') {
                if (this.action === 'upload' && !this.preFlightConfirmed && typeof ServiceLimits !== 'undefined') {
                    const { options: curOpts } = await chrome.storage.local.get(['options']);
                    let estSize = ServiceLimits.estimateStreamSize({
                        type: this.type,
                        format: this.format,
                        url: this.url,
                        headers: this.headers,
                        duration: this.duration,
                        bandwidth: this.bandwidth
                    });
                    if (estSize <= 0 && ServiceLimits.probeStreamSize) {
                        try {
                            estSize = await ServiceLimits.probeStreamSize({
                                type: this.type,
                                format: this.format,
                                url: this.url,
                                headers: this.headers
                            });
                        } catch (e) {}
                    }
                    const report = ServiceLimits.check(estSize, this.uploadService, curOpts, false, { isHls: true, url: this.url });
                    if (report.hasWarnings && report.problematic.length > 0) {
                        const issue = report.problematic[0];
                        this.showError(`Upload limit notice (${issue.name}): ${issue.reason}`);
                        this.dom.statusBadge.textContent = 'LIMIT EXCEEDED';
                        this.dom.statusBadge.className = 'badge bg-danger font-monospace status-badge';
                        this.dom.pauseBtn.classList.add('d-none');
                        this.dom.resumeBtn.classList.add('d-none');
                        return;
                    }
                }
                await this.startHlsDownload();
            } else {
                if (this.action === 'upload' && !this.preFlightConfirmed && typeof ServiceLimits !== 'undefined') {
                    const { options: curOpts } = await chrome.storage.local.get(['options']);
                    const report = ServiceLimits.check(this.totalSize, this.uploadService, curOpts, false, { isHls: false, url: this.url });
                    if (report.hasWarnings && report.problematic.length > 0) {
                        const issue = report.problematic[0];
                        this.showError(`Upload limit notice (${issue.name}): ${issue.reason}`);
                        this.dom.statusBadge.textContent = 'LIMIT EXCEEDED';
                        this.dom.statusBadge.className = 'badge bg-danger font-monospace status-badge';
                        this.dom.pauseBtn.classList.add('d-none');
                        this.dom.resumeBtn.classList.add('d-none');
                        return;
                    }
                }
                await this.startDirectDownload();
            }
        } catch (err) {
            if (this.state !== 'CANCELLED') {
                this.showError(err.message || 'Download encountered an error.');
            }
        }
    }

    // ─── Pause/Resume Helpers ───────────────────────────────────────────

    async waitIfPaused() {
        while (this.state === 'PAUSED') {
            if (this._pausePromise) {
                await this._pausePromise;
            } else {
                await new Promise(r => setTimeout(r, 50));
            }
        }
    }

    // ─── HLS Stream Download (OPFS-backed) ──────────────────────────────

    async startHlsDownload() {
        await this.setupCorsRules(this.url, this.headers);

        const response = await this.fetchWithHeaders(this.url, this.headers);
        if (!response.ok) throw new Error(`HTTP ${response.status}: Failed to load playlist`);

        const text = await response.text();
        const parsed = HlsParser.parse(text, this.url);

        let mediaSegments = [];
        let initSegmentUrl = null;

        if (parsed.type === 'master') {
            if (!parsed.variants || parsed.variants.length === 0) {
                throw new Error('No stream variants found in master playlist.');
            }
            const targetVariant = parsed.variants[0];
            const variantRes = await this.fetchWithHeaders(targetVariant.url, this.headers);
            if (!variantRes.ok) throw new Error(`HTTP ${variantRes.status}: Failed to load media track`);
            const mediaText = await variantRes.text();
            const mediaParsed = HlsParser.parse(mediaText, targetVariant.url);
            mediaSegments = mediaParsed.segments;
            initSegmentUrl = mediaParsed.initSegment;
        } else {
            mediaSegments = parsed.segments;
            initSegmentUrl = parsed.initSegment;
        }

        if (!mediaSegments || mediaSegments.length === 0) {
            throw new Error('No media segments found in playlist.');
        }

        // Write initialization segment (fMP4) first
        if (initSegmentUrl) {
            try {
                const initBuffer = await this.fetchSegmentWithRetry(initSegmentUrl.url, null, this.headers, initSegmentUrl.byteRange);
                if (initBuffer) {
                    await this.storage.append(initBuffer);
                    this.totalSize += initBuffer.byteLength;
                }
            } catch (err) {
                console.warn('Init segment fetch failed:', err);
            }
        }

        const total = mediaSegments.length;
        this.totalSegments = total;
        this.completedSegments = 0;
        this.segmentMap = {};
        let nextFetchIndex = 0;

        // Worker: fetches segments in parallel, stores in segmentMap
        const worker = async () => {
            while (nextFetchIndex < total && this.state !== 'CANCELLED') {
                await this.waitIfPaused();
                if (this.state === 'CANCELLED') break;

                const index = nextFetchIndex++;
                if (index >= total) break;
                const seg = mediaSegments[index];

                try {
                    let buffer = await this.fetchSegmentWithRetry(seg.url, seg.key, this.headers, seg.byteRange);

                    if (seg.key && seg.key.METHOD === 'AES-128' && buffer) {
                        buffer = await this.decryptSegment(buffer, seg.key, index, this.headers);
                    }

                    this.segmentMap[index] = buffer || new ArrayBuffer(0);

                    if (buffer) {
                        this.totalSize += buffer.byteLength;
                        this.bytesSinceLastSample += buffer.byteLength;
                    }

                    this.completedSegments++;
                    this.calculateSpeed();
                    const pct = Math.min(99, Math.round((this.completedSegments / total) * 100));
                    this.updateProgress(pct, this.totalSize, this.completedSegments, total);
                } catch (err) {
                    this.segmentMap[index] = new ArrayBuffer(0);
                    this.completedSegments++;
                }
            }
        };

        // Flusher: writes segments to storage sequentially, frees RAM immediately
        const flusher = async () => {
            let nextFlushIndex = 0;
            while (nextFlushIndex < total && this.state !== 'CANCELLED') {
                if (nextFlushIndex in this.segmentMap) {
                    const buffer = this.segmentMap[nextFlushIndex];
                    if (buffer && buffer.byteLength > 0) {
                        await this.storage.append(buffer);
                    }
                    delete this.segmentMap[nextFlushIndex];
                    nextFlushIndex++;
                } else {
                    await new Promise(r => setTimeout(r, 25));
                }
            }
        };

        const poolSize = Math.min(this.concurrency, total);
        const workers = [];
        for (let i = 0; i < poolSize; i++) {
            workers.push(worker());
        }
        const flushPromise = flusher();

        await Promise.all(workers);
        await flushPromise;

        if (this.state === 'CANCELLED') return;

        this.updateProgress(100, this.totalSize, total, total);

        const file = await this.storage.finalize(this.getMimeType());
        await this.onDownloadComplete(file);
    }

    // ─── Direct Media Download (OPFS-backed) ────────────────────────────

    async startDirectDownload() {
        await this.setupCorsRules(this.url, this.headers);

        const response = await this.fetchWithHeaders(this.url, this.headers);
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

        const contentLength = parseInt(response.headers.get('content-length'), 10) || this.expectedSize || 0;
        const reader = response.body.getReader();
        let received = 0;

        while (true) {
            if (this.state === 'CANCELLED') {
                reader.cancel();
                return;
            }

            await this.waitIfPaused();

            const { done, value } = await reader.read();
            if (done) break;

            await this.storage.append(value);

            received += value.length;
            this.totalSize = received;
            this.bytesSinceLastSample += value.length;

            this.calculateSpeed();
            
            let pct = 0;
            if (contentLength > 0) {
                pct = Math.min(99, Math.round((received / contentLength) * 100));
            } else {
                pct = Math.min(95, Math.round((received / (received + 500000)) * 100)); 
            }
            
            this.updateProgress(pct, received, 1, 1);
        }

        if (this.state === 'CANCELLED') return;

        this.updateProgress(100, this.totalSize, 1, 1);

        const file = await this.storage.finalize(this.getMimeType());
        await this.onDownloadComplete(file);
    }

    // ─── Segment Fetch & AES-128 processing ─────────────────────────────

    async fetchSegmentWithRetry(url, keyInfo, headers, byteRange = null) {
        let attempts = 0;
        let lastError = null;

        while (attempts < this.retries) {
            if (this.state === 'CANCELLED') return null;
            try {
                const res = await this.fetchWithHeaders(url, headers, byteRange);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return await res.arrayBuffer();
            } catch (err) {
                attempts++;
                lastError = err;
                if (attempts < this.retries) {
                    await new Promise(r => setTimeout(r, 250 * attempts));
                }
            }
        }
        throw lastError || new Error(`Failed after ${this.retries} attempts`);
    }

    async decryptSegment(encryptedBuffer, keyInfo, seqNumber, headers) {
        try {
            if (!this.decryptionKeys[keyInfo.URI]) {
                const keyRes = await this.fetchWithHeaders(keyInfo.URI, headers);
                if (!keyRes.ok) throw new Error('Key fetch failed');
                this.decryptionKeys[keyInfo.URI] = await keyRes.arrayBuffer();
            }

            const rawKey = this.decryptionKeys[keyInfo.URI];
            const iv = new Uint8Array(16);
            if (keyInfo.IV) {
                const cleanIv = keyInfo.IV.replace(/^0x/i, '');
                for (let i = 0; i < 16; i++) {
                    iv[i] = parseInt(cleanIv.substr(i * 2, 2), 16) || 0;
                }
            } else {
                const view = new DataView(iv.buffer);
                view.setUint32(12, seqNumber);
            }

            const cryptoKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-CBC' }, false, ['decrypt']);
            return await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, encryptedBuffer);
        } catch (err) {
            return encryptedBuffer;
        }
    }

    // ─── Progress, Speed, and UI Updates ────────────────────────────────

    calculateSpeed() {
        const now = Date.now();
        const elapsed = (now - this.lastSampleTime) / 1000;
        if (elapsed >= 0.6) {
            const bytesPerSec = this.bytesSinceLastSample / elapsed;
            this.speed = this.formatSpeed(bytesPerSec);
            this.bytesSinceLastSample = 0;
            this.lastSampleTime = now;
        }
    }

    formatSpeed(bps) {
        if (bps < 1024) return `${bps.toFixed(0)} B/s`;
        if (bps < 1048576) return `${(bps / 1024).toFixed(1)} KB/s`;
        return `${(bps / 1048576).toFixed(2)} MB/s`;
    }

    formatBytes(bytes) {
        if (!bytes || bytes <= 0) return '0 MB';
        if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
        return `${(bytes / 1073741824).toFixed(2)} GB`;
    }

    updateProgress(percent, downloadedBytes, completed, total) {
        this.dom.progressBar.style.width = `${percent}%`;
        this.dom.progressText.textContent = `${percent}%`;
        this.dom.sizeText.textContent = ` \u2022 ${this.formatBytes(downloadedBytes)}`;
        if (total > 0) {
            this.dom.segmentsText.textContent = ` \u2022 ${completed}/${total} segs`;
        }
        this.dom.speedText.textContent = this.speed;

        this.broadcastProgress(percent, downloadedBytes, completed, total);
    }

    broadcastProgress(percent, downloadedBytes, completed, total) {
        chrome.runtime.sendMessage({
            cmd: 'UPDATE_DOWNLOAD_PROGRESS',
            parameter: {
                id: this.id,
                progress: percent || 0,
                speed: this.speed,
                downloadedBytes: downloadedBytes || this.totalSize,
                totalBytes: 0,
                completedSegments: completed || this.completedSegments,
                totalSegments: total || this.totalSegments,
                state: this.state.toLowerCase()
            }
        });
    }

    // ─── Completion & File Saving ───────────────────────────────────────

    async onDownloadComplete(fileOrBlob) {
        this.state = 'COMPLETED';
        this.cleanupCorsRules();

        this.dom.progressBar.style.width = '100%';
        this.dom.progressBar.className = 'progress-bar bg-success';
        this.dom.statusBadge.textContent = 'SAVING';
        this.dom.statusBadge.className = 'badge bg-warning text-dark font-monospace status-badge';
        this.dom.progressText.textContent = '100%';
        this.dom.speedText.textContent = 'Saving...';
        this.dom.sizeText.textContent = ` \u2022 ${this.formatBytes(this.totalSize)}`;
        if (this.totalSegments > 0) {
            this.dom.segmentsText.textContent = ` \u2022 ${this.totalSegments}/${this.totalSegments} segs`;
        }
        this.dom.pauseBtn.classList.add('d-none');
        this.dom.resumeBtn.classList.add('d-none');

        // Save the file reference for "Save Again" button
        this._completedFile = fileOrBlob;

        const isUploadAction = this.action === 'upload';
        let uploadResult = null;
        let finalUrl = '';
        let multiLinks = [];
        let effectiveService = null;

        try {
            const { options } = await chrome.storage.local.get(['options']);
            const uploadConfig = options?.upload || { service: 'local', credentials: {} };
            effectiveService = this.uploadService || (isUploadAction ? uploadConfig.service : (uploadConfig.service !== 'local' ? uploadConfig.service : null));
            if (effectiveService === 'custom') {
                effectiveService = (uploadConfig.customList && uploadConfig.customList.length > 0) ? uploadConfig.customList.join(',') : 'gofile.io';
            }

            if (effectiveService && effectiveService !== 'local') {
                this.state = 'UPLOADING';
                this.dom.statusBadge.textContent = 'UPLOADING';
                this.dom.statusBadge.className = 'badge bg-info text-dark font-monospace status-badge';
                this.dom.speedText.textContent = `Uploading to ${effectiveService}...`;

                // ---> VISUALLY RESET PROGRESS BAR FOR UPLOAD PHASE <---
                this.dom.progressBar.className = 'progress-bar progress-bar-striped progress-bar-animated bg-info';
                this.dom.progressBar.style.width = '0%';
                this.dom.progressText.textContent = '0% Uploaded';

                chrome.runtime.sendMessage({
                    cmd: 'UPDATE_DOWNLOAD_PROGRESS',
                    parameter: {
                        id: this.id,
                        progress: 0,
                        speed: `Uploading to ${effectiveService}...`,
                        state: 'uploading',
                        service: effectiveService
                    }
                });

                const activeConfig = {
                    service: effectiveService,
                    credentials: { ...(uploadConfig.credentials || {}) },
                    onLinkGenerated: (linkObj) => {
                        chrome.runtime.sendMessage({
                            cmd: 'UPLOAD_LINK_GENERATED',
                            parameter: { id: this.id, name: this.name, link: linkObj }
                        });
                    }
                };
                if (this.telegramCaption) {
                    activeConfig.credentials.caption = this.telegramCaption;
                    activeConfig.credentials.telegram = {
                        ...(activeConfig.credentials.telegram || {}),
                        caption: this.telegramCaption
                    };
                }

                uploadResult = await FetchStreamUploader.upload(fileOrBlob, this.name, activeConfig, (loaded, total) => {
                    if (total > 0) {
                        const pct = Math.round((loaded / total) * 100);
                        this.dom.progressBar.style.width = `${pct}%`;
                        this.dom.progressText.textContent = `${pct}% Uploaded`;
                        this.dom.speedText.textContent = `${this.formatBytes(loaded)} / ${this.formatBytes(total)}`;

                        chrome.runtime.sendMessage({
                            cmd: 'UPDATE_DOWNLOAD_PROGRESS',
                            parameter: {
                                id: this.id,
                                progress: pct,
                                speed: `${pct}% • ${this.formatBytes(loaded)} / ${this.formatBytes(total)}`,
                                state: 'uploading',
                                service: effectiveService,
                                downloadedBytes: loaded,
                                totalBytes: total
                            }
                        });
                    }
                });

                this.state = 'COMPLETED';
                this.dom.statusBadge.textContent = 'UPLOADED';
                this.dom.statusBadge.className = 'badge bg-success font-monospace status-badge';
                this.dom.progressBar.className = 'progress-bar bg-success';
                this.dom.speedText.textContent = 'Uploaded Successfully';

                finalUrl = typeof uploadResult === 'string' ? uploadResult : (uploadResult?.url || '');
                multiLinks = uploadResult?.links || [];

                if (finalUrl || multiLinks.length > 0) {
                    const isLink = finalUrl && finalUrl.startsWith('http');
                    this.dom.completeAlert.innerHTML = `
                        <div class="w-100">
                            <div class="d-flex justify-content-between align-items-center">
                                <div class="d-flex align-items-center gap-2 overflow-hidden me-2">
                                    <i class="bi bi-cloud-check-fill text-success fs-4 flex-shrink-0"></i>
                                    <div class="overflow-hidden">
                                        <strong class="d-block text-success">Upload Complete!</strong>
                                        <span class="text-truncate d-block text-muted font-monospace srv-final-url" style="font-size: 0.75rem;"></span>
                                    </div>
                                </div>
                                <div class="d-flex gap-1 flex-shrink-0 single-actions"></div>
                            </div>
                            <div class="multi-links-wrapper"></div>
                        </div>
                    `;
                    
                    const spanUrl = this.dom.completeAlert.querySelector('.srv-final-url');
                    spanUrl.textContent = finalUrl;
                    spanUrl.title = finalUrl;
                    
                    const actionsDiv = this.dom.completeAlert.querySelector('.single-actions');
                    if (isLink) {
                        const aOpen = document.createElement('a');
                        aOpen.href = finalUrl;
                        aOpen.target = "_blank";
                        aOpen.className = "btn btn-sm btn-outline-success py-1 px-2 text-decoration-none";
                        aOpen.innerHTML = '<i class="bi bi-box-arrow-up-right me-1"></i> Open';
                        actionsDiv.appendChild(aOpen);
                    }
                    if (finalUrl) {
                        const copyBtn = document.createElement('button');
                        copyBtn.className = "btn btn-sm btn-outline-secondary py-1 px-2 copy-upload-url-btn";
                        copyBtn.innerHTML = '<i class="bi bi-clipboard"></i> Copy';
                        actionsDiv.appendChild(copyBtn);
                    }
                    
                    if (multiLinks.length > 0) {
                        const wrapper = this.dom.completeAlert.querySelector('.multi-links-wrapper');
                        const linksDiv = document.createElement('div');
                        linksDiv.className = "mt-2 pt-2 border-top w-100";
                        linksDiv.innerHTML = `<span class="small fw-semibold text-muted d-block mb-1">Generated Links (${multiLinks.length} Services):</span><div class="d-flex flex-column gap-1 multi-links-list"></div>`;
                        const listDiv = linksDiv.querySelector('.multi-links-list');
                        multiLinks.forEach(l => {
                            const row = document.createElement('div');
                            row.className = "d-flex justify-content-between align-items-center gap-2 p-1 bg-light rounded border";
                            row.innerHTML = `
                                <span class="small text-truncate"><strong class="srv-name"></strong> <a target="_blank" class="srv-link"></a></span>
                                <button class="btn btn-xs btn-outline-secondary copy-sub-url-btn" style="font-size:0.7rem; padding: 2px 5px;">Copy</button>
                            `;
                            row.querySelector('.srv-name').textContent = l.service + ':';
                            const aEl = row.querySelector('.srv-link');
                            aEl.href = l.url;
                            aEl.textContent = l.url;
                            const copySubBtn = row.querySelector('.copy-sub-url-btn');
                            copySubBtn.setAttribute('data-url', l.url);
                            listDiv.appendChild(row);
                        });
                        wrapper.appendChild(linksDiv);
                    }

                    const copyBtn = this.dom.completeAlert.querySelector('.copy-upload-url-btn');
                    if (copyBtn) {
                        copyBtn.onclick = () => {
                            navigator.clipboard.writeText(finalUrl).then(() => {
                                copyBtn.innerHTML = '<i class="bi bi-check2"></i> Copied!';
                                setTimeout(() => copyBtn.innerHTML = '<i class="bi bi-clipboard"></i> Copy', 2000);
                            });
                        };
                    }

                    const subCopyBtns = this.dom.completeAlert.querySelectorAll('.copy-sub-url-btn');
                    subCopyBtns.forEach(btn => {
                        btn.onclick = () => {
                            navigator.clipboard.writeText(btn.getAttribute('data-url')).then(() => {
                                btn.innerHTML = '<i class="bi bi-check2"></i> Copied';
                                setTimeout(() => btn.innerHTML = 'Copy', 1500);
                            });
                        };
                    });
                }

                if (typeof HistoryManager !== 'undefined') {
                    HistoryManager.addRecord({
                        type: 'upload',
                        name: this.name,
                        size: this.totalSize,
                        service: effectiveService,
                        url: finalUrl,
                        links: multiLinks,
                        status: 'completed'
                    });
                }
            } else {
                // effectiveService is 'local' or not a remote upload service
                if (isUploadAction) {
                    this.state = 'FAILED';
                    this.lastError = 'Upload Destination Missing: Please select an upload destination (e.g. Telegram, GoFile, Buzzheavier) in Settings or from the stream card dropdown.';
                    this.dom.statusBadge.textContent = 'NO DESTINATION';
                    this.dom.statusBadge.className = 'badge bg-warning text-dark font-monospace status-badge';
                    this.dom.speedText.textContent = 'Upload cancelled - No destination selected';
                    this.dom.completeAlert.innerHTML = `
                        <div class="d-flex align-items-center gap-2 text-warning">
                            <i class="bi bi-exclamation-circle-fill fs-5 text-warning"></i>
                            <div>
                                <strong>Upload Destination Missing:</strong> Please select an upload destination (e.g. Telegram, GoFile, Buzzheavier) in Settings or from the stream card dropdown.
                            </div>
                        </div>
                    `;
                } else {
                    // Normal download action: save to local device
                    await this.triggerFileSave(fileOrBlob);
                    this.state = 'COMPLETED';
                    this.dom.statusBadge.textContent = 'COMPLETED';
                    this.dom.statusBadge.className = 'badge bg-success font-monospace status-badge';
                    this.dom.speedText.textContent = 'Saved to Device';

                    if (typeof HistoryManager !== 'undefined') {
                        HistoryManager.addRecord({
                            type: 'download',
                            name: this.name,
                            size: this.totalSize,
                            service: 'local',
                            url: '',
                            status: 'completed'
                        });
                    }
                }
            }
        } catch(e) {
            console.error("Upload Error:", e);
            this.state = 'FAILED';
            this.dom.statusBadge.textContent = 'UPLOAD FAILED';
            this.dom.statusBadge.className = 'badge bg-danger font-monospace status-badge';
            this.dom.speedText.textContent = 'Upload Failed';

            const errText = e.message || 'Error uploading file';
            this.lastError = errText;
            const isTgSizeLimit = errText.includes('50 MB') || errText.includes('Telegram');

            this.dom.completeAlert.innerHTML = `
                <div class="w-100">
                    <div class="d-flex align-items-start gap-2 text-danger mb-2">
                        <i class="bi bi-exclamation-triangle-fill fs-5 flex-shrink-0 mt-0.5"></i>
                        <div>
                            <strong class="d-block">Upload Failed:</strong>
                            <span class="text-dark small srv-err-text"></span>
                        </div>
                    </div>
                    <div class="d-flex gap-2 flex-wrap border-top pt-2 mt-2 align-items-center">
                        <button class="btn btn-sm btn-outline-secondary py-1 px-2.5 save-local-btn" style="font-size: 0.75rem;">
                            <i class="bi bi-download me-1"></i> Save to PC Instead
                        </button>
                        ${isTgSizeLimit ? `
                            <span class="small text-muted ms-auto" style="font-size: 0.72rem;">
                                <i class="bi bi-lightning-charge-fill text-warning me-1"></i> Tip: Use <strong>⚡ Server Upload</strong> for Telegram files up to 2 GB
                            </span>
                        ` : ''}
                    </div>
                </div>
            `;

            this.dom.completeAlert.querySelector('.srv-err-text').textContent = errText;
            // Give the user the choice to save locally if they wish, instead of forcing a popup
            const saveBtn = this.dom.completeAlert.querySelector('.save-local-btn');
            if (saveBtn) {
                saveBtn.onclick = async () => {
                    await this.triggerFileSave(fileOrBlob);
                    saveBtn.innerHTML = '<i class="bi bi-check2 text-success"></i> Saved to PC';
                    saveBtn.disabled = true;
                };
            }

            if (typeof HistoryManager !== 'undefined') {
                HistoryManager.addRecord({
                    type: 'upload',
                    name: this.name,
                    size: this.totalSize,
                    service: effectiveService || 'unknown',
                    url: '',
                    status: 'failed',
                    details: errText
                });
            }
        }

        this.dom.saveAgainBtn.classList.remove('d-none');
        this.dom.cancelBtn.classList.add('d-none');
        this.dom.completeAlert.classList.remove('d-none');

        chrome.runtime.sendMessage({
            cmd: 'DOWNLOAD_FINISHED',
            parameter: {
                id: this.id,
                name: this.name,
                url: this.url,
                finalUrl: finalUrl,
                multiLinks: multiLinks,
                service: effectiveService,
                state: this.state,
                status: this.state,
                isUploadAction: isUploadAction,
                error: (this.state === 'FAILED' ? (this.lastError || 'Upload failed') : null)
            }
        });
        this.manager.updateGlobalStatus();
    }

    async triggerFileSave(fileOrBlob) {
        const blobUrl = URL.createObjectURL(fileOrBlob);

        try {
            const downloadId = await new Promise((resolve, reject) => {
                chrome.downloads.download({
                    url: blobUrl,
                    filename: this.name,
                    saveAs: false
                }, (id) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                    } else {
                        resolve(id);
                    }
                });
            });

            this.chromeDownloadId = downloadId;

            // Listen for Chrome to finish writing the file, then clean up
            const onChanged = (delta) => {
                if (delta.id !== downloadId) return;
                if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
                    chrome.downloads.onChanged.removeListener(onChanged);
                    setTimeout(() => {
                        URL.revokeObjectURL(blobUrl);
                        if (this.storage && typeof this.storage.dispose === 'function') {
                            this.storage.dispose().catch(()=>{});
                        }
                        this._completedFile = null;
                        this.storage = null;
                    }, 5000);
                }
            };
            chrome.downloads.onChanged.addListener(onChanged);

        } catch (e) {
            // Fallback: DOM anchor click
            try {
                const a = document.createElement('a');
                a.style.display = 'none';
                a.href = blobUrl;
                a.download = this.name;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                    a.remove();
                    URL.revokeObjectURL(blobUrl);
                    if (this.storage && typeof this.storage.dispose === 'function') {
                        this.storage.dispose().catch(()=>{});
                    }
                    this._completedFile = null;
                    this.storage = null;
                }, 30000);
            } catch (anchorErr) {
                console.warn('All save methods failed:', anchorErr);
            }
        }
    }

    async saveAgain() {
        if (this._completedFile) {
            await this.triggerFileSave(this._completedFile);
        } else if (this.storage) {
            try {
                const file = await this.storage.finalize(this.getMimeType());
                await this.triggerFileSave(file);
            } catch (e) {
                console.warn('Cannot re-save, file already cleaned up.');
            }
        }
    }

    // ─── State Management ───────────────────────────────────────────────

    pause() {
        if (this.state !== 'DOWNLOADING') return;
        this.state = 'PAUSED';
        this._pausePromise = new Promise(r => { this._pauseResolve = r; });

        this.dom.statusBadge.textContent = 'PAUSED';
        this.dom.statusBadge.className = 'badge bg-warning text-dark font-monospace status-badge';
        this.dom.progressBar.className = 'progress-bar bg-warning';
        this.dom.pauseBtn.classList.add('d-none');
        this.dom.resumeBtn.classList.remove('d-none');
        this.dom.speedText.textContent = 'Paused';

        this.broadcastProgress();
        this.manager.updateGlobalStatus();
    }

    resume() {
        if (this.state !== 'PAUSED') return;
        this.state = 'DOWNLOADING';

        if (this._pauseResolve) {
            this._pauseResolve();
            this._pauseResolve = null;
        }
        this._pausePromise = null;

        this.dom.statusBadge.textContent = 'DOWNLOADING';
        this.dom.statusBadge.className = 'badge bg-primary font-monospace status-badge';
        this.dom.progressBar.className = 'progress-bar progress-bar-striped progress-bar-animated';
        this.dom.resumeBtn.classList.add('d-none');
        this.dom.pauseBtn.classList.remove('d-none');
        this.lastSampleTime = Date.now();
        this.bytesSinceLastSample = 0;

        this.broadcastProgress();
        this.manager.updateGlobalStatus();
    }

    async cancel() {
        this.state = 'CANCELLED';
        this.cleanupCorsRules();

        if (this._pauseResolve) {
            this._pauseResolve();
            this._pauseResolve = null;
        }
        this._pausePromise = null;

        chrome.runtime.sendMessage({ cmd: 'CANCEL_DOWNLOAD', parameter: { id: this.id } });

        if (this.storage) {
            await this.storage.dispose();
            this.storage = null;
        }

        this.dom.card.remove();
        this.manager.removeTask(this.id);
    }

    showError(msg) {
        this.state = 'ERROR';
        this.cleanupCorsRules();

        if (this.storage) {
            this.storage.dispose().catch(() => {});
        }

        this.dom.statusBadge.textContent = 'FAILED';
        this.dom.statusBadge.className = 'badge bg-danger font-monospace status-badge';
        this.dom.progressBar.className = 'progress-bar bg-danger';
        this.dom.errorText.textContent = msg || 'Download failed';
        this.dom.errorAlert.classList.remove('d-none');
        this.dom.pauseBtn.classList.add('d-none');
        this.dom.resumeBtn.classList.add('d-none');

        this.broadcastProgress();
        this.manager.updateGlobalStatus();
    }

    // ─── Network & CORS ─────────────────────────────────────────────────

    async setupCorsRules(url, headers) {
        try {
            const targetUrl = new URL(url);
            const domain = targetUrl.hostname;
            const requestHeaders = [];
            const responseHeaders = [
                { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
                { header: 'Access-Control-Expose-Headers', operation: 'set', value: 'Content-Length, Content-Range' }
            ];

            let hasOrigin = false;
            let hasReferer = false;

            if (headers && Object.keys(headers).length > 0) {
                for (const [name, value] of Object.entries(headers)) {
                    const lower = name.toLowerCase();
                    if (['referer', 'origin', 'cookie', 'user-agent'].includes(lower)) {
                        requestHeaders.push({ header: name, operation: 'set', value });
                        if (lower === 'origin') hasOrigin = true;
                        if (lower === 'referer') hasReferer = true;
                    }
                }
            }

            if (!hasOrigin) {
                requestHeaders.push({ header: 'Origin', operation: 'set', value: targetUrl.origin });
            }
            if (!hasReferer) {
                requestHeaders.push({ header: 'Referer', operation: 'set', value: targetUrl.origin + '/' });
            }

            const ruleObject = {
                priority: 1,
                action: { 
                    type: 'modifyHeaders', 
                    requestHeaders: requestHeaders,
                    responseHeaders: responseHeaders 
                },
                condition: { urlFilter: `||${domain}`, resourceTypes: ['xmlhttprequest', 'media', 'other'] }
            };

            await new Promise(resolve => {
                chrome.runtime.sendMessage({ cmd: 'SET_RULES', parameter: { ruleObject, ruleId: 0 } }, id => {
                    this.ruleId = id || 0;
                    resolve();
                });
            });
        } catch (e) {}
    }

    cleanupCorsRules() {
        if (this.ruleId > 0) {
            chrome.runtime.sendMessage({ cmd: 'REMOVE_RULES', parameter: { ruleId: this.ruleId } });
            this.ruleId = 0;
        }
    }

    async fetchWithHeaders(url, headers, byteRange = null) {
        const fetchHeaders = {};
        if (headers) {
            for (const [k, v] of Object.entries(headers)) {
                // Do not attach restricted headers directly to fetch; DNR handles them securely
                if (!['range', 'content-length', 'host', 'connection', 'cookie', 'origin', 'referer', 'user-agent'].includes(k.toLowerCase())) {
                    fetchHeaders[k] = v;
                }
            }
        }
        if (byteRange) {
            fetchHeaders['Range'] = byteRange;
        }
        
        return fetch(url, { 
            headers: fetchHeaders, 
            credentials: 'include' // Ensures session cookies are sent for strict servers
        });
    }
}

// ─── Server-Side Upload Task (Cloud Runner) ─────────────────────────────

class ServerUploadTask {
    constructor(data, manager) {
        this.manager = manager;
        this.id = data.id || `srv_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        this.data = { ...data };
        this.mediaUrl = data.mediaUrl || data.url;
        this.url = data.uploadedUrl || (data.url && !data.url.includes('.m3u8') ? data.url : '');
        this.name = data.name || 'Media File';
        this.service = data.service || 'gofile.io';
        this.credentials = { ...(data.credentials || {}) };
        if (data.telegramCaption) {
            this.credentials.caption = data.telegramCaption;
            this.credentials.telegram = {
                ...(this.credentials.telegram || {}),
                caption: data.telegramCaption
            };
        }
        this.headers = data.headers || {};
        this.type = data.type || 'direct';
        this.format = data.format || 'mp4';
        this.resolution = data.resolution || null;
        this.serverConfig = data.serverConfig || {};
        this.relayUrl = (this.serverConfig.relayUrl || '').trim().replace(/\/+$/, '');

        this.state = data.status || 'STARTING';
        this.progress = data.progress !== undefined ? data.progress : 5;
        this.stage = data.stage || 'STARTING';
        this.speed = data.speed || 'Connecting to Cloud Runner...';
        this.isPaused = false;
        this.abortController = null;

        this.dom = {};
        this.createCard();

        if (data.status === 'COMPLETED' || data.stage === 'COMPLETED') {
            this.renderCompleted(data);
        } else if (data.status === 'FAILED' || data.stage === 'FAILED') {
            this.renderFailed(data.error || 'Server upload failed');
        } else if (data.status === 'CANCELLED' || data.stage === 'CANCELLED') {
            this.cancel();
        } else if (this.mediaUrl && this.state !== 'COMPLETED' && this.state !== 'CANCELLED' && this.state !== 'FAILED') {
            this.start();
        }
    }

    createCard() {
        const card = document.createElement('div');
        card.className = 'task-card';
        card.id = `server_task_${this.id}`;
        card.style.borderColor = '#ddd6fe';

        const serviceName = this.manager.getServiceDisplayName(this.service);
        const fileName = this.name;

        card.innerHTML = `
            <div class="d-flex justify-content-between align-items-start gap-2 mb-2">
                <div class="d-flex align-items-center gap-2 overflow-hidden flex-grow-1">
                    <div class="rounded-circle p-2 d-flex align-items-center justify-content-center flex-shrink-0" style="width: 38px; height: 38px; background: #f5f3ff; color: #7c3aed;">
                        <i class="bi bi-hdd-network-fill fs-5"></i>
                    </div>
                    <div class="overflow-hidden">
                        <h6 class="mb-0 fw-bold text-dark text-truncate task-title"></h6>
                        <div class="d-flex align-items-center gap-1.5 mt-0.5 flex-wrap">
                            <span class="badge font-monospace" style="font-size: 0.7rem; background: #ede9fe; color: #6d28d9; border: 1px solid #ddd6fe;">
                                <i class="bi bi-lightning-charge-fill me-0.5"></i> CLOUD RUNNER
                            </span>
                            <span class="badge bg-light text-secondary border" style="font-size: 0.7rem;">0 MB Local</span>
                            <span class="badge bg-secondary font-monospace status-badge" style="font-size: 0.7rem;">STARTING</span>
                            <span class="badge bg-primary bg-opacity-10 text-primary border border-primary border-opacity-25" style="font-size: 0.7rem;">${serviceName}</span>
                        </div>
                    </div>
                </div>
                <div class="d-flex align-items-center gap-1.5 flex-shrink-0">
                    <button class="btn btn-sm btn-outline-warning pause-btn py-1 px-2" title="Pause Tracking"><i class="bi bi-pause-fill"></i></button>
                    <button class="btn btn-sm btn-outline-success resume-btn py-1 px-2 d-none" title="Resume Tracking"><i class="bi bi-play-fill"></i></button>
                    <button class="btn btn-sm btn-outline-danger cancel-btn py-1 px-2" title="Cancel Server Upload"><i class="bi bi-x-lg"></i></button>
                    <button class="btn btn-sm btn-outline-secondary dismiss-btn py-1 px-2 d-none" title="Dismiss"><i class="bi bi-trash3"></i></button>
                </div>
            </div>
            <div class="progress mb-2" style="height: 8px;">
                <div class="progress-bar progress-bar-striped progress-bar-animated" role="progressbar" style="width: 5%; background: linear-gradient(90deg, #7c3aed 0%, #a855f7 100%);"></div>
            </div>
            <div class="d-flex justify-content-between align-items-center small text-muted font-monospace stats-row">
                <span class="stats-left">
                    <span class="fw-bold progress-text" style="color: #7c3aed;">5%</span>
                    <span class="stage-text text-muted"> &bull; Initializing cloud worker...</span>
                </span>
                <span class="speed-text fw-semibold text-dark">Starting...</span>
            </div>
            <div class="alert alert-success py-2 px-3 mt-2 mb-0 small d-none complete-alert">
                <div class="d-flex align-items-center justify-content-between mb-1.5">
                    <div class="d-flex align-items-center gap-2">
                        <i class="bi bi-check-circle-fill text-success fs-5"></i>
                        <div>
                            <strong class="d-block text-dark">Server Upload Complete</strong>
                            <span class="text-muted" style="font-size: 0.74rem;">Uploaded directly from server to destination cloud.</span>
                        </div>
                    </div>
                </div>
                <div class="links-container d-flex flex-column gap-1 mt-1 pt-1 border-top"></div>
            </div>
            <div class="alert alert-danger py-2 px-3 mt-2 mb-0 small d-none error-alert">
                <div class="d-flex align-items-center justify-content-between gap-2 flex-wrap">
                    <div class="d-flex align-items-center gap-2">
                        <i class="bi bi-exclamation-triangle-fill text-danger fs-5 flex-shrink-0"></i>
                        <span class="error-text">Server upload failed.</span>
                    </div>
                    <button class="btn btn-xs btn-outline-danger py-1 px-2.5 flex-shrink-0 srv-save-local-btn" style="font-size: 0.75rem;">
                        <i class="bi bi-download me-1"></i> Save to PC Instead
                    </button>
                </div>
            </div>
        `;

        this.dom = {
            card,
            title: card.querySelector('.task-title'),
            statusBadge: card.querySelector('.status-badge'),
            pauseBtn: card.querySelector('.pause-btn'),
            resumeBtn: card.querySelector('.resume-btn'),
            cancelBtn: card.querySelector('.cancel-btn'),
            dismissBtn: card.querySelector('.dismiss-btn'),
            progressBar: card.querySelector('.progress-bar'),
            progressText: card.querySelector('.progress-text'),
            stageText: card.querySelector('.stage-text'),
            speedText: card.querySelector('.speed-text'),
            completeAlert: card.querySelector('.complete-alert'),
            linksContainer: card.querySelector('.links-container'),
            errorAlert: card.querySelector('.error-alert'),
            errorText: card.querySelector('.error-text'),
            saveLocalBtn: card.querySelector('.srv-save-local-btn'),
            serviceName: card.querySelector('.task-service-name')
        };
        
        this.dom.title.textContent = this.name;
        this.dom.title.title = this.name;
        if (this.dom.serviceName) {
            this.dom.serviceName.textContent = serviceName;
        }

        this.dom.pauseBtn.onclick = () => this.pause();
        this.dom.resumeBtn.onclick = () => this.resume();
        this.dom.cancelBtn.onclick = () => this.cancel();
        this.dom.dismissBtn.onclick = () => this.dismiss();
        if (this.dom.saveLocalBtn) {
            this.dom.saveLocalBtn.onclick = () => {
                if (this.url) {
                    this.manager.addTask({
                        url: this.url,
                        name: this.name,
                        type: this.type,
                        format: this.format,
                        resolution: this.resolution,
                        headers: this.headers,
                        action: 'download',
                        service: 'local'
                    });
                    this.dismiss();
                }
            };
        }

        this.manager.addTaskElement(card);
    }

    async start() {
        this.state = 'RUNNING';
        this.abortController = new AbortController();

        const { options } = await chrome.storage.local.get(['options']);
        const session = await chrome.storage.session.get('fs_vault_unlocked');
        let vaultServerConfig = {};
        if (session?.fs_vault_unlocked) {
            vaultServerConfig = {
                relayUrl: session.fs_vault_unlocked.serverRelayUrl,
                apiKey: session.fs_vault_unlocked.serverApiKey,
                useFallbackProxy: session.fs_vault_unlocked.useFallbackProxy !== false
            };
        }
        
        const serverConfig = this.serverConfig && Object.keys(this.serverConfig).length ? this.serverConfig : vaultServerConfig;
        const relayUrl = (this.relayUrl || serverConfig.relayUrl || '').trim().replace(/\/+$/, '');

        if (!relayUrl) {
            this.renderFailed('Remote Server URL is not configured. Please set your server URL in the Vault.');
            return;
        }

        // Proactively gather cookies for target media domain if missing
        if (chrome.cookies && (!this.headers['Cookie'] && !this.headers['cookie'])) {
            try {
                const targetMediaUrl = this.mediaUrl || this.url;
                const targetObj = new URL(targetMediaUrl);
                const hostParts = targetObj.hostname.split('.');
                const apexDomain = hostParts.length >= 2 ? hostParts.slice(-2).join('.') : targetObj.hostname;

                const allTabs = await new Promise(r => chrome.tabs.query({}, r));
                const matchingTabs = (allTabs || []).filter(t => t.url && (t.url.includes(apexDomain) || t.url.includes(targetObj.hostname)));
                const allCookies = [];

                try {
                    const fullJar = await chrome.cookies.getAll({});
                    if (fullJar && fullJar.length) {
                        const matched = fullJar.filter(c => {
                            if (!c.domain) return false;
                            const d = c.domain.replace(/^\./, '').toLowerCase();
                            return d === apexDomain || d.endsWith(`.${apexDomain}`) || targetObj.hostname.endsWith(d);
                        });
                        allCookies.push(...matched);
                    }
                } catch (e) {}

                try {
                    const urlCookies = await chrome.cookies.getAll({ url: targetMediaUrl });
                    if (urlCookies && urlCookies.length) allCookies.push(...urlCookies);
                } catch (e) {}

                for (const mt of matchingTabs) {
                    try {
                        const tabCookies = await chrome.cookies.getAll({ url: mt.url });
                        if (tabCookies && tabCookies.length) allCookies.push(...tabCookies);
                    } catch (e) {}
                }

                if (allCookies.length > 0) {
                    const cookieMap = new Map();
                    allCookies.forEach(c => cookieMap.set(c.name, c.value));
                    this.headers['Cookie'] = Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
                }

                const pageOrigin = matchingTabs[0] ? new URL(matchingTabs[0].url).origin : `https://${targetObj.hostname}`;
                const pageUrl = matchingTabs[0] ? matchingTabs[0].url : `https://${targetObj.hostname}/`;
                if (!this.headers['Origin'] || this.headers['Origin'].includes('chrome-extension://')) {
                    this.headers['Origin'] = pageOrigin;
                }
                if (!this.headers['Referer'] || this.headers['Referer'].includes('chrome-extension://')) {
                    this.headers['Referer'] = pageUrl;
                }
            } catch (cErr) {
                console.warn('[FetchStream Downloader] Cookie gathering notice:', cErr);
            }
        }

        this.dom.errorAlert.classList.add('d-none');
        this.dom.completeAlert.classList.add('d-none');
        this.dom.cancelBtn.classList.remove('d-none');
        this.dom.pauseBtn.classList.remove('d-none');
        this.dom.resumeBtn.classList.add('d-none');
        this.dom.dismissBtn.classList.add('d-none');
        this.dom.progressBar.classList.add('progress-bar-animated', 'progress-bar-striped');
        this.dom.progressBar.style.background = 'linear-gradient(90deg, #7c3aed 0%, #a855f7 100%)';

        this.updateProgress({ progress: 5, stage: 'STARTING', status: 'RUNNING', speed: 'Connecting to Cloud Runner...' });

        try {
            const res = await FetchStreamUploader.dispatchServerUpload({
                id: this.id,
                url: this.mediaUrl || this.url,
                name: this.name,
                type: this.type,
                format: this.format,
                resolution: this.resolution,
                headers: this.headers,
                service: this.service,
                credentials: this.credentials,
                isDispatched: Boolean(this.data?.isDispatched || this.isDispatched),
                signal: this.abortController.signal
            }, serverConfig, (prog) => {
                if (this.isPaused) return;
                this.updateProgress(prog);
            });

            this.renderCompleted(res);
        } catch (err) {
            if (this.state === 'CANCELLED' || this.abortController?.signal?.aborted) {
                return;
            }
            this.renderFailed(err.message || 'Server upload failed');
        }
    }

    pause() {
        this.isPaused = true;
        this.state = 'PAUSED';
        this.dom.statusBadge.textContent = 'PAUSED';
        this.dom.statusBadge.className = 'badge bg-warning text-dark font-monospace status-badge';
        this.dom.statusBadge.style.background = '';
        this.dom.progressBar.classList.remove('progress-bar-animated', 'progress-bar-striped');
        this.dom.pauseBtn.classList.add('d-none');
        this.dom.resumeBtn.classList.remove('d-none');
        this.dom.speedText.textContent = 'Paused';
        this.manager.updateGlobalStatus();
    }

    resume() {
        this.isPaused = false;
        this.state = 'RUNNING';
        this.dom.statusBadge.textContent = this.stage || 'RUNNING';
        this.dom.statusBadge.className = 'badge font-monospace status-badge text-white';
        this.dom.statusBadge.style.background = '#7c3aed';
        this.dom.progressBar.classList.add('progress-bar-animated', 'progress-bar-striped');
        this.dom.resumeBtn.classList.add('d-none');
        this.dom.pauseBtn.classList.remove('d-none');
        this.manager.updateGlobalStatus();
    }

    async cancel(notifyServer = true) {
        if (this.state === 'CANCELLED' || this._isCancelling) return;
        this._isCancelling = true;
        this.state = 'CANCELLED';
        if (this.abortController) {
            try { this.abortController.abort(); } catch (e) {}
        }

        if (notifyServer) {
            const session = await chrome.storage.session.get('fs_vault_unlocked');
            let vaultServerConfig = {};
            if (session?.fs_vault_unlocked) {
                vaultServerConfig = {
                    relayUrl: session.fs_vault_unlocked.serverRelayUrl,
                    apiKey: session.fs_vault_unlocked.serverApiKey,
                    useFallbackProxy: session.fs_vault_unlocked.useFallbackProxy !== false
                };
            }
            const serverConfig = this.serverConfig && Object.keys(this.serverConfig).length ? this.serverConfig : vaultServerConfig;
            const relayUrl = (this.relayUrl || serverConfig.relayUrl || '').trim().replace(/\/+$/, '');

            if (relayUrl) {
                try {
                    const reqHeaders = { 'Content-Type': 'application/json' };
                    if (serverConfig.apiKey) {
                        reqHeaders['Authorization'] = `Bearer ${serverConfig.apiKey}`;
                        reqHeaders['X-API-Key'] = serverConfig.apiKey;
                    }
                    await fetch(`${relayUrl}/api/server-cancel?jobId=${encodeURIComponent(this.id)}`, {
                        method: 'POST',
                        headers: reqHeaders,
                        body: JSON.stringify({ jobId: this.id })
                    });
                } catch (err) {
                    console.warn('[FetchStream] Error contacting server-cancel:', err);
                }
            }
        }

        this.dom.statusBadge.textContent = 'CANCELLED';
        this.dom.statusBadge.className = 'badge bg-secondary font-monospace status-badge';
        this.dom.statusBadge.style.background = '';
        this.dom.progressBar.classList.remove('progress-bar-animated', 'progress-bar-striped');
        this.dom.progressBar.style.background = '#94a3b8';
        this.dom.pauseBtn.classList.add('d-none');
        this.dom.resumeBtn.classList.add('d-none');
        this.dom.cancelBtn.classList.add('d-none');
        this.dom.dismissBtn.classList.remove('d-none');

        this.dom.errorAlert.classList.remove('d-none');
        this.dom.errorText.textContent = 'Server upload cancelled by user.';

        chrome.runtime.sendMessage({
            cmd: 'SERVER_UPLOAD_FINISHED',
            parameter: { id: this.id, status: 'CANCELLED' }
        });

        this.manager.updateGlobalStatus();
    }

    dismiss() {
        this.dom.card.remove();
        this.manager.serverTasks.delete(this.id);
        this.manager.updateGlobalStatus();
    }

    updateProgress(prog, fromRemote = false) {
        if (!prog) return;
        if (this.state === 'CANCELLED') return;
        if (prog.status === 'CANCELLED' || prog.stage === 'CANCELLED') {
            this.state = 'CANCELLED';
            if (this.abortController) {
                try { this.abortController.abort(); } catch (e) {}
            }
            this.dom.statusBadge.textContent = 'CANCELLED';
            this.dom.statusBadge.className = 'badge bg-secondary font-monospace status-badge';
            this.dom.statusBadge.style.background = '';
            this.dom.progressBar.classList.remove('progress-bar-animated', 'progress-bar-striped');
            this.dom.progressBar.style.background = '#94a3b8';
            this.dom.pauseBtn.classList.add('d-none');
            this.dom.resumeBtn.classList.add('d-none');
            this.dom.cancelBtn.classList.add('d-none');
            this.dom.dismissBtn.classList.remove('d-none');
            this.dom.errorAlert.classList.remove('d-none');
            this.dom.errorText.textContent = 'Server upload cancelled by user.';
            this.manager.updateGlobalStatus();
            return;
        }

        const newProg = Math.max(0, Math.min(100, prog.progress !== undefined ? prog.progress : this.progress));
        const hasProgChanged = Math.abs(newProg - this.progress) >= 0.5 || prog.stage !== this.stage || prog.status !== this.state;

        this.progress = newProg;
        this.stage = prog.stage || this.stage;
        this.speed = prog.speed || this.speed;
        this.state = prog.status || this.state;

        this.dom.progressBar.style.width = `${this.progress}%`;
        this.dom.progressText.textContent = `${Math.round(this.progress)}%`;
        if (this.stage) this.dom.stageText.textContent = ` • ${this.stage}`;
        if (this.speed) this.dom.speedText.textContent = this.speed;

        const activeLinks = Array.isArray(prog?.links) 
            ? prog.links.filter(l => l.url && !l.url.includes('.m3u8')) 
            : ((prog?.url && !prog.url.includes('.m3u8')) ? [{ service: this.service, url: prog.url }] : []);

        if (activeLinks.length > 0 && this.state !== 'FAILED') {
            this.dom.completeAlert.classList.remove('d-none');
            this.dom.linksContainer.innerHTML = '';
            activeLinks.forEach(lnk => {
                const row = document.createElement('div');
                row.className = 'd-flex align-items-center justify-content-between gap-2 p-1 rounded bg-white border';
                const svcLabel = this.manager.getServiceDisplayName(lnk.service) || lnk.service || 'Mirror';
                row.innerHTML = `
                    <div class="d-flex align-items-center gap-1.5 overflow-hidden">
                        <span class="badge bg-light text-dark border" style="font-size: 0.68rem;">${svcLabel}</span>
                        <a href="${lnk.url}" target="_blank" class="text-truncate text-primary small text-decoration-none" style="font-size: 0.76rem;" title="${lnk.url}">${lnk.url}</a>
                    </div>
                    <button class="btn btn-xs btn-outline-primary py-0 px-2 flex-shrink-0" style="font-size: 0.72rem;"><i class="bi bi-clipboard me-0.5"></i> Copy</button>
                `;
                row.querySelector('button').onclick = () => {
                    navigator.clipboard.writeText(lnk.url);
                    row.querySelector('button').textContent = 'Copied!';
                    setTimeout(() => { row.querySelector('button').innerHTML = '<i class="bi bi-clipboard me-0.5"></i> Copy'; }, 2000);
                };
                this.dom.linksContainer.appendChild(row);
            });

            // Incremental real-time history recording
            if (!this._recordedHistoryLinks) this._recordedHistoryLinks = new Set();
            if (typeof HistoryManager !== 'undefined' && HistoryManager.addRecord) {
                activeLinks.forEach(lnk => {
                    const key = `${this.id}_${lnk.url}`;
                    if (!this._recordedHistoryLinks.has(key)) {
                        this._recordedHistoryLinks.add(key);
                        const svcName = this.manager.getServiceDisplayName(lnk.service) || lnk.service;
                        HistoryManager.addRecord({
                            id: `${this.id}_${lnk.service || 'host'}`,
                            jobId: this.id,
                            type: 'upload',
                            name: this.name,
                            size: prog.fileSize || this.data.size || 0,
                            service: `Server (${svcName})`,
                            url: lnk.url,
                            links: [lnk],
                            status: 'completed'
                        });
                    }
                });
            }
        }

        if (this.state === 'COMPLETED') {
            const hasValidLink = (prog?.url && !prog.url.includes('.m3u8')) ||
                                 (Array.isArray(prog?.links) && prog.links.some(l => l.url && !l.url.includes('.m3u8')));
            if (hasValidLink) {
                this.renderCompleted(prog);
            }
            return;
        }
        if (this.state === 'FAILED') {
            this.renderFailed(prog.error || prog.speed || 'Server upload failed');
            return;
        }

        this.dom.statusBadge.textContent = this.stage || this.state;
        this.dom.statusBadge.className = 'badge font-monospace status-badge text-white';
        this.dom.statusBadge.style.background = '#7c3aed';

        if (!fromRemote && hasProgChanged) {
            this.broadcastProgress(prog);
        }
        this.manager.updateGlobalStatus();
    }

    broadcastProgress(prog) {
        if (this.state === 'CANCELLED') return;
        const uploadUrl = (prog?.url && !prog.url.includes('.m3u8')) ? prog.url : '';
        const linksList = Array.isArray(prog?.links) ? prog.links.filter(l => l.url && !l.url.includes('.m3u8')) : [];

        chrome.runtime.sendMessage({
            cmd: 'UPDATE_SERVER_UPLOAD_PROGRESS',
            parameter: {
                id: this.id,
                name: this.name,
                service: this.service,
                progress: this.progress,
                stage: this.stage,
                status: this.state,
                speed: this.speed,
                url: uploadUrl,
                links: linksList,
                mediaUrl: this.mediaUrl
            }
        });
    }

    renderCompleted(result) {
        if (this.state === 'CANCELLED' || this.abortController?.signal?.aborted) return;

        const rawUrl = result?.url || (result?.links && result.links[0]?.url) || '';
        const finalUrl = (rawUrl && !rawUrl.includes('.m3u8')) ? rawUrl : '';
        const serviceName = this.manager.getServiceDisplayName(this.service);
        const linksList = Array.isArray(result?.links) && result.links.length > 0 
            ? result.links.filter(l => l.url && !l.url.includes('.m3u8')) 
            : (finalUrl ? [{ service: serviceName, url: finalUrl }] : []);

        if (!finalUrl && linksList.length === 0 && !this._completedRendered) {
            return;
        }

        if (this._completedRendered && (!finalUrl || finalUrl === this.finalUrl)) return;
        this._completedRendered = true;
        this.finalUrl = finalUrl;

        this.state = 'COMPLETED';
        this.dom.statusBadge.textContent = 'COMPLETED';
        this.dom.statusBadge.className = 'badge bg-success font-monospace status-badge';
        this.dom.statusBadge.style.background = '';
        this.dom.progressBar.classList.remove('progress-bar-animated', 'progress-bar-striped');
        this.dom.progressBar.style.background = '#10b981';
        this.dom.progressBar.style.width = '100%';
        this.dom.progressText.textContent = '100%';
        this.dom.stageText.textContent = ' • Server Upload Complete';
        this.dom.speedText.textContent = 'Done';
        this.dom.pauseBtn.classList.add('d-none');
        this.dom.resumeBtn.classList.add('d-none');
        this.dom.cancelBtn.classList.add('d-none');
        this.dom.dismissBtn.classList.remove('d-none');
        this.dom.completeAlert.classList.remove('d-none');
        this.dom.errorAlert.classList.add('d-none');

        this.dom.linksContainer.innerHTML = '';
        linksList.forEach(lnk => {
            const row = document.createElement('div');
            row.className = 'd-flex align-items-center justify-content-between gap-2 p-1 rounded bg-white border';
            row.innerHTML = `
                <div class="d-flex align-items-center gap-1.5 overflow-hidden">
                    <span class="badge bg-light text-dark border" style="font-size: 0.68rem;">${lnk.service || 'Mirror'}</span>
                    <a href="${lnk.url}" target="_blank" class="text-truncate text-primary small text-decoration-none" style="font-size: 0.76rem;" title="${lnk.url}">${lnk.url}</a>
                </div>
                <button class="btn btn-xs btn-outline-primary py-0 px-2 flex-shrink-0" style="font-size: 0.72rem;"><i class="bi bi-clipboard me-0.5"></i> Copy</button>
            `;
            row.querySelector('button').onclick = () => {
                navigator.clipboard.writeText(lnk.url);
                row.querySelector('button').textContent = 'Copied!';
                setTimeout(() => { row.querySelector('button').innerHTML = '<i class="bi bi-clipboard me-0.5"></i> Copy'; }, 2000);
            };
            this.dom.linksContainer.appendChild(row);
        });

        const hasLinks = Boolean(finalUrl.trim()) || linksList.length > 0;
        if (hasLinks && typeof HistoryManager !== 'undefined' && HistoryManager.addRecord) {
            HistoryManager.addRecord({
                id: this.id,
                jobId: this.id,
                type: 'upload',
                name: this.name,
                size: result?.fileSize || this.data.size || 0,
                service: `Server (${serviceName})`,
                url: finalUrl,
                links: linksList,
                status: 'completed'
            });
        }

        chrome.runtime.sendMessage({
            cmd: 'UPDATE_SERVER_UPLOAD_PROGRESS',
            parameter: {
                id: this.id,
                name: this.name,
                service: this.service,
                progress: 100,
                stage: 'COMPLETED',
                status: 'COMPLETED',
                speed: 'Server Upload Complete',
                url: finalUrl,
                links: linksList,
                mediaUrl: this.mediaUrl
            }
        });
        chrome.runtime.sendMessage({
            cmd: 'SERVER_UPLOAD_FINISHED',
            parameter: { 
                id: this.id, 
                status: 'COMPLETED', 
                url: finalUrl, 
                links: linksList,
                mediaUrl: this.mediaUrl 
            }
        });

        this.manager.updateGlobalStatus();
    }

    renderFailed(errorMsg) {
        if (this.state === 'CANCELLED' || this.abortController?.signal?.aborted) return;
        this.state = 'FAILED';
        this.dom.statusBadge.textContent = 'FAILED';
        this.dom.statusBadge.className = 'badge bg-danger font-monospace status-badge';
        this.dom.statusBadge.style.background = '';
        this.dom.progressBar.classList.remove('progress-bar-animated', 'progress-bar-striped');
        this.dom.progressBar.style.background = '#ef4444';
        this.dom.pauseBtn.classList.add('d-none');
        this.dom.resumeBtn.classList.add('d-none');
        this.dom.cancelBtn.classList.add('d-none');
        this.dom.dismissBtn.classList.remove('d-none');
        this.dom.errorAlert.classList.remove('d-none');
        this.dom.errorText.textContent = errorMsg || 'Server upload failed.';

        chrome.runtime.sendMessage({
            cmd: 'UPDATE_SERVER_UPLOAD_PROGRESS',
            parameter: {
                id: this.id,
                name: this.name,
                service: this.service,
                progress: this.progress,
                stage: 'FAILED',
                status: 'FAILED',
                speed: errorMsg
            }
        });
        chrome.runtime.sendMessage({
            cmd: 'SERVER_UPLOAD_FINISHED',
            parameter: { id: this.id, status: 'FAILED', error: errorMsg }
        });

        this.manager.updateGlobalStatus();
    }
}

// ─── Download Manager (All Tasks in Single Tab) ─────────────────────────

class DownloadManager {
    constructor() {
        this.tasks = new Map();
        this.serverTasks = new Map();
        this.$tasksList = document.getElementById('tasksList');
        this.$emptyTasks = document.getElementById('emptyTasks');
        this.$headerStatus = document.getElementById('headerStatus');

        this.setupListeners();
        this.init();
    }

    getServiceDisplayName(svc) {
        if (!svc) return "Cloud";
        if (svc.includes(",")) {
            const count = svc.split(",").filter(Boolean).length;
            return `Multi-Host (${count})`;
        }
        const map = {
            "local": "Local File",
            "all": "All Services",
            "pixeldrain": "PixelDrain",
            "pixeldrain.com": "PixelDrain",
            "gofile": "GoFile",
            "gofile.io": "GoFile",
            "buzzheavier": "Buzzheavier",
            "buzzheavier.com": "Buzzheavier",
            "fuckingfast": "FFast",
            "fuckingfast.co": "FFast",
            "storage.to": "Storage.to",
            "catbox": "Catbox",
            "catbox.moe": "Catbox",
            "s3": "S3 Compatible",
            "s3_compatible": "S3 Compatible",
            "hf_buckets": "Hugging Face",
            "huggingface": "Hugging Face",
            "telegram": "Telegram"
        };
        return map[svc] || (svc ? svc.charAt(0).toUpperCase() + svc.slice(1) : "Cloud");
    }

    addTaskElement(element) {
        this.$tasksList.prepend(element);
        this.updateGlobalStatus();
    }

    removeTask(id) {
        this.tasks.delete(id);
        this.updateGlobalStatus();
    }

    addTask(taskData) {
        if (!taskData || !taskData.url) return;
        const id = taskData.id || `dl_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        if (this.tasks.has(id)) return;

        const task = new DownloadTask({ ...taskData, id }, this);
        this.tasks.set(id, task);
        this.updateGlobalStatus();
    }

    addServerTask(taskData) {
        if (!taskData) return;
        const id = taskData.id || `srv_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        if (this.serverTasks.has(id)) {
            const existing = this.serverTasks.get(id);
            if (existing && (existing.state === 'CANCELLED' || existing.state === 'COMPLETED')) {
                existing.dom?.card?.remove();
                this.serverTasks.delete(id);
            } else {
                if (taskData.url && (!existing.url || existing.state === 'STARTING')) {
                    existing.url = taskData.url;
                    existing.isDispatched = Boolean(taskData.isDispatched || existing.isDispatched);
                    existing.data = { ...existing.data, ...taskData, isDispatched: existing.isDispatched };
                    existing.name = taskData.name || existing.name;
                    existing.headers = taskData.headers || existing.headers;
                    existing.service = taskData.service || existing.service;
                    existing.credentials = taskData.credentials || existing.credentials;
                    existing.serverConfig = taskData.serverConfig || existing.serverConfig;
                    existing.relayUrl = (existing.serverConfig?.relayUrl || '').trim().replace(/\/+$/, '');
                    if (existing.state !== 'RUNNING' && existing.state !== 'COMPLETED' && existing.state !== 'CANCELLED') {
                        existing.start();
                    }
                    return;
                }
                if (existing && typeof existing.updateProgress === 'function') {
                    existing.updateProgress(taskData, true);
                }
                return;
            }
        }

        const task = new ServerUploadTask({
            ...taskData,
            id,
            isDispatched: Boolean(taskData.isDispatched)
        }, this);
        this.serverTasks.set(id, task);
        this.updateGlobalStatus();

        if (task.url && task.state !== 'RUNNING' && task.state !== 'COMPLETED' && task.state !== 'CANCELLED') {
            task.start();
        }
    }

    addOrUpdateServerTask(job, fromRemote = false) {
        if (!job || !job.id) return;
        let entry = this.serverTasks.get(job.id);
        if (entry) {
            if (typeof entry.updateProgress === 'function') {
                entry.updateProgress(job, fromRemote);
            }
        } else {
            this.addServerTask(job);
        }
        this.updateGlobalStatus();
    }

    finalizeServerTask(param) {
        if (!param?.id) return;
        const entry = this.serverTasks.get(param.id);
        if (entry) {
            if (param.status === 'CANCELLED' || entry.state === 'CANCELLED') {
                return;
            }
            if (param.status === 'FAILED' || entry.state === 'FAILED') {
                if (typeof entry.renderFailed === 'function' && entry.state !== 'FAILED') {
                    entry.renderFailed(param.error || param.speed || 'Server upload failed');
                }
                return;
            }
            if (typeof entry.renderCompleted === 'function' && entry.state !== 'COMPLETED') {
                entry.renderCompleted(param);
            }
        }
    }

    updateGlobalStatus() {
        const total = this.tasks.size + this.serverTasks.size;
        if (total === 0) {
            if (this.$emptyTasks) this.$emptyTasks.classList.remove('d-none');
            if (this.$headerStatus) this.$headerStatus.textContent = 'No active tasks';
            return;
        }

        if (this.$emptyTasks) this.$emptyTasks.classList.add('d-none');

        let activeCount = 0;
        let completedCount = 0;
        for (const task of this.tasks.values()) {
            if (['DOWNLOADING', 'CONVERTING', 'UPLOADING', 'PROCESSING', 'QUEUED'].includes(task.state)) activeCount++;
            else if (task.state === 'COMPLETED') completedCount++;
        }
        for (const st of this.serverTasks.values()) {
            const s = st.state || st.job?.status;
            if (s === 'RUNNING' || s === 'STARTING' || s === 'QUEUED' || s === 'INITIALIZING') activeCount++;
            else if (s === 'COMPLETED') completedCount++;
        }

        if (this.$headerStatus) {
            if (activeCount > 0) {
                this.$headerStatus.textContent = `${activeCount} active task${activeCount > 1 ? 's' : ''}${completedCount > 0 ? ` • ${completedCount} completed` : ''}`;
            } else if (completedCount > 0) {
                this.$headerStatus.textContent = `All tasks complete (${completedCount} file${completedCount > 1 ? 's' : ''})`;
            } else {
                this.$headerStatus.textContent = `${total} task${total > 1 ? 's' : ''}`;
            }
        }
    }

    setupListeners() {
        const $chromeDlBtn = document.getElementById('openChromeDownloadsBtn');
        if ($chromeDlBtn) {
            $chromeDlBtn.onclick = () => {
                chrome.tabs.create({ url: 'chrome://downloads/' });
            };
        }

        window.addEventListener('beforeunload', (e) => {
            let hasActive = false;
            for (const task of this.tasks.values()) {
                if (['DOWNLOADING', 'CONVERTING', 'UPLOADING', 'PROCESSING', 'QUEUED'].includes(task.state)) {
                    hasActive = true;
                    break;
                }
            }
            if (!hasActive) {
                for (const st of this.serverTasks.values()) {
                    const s = st.state || st.job?.status;
                    if (s === 'RUNNING' || s === 'STARTING' || s === 'QUEUED') {
                        hasActive = true;
                        break;
                    }
                }
            }
            if (hasActive) {
                e.preventDefault();
                e.returnValue = 'Active stream downloads or cloud uploads are in progress. Leaving this tab will interrupt them.';
                return e.returnValue;
            }
        });

        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            const { cmd, parameter } = message || {};

            if (cmd === 'ADD_DOWNLOAD_TASK' && parameter) {
                this.addTask(parameter);
                sendResponse({ received: true });
                return true;
            }

            if (cmd === 'ADD_SERVER_TASK' && parameter) {
                this.addServerTask(parameter);
                sendResponse({ received: true });
                return true;
            }

            if (cmd === 'ACTION_PAUSE_DOWNLOAD' && parameter?.id) {
                const task = this.tasks.get(parameter.id);
                if (task) task.pause();
                sendResponse({ ok: true });
                return true;
            }

            if (cmd === 'ACTION_RESUME_DOWNLOAD' && parameter?.id) {
                const task = this.tasks.get(parameter.id);
                if (task) task.resume();
                sendResponse({ ok: true });
                return true;
            }

            if (cmd === 'ACTION_CANCEL_DOWNLOAD' && parameter?.id) {
                const task = this.tasks.get(parameter.id);
                if (task) task.cancel();
                sendResponse({ ok: true });
                return true;
            }

            if (cmd === 'ACTION_SAVE_TASK_TO_PC' && parameter?.id) {
                const task = this.tasks.get(parameter.id);
                if (task && task._completedFile) {
                    task.triggerFileSave(task._completedFile).then(() => {
                        sendResponse({ ok: true });
                    }).catch(err => {
                        sendResponse({ ok: false, error: err.message });
                    });
                    return true;
                }
                sendResponse({ ok: false, error: 'Task or completed file not found in manager.' });
                return true;
            }

            if (cmd === 'ACTION_PAUSE_SERVER_UPLOAD' && parameter?.id) {
                const task = this.serverTasks.get(parameter.id);
                if (task && typeof task.pause === 'function') task.pause();
                sendResponse({ ok: true });
                return true;
            }

            if (cmd === 'ACTION_RESUME_SERVER_UPLOAD' && parameter?.id) {
                const task = this.serverTasks.get(parameter.id);
                if (task && typeof task.resume === 'function') task.resume();
                sendResponse({ ok: true });
                return true;
            }


            if (cmd === 'REGISTER_SERVER_UPLOAD' && parameter) {
                this.addOrUpdateServerTask(parameter, true);
                sendResponse({ received: true });
                return true;
            }

            if (cmd === 'UPDATE_SERVER_UPLOAD_PROGRESS' && parameter) {
                const existing = this.serverTasks.get(parameter.id);
                if (existing && existing.abortController && !existing.abortController.signal.aborted && (existing.state === 'RUNNING' || existing.state === 'STARTING')) {
                    sendResponse({ received: true });
                    return true;
                }
                this.addOrUpdateServerTask(parameter, true);
                sendResponse({ received: true });
                return true;
            }

            if (cmd === 'ACTION_CANCEL_SERVER_UPLOAD' && parameter?.id) {
                const task = this.serverTasks.get(parameter.id);
                if (task && task.state !== 'CANCELLED') {
                    task.cancel(false);
                }
                sendResponse({ received: true });
                return true;
            }

            if (cmd === 'SERVER_UPLOAD_FINISHED' && parameter) {
                if (parameter.status === 'CANCELLED') {
                    const task = this.serverTasks.get(parameter.id);
                    if (task && task.state !== 'CANCELLED') {
                        task.cancel(false);
                    }
                } else {
                    this.finalizeServerTask(parameter);
                }
                sendResponse({ received: true });
                return true;
            }
        });
    }

    async init() {
        const params = new URLSearchParams(window.location.search);
        const initialId = params.get('id');

        if (initialId) {
            const stored = await new Promise(resolve => {
                chrome.storage.local.get([initialId], res => resolve(res?.[initialId]));
            });
            if (stored) {
                this.addTask(stored);
                chrome.storage.local.remove([initialId]);
            }
        }

        const srvInitialId = params.get('srvId');
        if (srvInitialId) {
            const stored = await new Promise(resolve => {
                chrome.storage.local.get([srvInitialId], res => resolve(res?.[srvInitialId]));
            });
            if (stored) {
                this.addServerTask(stored);
                chrome.storage.local.remove([srvInitialId]);
            }
        }

        if (initialId || srvInitialId) {
            try {
                window.history.replaceState({}, document.title, window.location.pathname);
            } catch (e) {}
        }

        const queueData = await new Promise(resolve => {
            chrome.storage.local.get(['dl_queue'], res => resolve(res?.dl_queue));
        });
        if (queueData) {
            this.addTask(queueData);
            chrome.storage.local.remove(['dl_queue']);
        }

        const srvQueueData = await new Promise(resolve => {
            chrome.storage.local.get(['srv_queue'], res => resolve(res?.srv_queue));
        });
        if (srvQueueData) {
            this.addServerTask(srvQueueData);
            chrome.storage.local.remove(['srv_queue']);
        }

        // Restore any in-flight downloads from active_downloads storage
        const activeMap = await new Promise(resolve => {
            chrome.storage.local.get(['active_downloads'], res => resolve(res?.active_downloads || {}));
        });
        for (const dlId in activeMap) {
            const dlItem = activeMap[dlId];
            if (dlItem && dlItem.url && !this.tasks.has(dlId)) {
                this.addTask(dlItem);
            }
        }

        // Restore any active server uploads (Cloud Runner) - skip cancelled/completed/failed
        const serverMap = await new Promise(resolve => {
            chrome.storage.local.get(['active_server_uploads'], res => resolve(res?.active_server_uploads || {}));
        });
        for (const sId in serverMap) {
            const sItem = serverMap[sId];
            const st = sItem?.status || sItem?.state;
            if (sItem && sItem.id && !this.serverTasks.has(sId) && st !== 'CANCELLED' && st !== 'COMPLETED' && st !== 'FAILED') {
                this.addOrUpdateServerTask(sItem);
            }
        }

        this.updateGlobalStatus();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new DownloadManager();

    // Prevent internal navigation from opening duplicate tabs or aborting tasks
    document.addEventListener('click', (e) => {
        const a = e.target.closest('a');
        if (a && a.getAttribute('href') && a.getAttribute('href').endsWith('.html')) {
            e.preventDefault();
            const href = a.getAttribute('href');
            const targetUrl = chrome.runtime.getURL(href);
            chrome.tabs.query({}, (tabs) => {
                const existing = tabs.find(t => t.url && t.url.split('?')[0] === targetUrl.split('?')[0]);
                if (existing) {
                    chrome.tabs.update(existing.id, { active: true });
                    if (existing.windowId) chrome.windows.update(existing.windowId, { focused: true });
                } else {
                    chrome.tabs.create({ url: targetUrl });
                }
            });
        }
    });
});

