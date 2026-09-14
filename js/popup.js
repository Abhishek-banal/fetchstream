/**
 * FetchStream Popup Controller
 * Manages UI interactions, stream item rendering, inline playback,
 * live active downloads with Pause/Resume/Cancel, and settings configuration.
 */

if (window.Hls === undefined) {
    window.Hls = {};
    window.Hls.isSupported = () => false;
}

class PopupManager {
    constructor() {
        this.tab = null;
        this.options = OPTION;
        this.bootstrap = null;
        this.ruleId = 1;
        this.items = [];
        this.storageKey = null;
        this.activeDownloadCards = {};

        this.$templateItem = this.selector("item").cloneNode(true);
        this.selector("item").remove();

        this.$loading = this.selector("loading");
        this.$empty = this.selector("empty");
        this.$disable = this.selector("disable");
        this.$container = this.selector("container");
        this.$list = this.selector("list");
        this.$optionsBtn = this.selector("optionsBtn");
        this.$options = this.selector("options");
        this.$homeBtn = this.selector("home");
        this.$dashboardBtn = this.selector("dashboardBtn");
        this.$disableDetailBtn = this.selector("disableDetail");

        this.$activeDownloadsSection = this.selector("activeDownloadsSection");
        this.$activeDownloadsList = this.selector("activeDownloadsList");
        this.$activeDownloadsCount = this.selector("activeDownloadsCount");
        this.$openDownloadsTab = this.selector("openDownloadsTab");

        this.activeUploadCards = {};
        this.$activeUploadsSection = this.selector("activeUploadsSection");
        this.$activeUploadsList = this.selector("activeUploadsList");
        this.$activeUploadsCount = this.selector("activeUploadsCount");
        this.$openUploadTab = this.selector("openUploadTab");
        this.$uploadIndicator = this.selector("uploadIndicator");
        this.$manualUploadBtn = this.selector("manualUploadBtn");
        this.$historyBtn = this.selector("historyBtn");
        this.$pauseAllUploadsBtn = this.selector("pauseAllUploadsBtn");
        this.$cancelAllUploadsBtn = this.selector("cancelAllUploadsBtn");

        this.activeServerUploadCards = {};
        this.serverPollingJobs = new Set();
        this.$activeServerUploadsSection = this.selector("activeServerUploadsSection");
        this.$activeServerUploadsList = this.selector("activeServerUploadsList");
        this.$activeServerUploadsCount = this.selector("activeServerUploadsCount");
        this.$clearServerUploadsBtn = this.selector("clearServerUploadsBtn");
        this.$serverUploadNavBtn = this.selector("serverUploadNavBtn");
        this.$refreshPageBtn = this.selector("refreshPageBtn");
        this.$openDownloadsTabForServer = this.selector("openDownloadsTabForServer");
        this.$clearListBtn = this.selector("clearListBtn");
        this.$currentTabOnlyBtn = this.selector("currentTabOnlyBtn");
        this.$keepHistoryToggle = this.selector("keepHistoryToggle");

        if (this.$clearServerUploadsBtn) {
            this.$clearServerUploadsBtn.onclick = () => {
                for (const id in this.activeServerUploadCards) {
                    if (this.activeServerUploadCards[id].state === "COMPLETED" || this.activeServerUploadCards[id].state === "FAILED") {
                        this.removeActiveServerUpload(id);
                    }
                }
            };
        }

        if (this.$serverUploadNavBtn) {
            this.$serverUploadNavBtn.onclick = () => {
                const count = Object.keys(this.activeServerUploadCards).length;
                if (count === 0) {
                    this.toast("No active server uploads running. Click [⚡ Server Upload] on any stream card below, or configure your server in Settings (⚙️).", 4000);
                } else if (this.$activeServerUploadsSection) {
                    this.$activeServerUploadsSection.classList.toggle("d-none");
                }
            };
        }

        this.activeCategory = "videos";
        this.activeSubCategory = "all";
        this.$categoryTabs = this.selector("categoryTabs");
        this.$tabVideos = this.selector("tabVideos");
        this.$tabAudio = this.selector("tabAudio");
        this.$tabFiles = this.selector("tabFiles");
        this.$badgeVideos = this.selector("badgeVideos");
        this.$badgeAudio = this.selector("badgeAudio");
        this.$badgeFiles = this.selector("badgeFiles");

        this.$subfilterContainer = this.selector("subfilterContainer");
        this.$subfilterPills = this.selector("subfilterPill", true);
        this.$badgeSubAll = this.selector("badgeSubAll");
        this.$badgeSubDisks = this.selector("badgeSubDisks");
        this.$badgeSubImages = this.selector("badgeSubImages");
        this.$badgeSubPdf = this.selector("badgeSubPdf");
        this.$badgeSubDocs = this.selector("badgeSubDocs");
        this.$badgeSubSheets = this.selector("badgeSubSheets");
        this.$badgeSubSlides = this.selector("badgeSubSlides");
        this.$badgeSubArchives = this.selector("badgeSubArchives");

        this.$pdfBanner = this.selector("pdfExtractorBanner");
        this.$pdfExtractBtn = this.selector("extractPdfBtn");

        this.$emptyCategory = this.selector("emptyCategory");
        this.$emptyCategoryText = this.selector("emptyCategoryText");

        this.langRender();
    }

    selector(name, isAll = false, parent = null) {
        const root = parent || document;
        return isAll ? root.querySelectorAll(`[selector="${name}"]`) : root.querySelector(`[selector="${name}"]`);
    }

    lang(key, fallback = "") {
        const msg = chrome.i18n.getMessage(key);
        return msg || fallback;
    }

    langRender() {
        document.querySelectorAll(".lang-title").forEach((el) => {
            const title = el.getAttribute("title") || el.getAttribute("data-bs-title");
            if (title) {
                const localized = chrome.i18n.getMessage(title.trim());
                if (localized) {
                    if (el.hasAttribute("title")) el.setAttribute("title", localized);
                    if (el.hasAttribute("data-bs-title")) el.setAttribute("data-bs-title", localized);
                }
            }
        });

        document.querySelectorAll(".lang").forEach((el) => {
            const key = el.getAttribute("data-i18n") || el.innerText.trim();
            if (key) {
                const localized = chrome.i18n.getMessage(key);
                if (localized) el.innerHTML = localized;
            }
        });

        document.addEventListener('vaultStateChanged', (e) => {
            if (this.$list && this.$list.children) {
                Array.from(this.$list.children).forEach(child => {
                    if (typeof child.updateVaultState === 'function') {
                        child.updateVaultState();
                    }
                });
            }
        });
    }

    getServiceDisplayName(svc, customCount = null) {
        if (!svc) return "Cloud";
        if (svc === "custom") {
            return (customCount !== null && customCount !== undefined) ? `${customCount} Hosts` : "Custom List";
        }
        if (svc.includes(",")) {
            return `${svc.split(',').filter(Boolean).length} Hosts`;
        }
        const map = {
            "local": "Local File",
            "all": "All Working",
            "pixeldrain": "PixelDrain",
            "pixeldrain.com": "PixelDrain",
            "gofile": "GoFile",
            "gofile.io": "GoFile",
            "buzzheavier": "Buzzheavier",
            "buzzheavier.com": "Buzzheavier",
            "fuckingfast": "FuckingFast",
            "fuckingfast.co": "FuckingFast",
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

    formatCustomListSummary(list) {
        if (!list || !Array.isArray(list) || list.length === 0) return "None selected";
        if (list.length > 2) return `${list.length} Hosts Selected`;
        return list.map(s => this.getServiceDisplayName(s)).join(", ");
    }

    sizeConvert(bytes) {
        if (!bytes || bytes <= 0) return "Unknown size";
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
        if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
        return (bytes / 1073741824).toFixed(2) + " GB";
    }

    categorizeItem(itemData) {
        if (itemData.category && itemData.subCategory) {
            return { category: itemData.category, subCategory: itemData.subCategory };
        }
        const format = (itemData.format || "").toLowerCase();
        const ct = (itemData.contentType || "").toLowerCase();

        const videoFormats = ["m3u8", "m3u", "mp4", "webm", "mkv", "flv", "mov", "avi", "wmv", "ts"];
        const audioFormats = ["mp3", "m4a", "aac", "wav", "ogg", "flac", "wma", "opus"];
        const diskFormats = ["iso", "bin", "img", "dmg", "mdf", "mds", "nrg", "ccd", "sub", "c2d", "cdi"];
        const imageFormats = ["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "ico", "tiff", "avif"];
        const pdfFormats = ["pdf"];
        const docFormats = ["doc", "docx", "txt", "rtf", "odt", "epub", "pages"];
        const sheetFormats = ["xls", "xlsx", "csv", "ods", "numbers"];
        const slideFormats = ["ppt", "pptx", "odp", "key"];
        const archiveFormats = ["zip", "7z", "rar", "tar", "gz", "bz2", "xz"];

        if (itemData.type === "hls" || videoFormats.includes(format) || ct.startsWith("video/")) {
            return { category: "videos", subCategory: "video" };
        }
        if (audioFormats.includes(format) || ct.startsWith("audio/")) {
            return { category: "audio", subCategory: "audio" };
        }
        if (diskFormats.includes(format)) {
            return { category: "files", subCategory: "disks" };
        }
        if (imageFormats.includes(format) || ct.startsWith("image/")) {
            return { category: "files", subCategory: "images" };
        }
        if (pdfFormats.includes(format) || ct.includes("pdf")) {
            return { category: "files", subCategory: "pdf" };
        }
        if (sheetFormats.includes(format) || ct.includes("sheet") || ct.includes("excel") || ct.includes("csv")) {
            return { category: "files", subCategory: "sheets" };
        }
        if (slideFormats.includes(format) || ct.includes("presentation") || ct.includes("powerpoint")) {
            return { category: "files", subCategory: "slides" };
        }
        if (docFormats.includes(format) || ct.includes("word") || ct.includes("document") || ct.includes("text/")) {
            return { category: "files", subCategory: "docs" };
        }
        if (archiveFormats.includes(format) || ct.includes("zip") || ct.includes("compressed") || ct.includes("archive")) {
            return { category: "files", subCategory: "archives" };
        }

        return { category: "files", subCategory: "docs" };
    }

    setupCategoryTabs() {
        const tabBtns = [this.$tabVideos, this.$tabAudio, this.$tabFiles].filter(Boolean);

        tabBtns.forEach(btn => {
            btn.onclick = () => {
                tabBtns.forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                this.activeCategory = btn.getAttribute("data-category") || "videos";

                if (this.activeCategory === "files") {
                    if (this.$subfilterContainer) this.$subfilterContainer.classList.remove("d-none");
                } else {
                    if (this.$subfilterContainer) this.$subfilterContainer.classList.add("d-none");
                }

                this.applyFilter();
            };
        });

        if (this.$subfilterPills) {
            this.$subfilterPills.forEach(pill => {
                pill.onclick = () => {
                    this.$subfilterPills.forEach(p => p.classList.remove("active"));
                    pill.classList.add("active");
                    this.activeSubCategory = pill.getAttribute("data-sub") || "all";
                    this.applyFilter();
                };
            });
        }

        if (this.$pdfExtractBtn) {
            this.$pdfExtractBtn.onclick = () => this.extractPdfFromPage();
        }
    }

    updateCategoryCounts() {
        let videoCount = 0;
        let audioCount = 0;
        let fileCount = 0;

        let subDisks = 0;
        let subImages = 0;
        let subPdf = 0;
        let subDocs = 0;
        let subSheets = 0;
        let subSlides = 0;
        let subArchives = 0;

        const minBytes = this.options.size?.min || 0;
        const maxBytes = this.options.size?.max || 0;

        for (const item of this.items) {
            if (item.detail.size && item.detail.size > 0) {
                if (minBytes > 0 && item.detail.size < minBytes) continue;
                if (maxBytes > 0 && item.detail.size > maxBytes) continue;
            }

            const { category, subCategory } = this.categorizeItem(item.detail);
            if (category === "videos") videoCount++;
            else if (category === "audio") audioCount++;
            else if (category === "files") {
                fileCount++;
                if (subCategory === "disks") subDisks++;
                else if (subCategory === "images") subImages++;
                else if (subCategory === "pdf") subPdf++;
                else if (subCategory === "docs") subDocs++;
                else if (subCategory === "sheets") subSheets++;
                else if (subCategory === "slides") subSlides++;
                else if (subCategory === "archives") subArchives++;
            }
        }

        if (this.$badgeVideos) this.$badgeVideos.textContent = videoCount;
        if (this.$badgeAudio) this.$badgeAudio.textContent = audioCount;
        if (this.$badgeFiles) this.$badgeFiles.textContent = fileCount;

        if (this.$badgeSubAll) this.$badgeSubAll.textContent = fileCount;
        if (this.$badgeSubDisks) this.$badgeSubDisks.textContent = subDisks;
        if (this.$badgeSubImages) this.$badgeSubImages.textContent = subImages;
        if (this.$badgeSubPdf) this.$badgeSubPdf.textContent = subPdf;
        if (this.$badgeSubDocs) this.$badgeSubDocs.textContent = subDocs;
        if (this.$badgeSubSheets) this.$badgeSubSheets.textContent = subSheets;
        if (this.$badgeSubSlides) this.$badgeSubSlides.textContent = subSlides;
        if (this.$badgeSubArchives) this.$badgeSubArchives.textContent = subArchives;
    }

    applyFilter() {
        let visibleCount = 0;
        const minBytes = this.options.size?.min || 0;
        const maxBytes = this.options.size?.max || 0;

        for (const item of this.items) {
            const { category, subCategory } = this.categorizeItem(item.detail);
            let show = false;

            if (this.activeCategory === "all") {
                show = true;
            } else if (this.activeCategory === category) {
                if (category === "files" && this.activeSubCategory !== "all") {
                    show = (subCategory === this.activeSubCategory);
                } else {
                    show = true;
                }
            }

            if (show && this.options.currentTabOnly && this.tab && this.tab.url) {
                if (!item.detail.pageUrl || item.detail.pageUrl !== this.tab.url) {
                    show = false;
                }
            }

            if (show && item.detail.size && item.detail.size > 0) {
                if (minBytes > 0 && item.detail.size < minBytes) {
                    show = false;
                }
                if (maxBytes > 0 && item.detail.size > maxBytes) {
                    show = false;
                }
            }

            if (show) {
                item.$item.classList.remove("d-none");
                visibleCount++;
            } else {
                item.$item.classList.add("d-none");
            }
        }

        if (this.$emptyCategory) {
            if (visibleCount === 0 && this.items.length > 0) {
                this.$emptyCategory.classList.remove("d-none");
                if (this.$emptyCategoryText) {
                    const catLabel = this.activeCategory === "all" ? "items" : (this.activeCategory === "files" ? (this.activeSubCategory === "all" ? "files" : this.activeSubCategory) : this.activeCategory);
                    this.$emptyCategoryText.textContent = `No ${catLabel} match active filters`;
                }
            } else {
                this.$emptyCategory.classList.add("d-none");
            }
        }
    }

    async probeHlsManifestInPopup(itemData, updateQuality) {
        if (itemData.type !== "hls" || !itemData.url) return;
        try {
            const fetchHeaders = {};
            if (itemData.headers && typeof itemData.headers === "object") {
                const forbidden = ["host", "origin", "referer", "content-length", "cookie", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-dest"];
                for (const [k, v] of Object.entries(itemData.headers)) {
                    if (!forbidden.includes(k.toLowerCase()) && typeof v === "string") {
                        fetchHeaders[k] = v;
                    }
                }
            }
            const resp = await fetch(itemData.url, {
                method: "GET",
                headers: fetchHeaders,
                credentials: "include"
            });
            if (!resp.ok) return;
            const manifest = await resp.text();
            let variants = this.parseHlsManifestLines(manifest, itemData.url);

            if (variants.length === 0 && itemData.url) {
                const candidates = this.getCandidateMasterUrls(itemData.url);
                for (const candUrl of candidates) {
                    try {
                        const candResp = await fetch(candUrl, {
                            method: "GET",
                            headers: fetchHeaders,
                            credentials: "include"
                        });
                        if (candResp && candResp.ok) {
                            const candText = await candResp.text();
                            if (candText.includes("#EXT-X-STREAM-INF")) {
                                const candVariants = this.parseHlsManifestLines(candText, candUrl);
                                if (candVariants.length > 0) {
                                    variants = candVariants;
                                    itemData.masterUrl = candUrl;
                                    break;
                                }
                            }
                        }
                    } catch (candErr) {}
                }
            }

            if (variants.length > 0) {
                itemData.variants = variants;
                itemData.selectedVariantUrl = variants[0].url;
                itemData.selectedResolution = variants[0].label;
                if (typeof updateQuality === "function") {
                    updateQuality(variants, variants[0].label);
                }
            }
        } catch (e) {}
    }

    parseHlsManifestLines(manifest, baseUrl) {
        if (!manifest || !manifest.includes("#EXTM3U")) return [];
        const lines = manifest.split("\n");
        const variants = [];
        let currentRes = null;
        let currentBw = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith("#EXT-X-STREAM-INF:")) {
                const resMatch = line.match(/RESOLUTION=(\d+x\d+)/i);
                const nameMatch = line.match(/NAME="([^"]+)"/i);
                const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
                currentRes = resMatch ? resMatch[1] : (nameMatch ? nameMatch[1] : null);
                currentBw = bwMatch ? parseInt(bwMatch[1], 10) : null;
            } else if (line && !line.startsWith("#") && (currentRes || currentBw)) {
                let varUrl = line;
                try {
                    varUrl = new URL(line, baseUrl).href;
                } catch (e) {}
                let height = "Adaptive";
                if (currentRes) {
                    if (currentRes.includes("x")) {
                        const dims = currentRes.split("x").map(Number);
                        height = Math.min(dims[0], dims[1]) + "p";
                    } else {
                        height = currentRes;
                    }
                } else if (currentBw) {
                    height = Math.round(currentBw / 1000) + " kbps";
                }
                variants.push({
                    url: varUrl,
                    resolution: currentRes || "auto",
                    label: height,
                    bandwidth: currentBw
                });
                currentRes = null;
                currentBw = null;
            }
        }

        if (variants.length > 0) {
            variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
        }
        return variants;
    }

    getCandidateMasterUrls(streamUrl) {
        const candidates = [];
        const add = (cand) => {
            if (cand && cand !== streamUrl && !candidates.includes(cand)) {
                candidates.push(cand);
            }
        };

        try {
            const u = new URL(streamUrl);
            const path = u.pathname;
            const query = u.search || "";

            const stripped = streamUrl.replace(/[_\-](?:\d+p|\d{3,4}|b\d+)\.m3u8(?:\?.*)?$/i, `.m3u8${query}`);
            add(stripped);

            const idxStripped = streamUrl.replace(/(?:index|stream|track)_[a-zA-Z0-9_-]+\.m3u8(?:\?.*)?$/i, `index.m3u8${query}`);
            add(idxStripped);

            add(new URL(`master.m3u8${query}`, streamUrl).href);
            add(new URL(`playlist.m3u8${query}`, streamUrl).href);

            if (/\/(?:\d+p?|hls|chunks|manifest)\/(?:index|master|playlist|chunklist|video)\.m3u8/i.test(path)) {
                add(new URL(`../master.m3u8${query}`, streamUrl).href);
                add(new URL(`../playlist.m3u8${query}`, streamUrl).href);
            }
        } catch (e) {}

        return candidates;
    }

    async probePageVideoResolution(itemData, updateQuality) {
        if (itemData.type === "hls" || itemData.resolution) return;
        if (this.categorizeItem(itemData).category !== "videos") return;

        if (this.tab?.id && chrome.scripting?.executeScript) {
            try {
                const results = await chrome.scripting.executeScript({
                    target: { tabId: this.tab.id, allFrames: true },
                    func: (targetUrl) => {
                        const vids = Array.from(document.querySelectorAll("video"));
                        for (const v of vids) {
                            if (v.currentSrc === targetUrl || v.src === targetUrl) {
                                if (v.videoWidth && v.videoHeight) {
                                    return `${v.videoWidth}x${v.videoHeight}`;
                                }
                            }
                        }
                        return null;
                    },
                    args: [itemData.url]
                });
                const foundRes = results?.find(r => r.result)?.result;
                if (foundRes) {
                    itemData.resolution = foundRes;
                    if (typeof updateQuality === "function") updateQuality(null, foundRes);
                    return;
                }
            } catch (e) {}
        }

        try {
            const v = document.createElement("video");
            v.preload = "metadata";
            v.muted = true;
            v.src = itemData.url;
            v.onloadedmetadata = () => {
                if (v.videoWidth && v.videoHeight) {
                    const res = `${v.videoWidth}x${v.videoHeight}`;
                    itemData.resolution = res;
                    if (typeof updateQuality === "function") updateQuality(null, res);
                }
                v.removeAttribute("src");
                v.load();
            };
            v.onerror = () => {
                v.removeAttribute("src");
            };
        } catch (e) {}
    }

    async checkPdfViewerOnPage() {
        if (!this.tab || !this.tab.id || !this.tab.url || this.tab.url.startsWith("chrome")) return;
        if (!chrome.scripting || typeof chrome.scripting.executeScript !== "function") return;
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: this.tab.id, allFrames: true },
                world: "MAIN",
                func: () => {
                    try {
                        let app = window.PDFViewerApplication;
                        if (!app && window.frames) {
                            for (let i = 0; i < window.frames.length; i++) {
                                try {
                                    if (window.frames[i].PDFViewerApplication) {
                                        app = window.frames[i].PDFViewerApplication;
                                        break;
                                    }
                                } catch (e) {}
                            }
                        }
                        if (app && app.pdfDocument) {
                            let title = document.title || "document";
                            try {
                                if (app.pdfDocument.metadata?.info?.Title) {
                                    title = app.pdfDocument.metadata.info.Title;
                                }
                            } catch (e) {}
                            return {
                                found: true,
                                title: title.replace(/[\\/:*?"<>|]/g, "_").trim(),
                                numPages: app.pdfDocument.numPages || 0
                            };
                        }
                    } catch (e) {}
                    return { found: false };
                }
            });

            const foundData = results?.find(r => r.result?.found)?.result;
            if (foundData) {
                const alreadyAdded = this.items.some(i => i.detail.isProtectedPdf);
                if (!alreadyAdded) {
                    let docName = foundData.title || "Embedded_Document";
                    if (!docName.toLowerCase().endsWith(".pdf")) docName += ".pdf";

                    const pdfItemData = {
                        requestId: `pdf_viewer_${this.tab.id}`,
                        url: this.tab.url,
                        name: docName,
                        format: "pdf",
                        type: "file",
                        contentType: "application/pdf",
                        size: 0,
                        isProtectedPdf: true,
                        isEmbeddedPdf: true,
                        numPages: foundData.numPages,
                        category: "files",
                        subCategory: "pdf",
                        pageUrl: this.tab.url
                    };

                    this.$empty.classList.add("d-none");
                    this.$container.classList.remove("d-none");
                    this.itemCreate(pdfItemData);
                }
            }
        } catch (e) {}
    }

    async scanPageForDownloadLinks() {
        if (!this.tab || !this.tab.id || !this.tab.url) return;
        const tabUrl = this.tab.url.toLowerCase();
        if (tabUrl.startsWith("chrome://") || tabUrl.startsWith("chrome-extension://") || tabUrl.startsWith("edge://") || tabUrl.startsWith("about:")) {
            return;
        }
        if (!chrome.scripting || typeof chrome.scripting.executeScript !== "function") return;

        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: this.tab.id, allFrames: false },
                args: [this.options.scanFilters || { categories: {}, subCategories: {}, formats: {} }],
                func: (filters) => {
                    const matchedLinks = [];
                    const seenUrls = new Set();

                    const EXT_TO_CAT = {
                        // Videos & Playlists
                        m3u8: { cat: "videos", sub: "video", type: "hls" },
                        m3u:  { cat: "videos", sub: "video", type: "hls" },
                        mp4:  { cat: "videos", sub: "video", type: "direct" },
                        webm: { cat: "videos", sub: "video", type: "direct" },
                        mkv:  { cat: "videos", sub: "video", type: "direct" },
                        flv:  { cat: "videos", sub: "video", type: "direct" },
                        mov:  { cat: "videos", sub: "video", type: "direct" },
                        avi:  { cat: "videos", sub: "video", type: "direct" },
                        wmv:  { cat: "videos", sub: "video", type: "direct" },
                        ts:   { cat: "videos", sub: "video", type: "direct" },

                        // Audio
                        mp3:  { cat: "audio", sub: "audio", type: "direct" },
                        m4a:  { cat: "audio", sub: "audio", type: "direct" },
                        aac:  { cat: "audio", sub: "audio", type: "direct" },
                        wav:  { cat: "audio", sub: "audio", type: "direct" },
                        ogg:  { cat: "audio", sub: "audio", type: "direct" },
                        flac: { cat: "audio", sub: "audio", type: "direct" },
                        wma:  { cat: "audio", sub: "audio", type: "direct" },
                        opus: { cat: "audio", sub: "audio", type: "direct" },

                        // Images
                        png:  { cat: "files", sub: "images", type: "file" },
                        jpg:  { cat: "files", sub: "images", type: "file" },
                        jpeg: { cat: "files", sub: "images", type: "file" },
                        webp: { cat: "files", sub: "images", type: "file" },
                        gif:  { cat: "files", sub: "images", type: "file" },
                        svg:  { cat: "files", sub: "images", type: "file" },
                        bmp:  { cat: "files", sub: "images", type: "file" },
                        ico:  { cat: "files", sub: "images", type: "file" },
                        tiff: { cat: "files", sub: "images", type: "file" },
                        avif: { cat: "files", sub: "images", type: "file" },

                        // PDFs
                        pdf:  { cat: "files", sub: "pdf", type: "file" },

                        // Documents
                        doc:   { cat: "files", sub: "docs", type: "file" },
                        docx:  { cat: "files", sub: "docs", type: "file" },
                        txt:   { cat: "files", sub: "docs", type: "file" },
                        rtf:   { cat: "files", sub: "docs", type: "file" },
                        odt:   { cat: "files", sub: "docs", type: "file" },
                        epub:  { cat: "files", sub: "docs", type: "file" },
                        pages: { cat: "files", sub: "docs", type: "file" },

                        // Spreadsheets
                        xls:     { cat: "files", sub: "sheets", type: "file" },
                        xlsx:    { cat: "files", sub: "sheets", type: "file" },
                        csv:     { cat: "files", sub: "sheets", type: "file" },
                        ods:     { cat: "files", sub: "sheets", type: "file" },
                        numbers: { cat: "files", sub: "sheets", type: "file" },

                        // Presentations
                        ppt:  { cat: "files", sub: "slides", type: "file" },
                        pptx: { cat: "files", sub: "slides", type: "file" },
                        odp:  { cat: "files", sub: "slides", type: "file" },
                        key:  { cat: "files", sub: "slides", type: "file" },

                        // Archives
                        zip:  { cat: "files", sub: "archives", type: "file" },
                        "7z": { cat: "files", sub: "archives", type: "file" },
                        rar:  { cat: "files", sub: "archives", type: "file" },
                        tar:  { cat: "files", sub: "archives", type: "file" },
                        gz:   { cat: "files", sub: "archives", type: "file" },
                        bz2:  { cat: "files", sub: "archives", type: "file" },
                        xz:   { cat: "files", sub: "archives", type: "file" },

                        // Disk Images
                        iso: { cat: "files", sub: "disks", type: "file" },
                        img: { cat: "files", sub: "disks", type: "file" },
                        bin: { cat: "files", sub: "disks", type: "file" },
                        dmg: { cat: "files", sub: "disks", type: "file" },
                        mdf: { cat: "files", sub: "disks", type: "file" },
                        mds: { cat: "files", sub: "disks", type: "file" },
                        nrg: { cat: "files", sub: "disks", type: "file" },
                        ccd: { cat: "files", sub: "disks", type: "file" },
                        sub: { cat: "files", sub: "disks", type: "file" },
                        c2d: { cat: "files", sub: "disks", type: "file" },
                        cdi: { cat: "files", sub: "disks", type: "file" }
                    };

                    const elements = Array.from(document.querySelectorAll("a[href], video[src], audio[src], source[src], a[download]"));
                    
                    return new Promise((resolve) => {
                        let i = 0;
                        const chunkSize = 50;

                        const processChunk = () => {
                            const end = Math.min(i + chunkSize, elements.length);
                            for (; i < end; i++) {
                                if (matchedLinks.length >= 100) break;
                                const el = elements[i];
                                const rawHref = el.getAttribute("href") || el.getAttribute("src");
                                if (!rawHref || rawHref.startsWith("javascript:") || rawHref.startsWith("#") || rawHref.startsWith("mailto:")) continue;

                                try {
                                    const resolvedUrl = new URL(rawHref, document.baseURI).href;
                                    if (seenUrls.has(resolvedUrl) || !resolvedUrl.startsWith("http")) continue;

                                    const parsed = new URL(resolvedUrl);
                                    const pathname = parsed.pathname.toLowerCase();
                                    let ext = pathname.split('.').pop();

                                    if (!EXT_TO_CAT[ext]) {
                                        const searchLower = parsed.search.toLowerCase();
                                        const dlAttr = (el.getAttribute("download") || "").toLowerCase();
                                        for (const key in EXT_TO_CAT) {
                                            if (searchLower.includes(`.${key}`) || dlAttr.endsWith(`.${key}`)) {
                                                ext = key;
                                                break;
                                            }
                                        }
                                    }

                                    if (EXT_TO_CAT[ext]) {
                                        const meta = EXT_TO_CAT[ext];
                                        
                                        if (filters.categories && filters.categories[meta.cat] === false) continue;
                                        if (filters.subCategories && filters.subCategories[meta.sub] === false) continue;
                                        if (filters.formats && filters.formats[ext] === false) continue;

                                        seenUrls.add(resolvedUrl);
                                        let filename = el.getAttribute("download") ||
                                                       (el.innerText && el.innerText.trim().length > 0 && el.innerText.trim().length < 80 && !el.innerText.includes("\n") ? el.innerText.trim() : "") ||
                                                       pathname.split('/').filter(Boolean).pop() ||
                                                       "file";

                                        filename = filename.replace(/[\\/:*?"<>|]/g, "_").trim() || "file";
                                        if (!filename.toLowerCase().endsWith(`.${ext}`)) filename += `.${ext}`;

                                        let poster = null;
                                        if (el.tagName === "VIDEO" && el.poster) poster = el.poster;
                                        else if (el.tagName === "SOURCE" && el.parentElement && el.parentElement.tagName === "VIDEO" && el.parentElement.poster) poster = el.parentElement.poster;

                                        matchedLinks.push({ url: resolvedUrl, name: filename, format: ext, type: meta.type, category: meta.cat, subCategory: meta.sub, poster: poster });
                                    }
                                } catch (e) {}
                            }
                            
                            if (i < elements.length && matchedLinks.length < 100) {
                                setTimeout(processChunk, 10);
                            } else {
                                resolve(matchedLinks);
                            }
                        };
                        processChunk();
                    });
                }
            });

            const foundFiles = results?.[0]?.result || [];
            if (!Array.isArray(foundFiles) || foundFiles.length === 0) return;

            let addedCount = 0;
            const storageUpdates = {};

            for (let i = 0; i < foundFiles.length; i++) {
                const fileItem = foundFiles[i];
                const alreadyExists = this.items.some(it => it.detail.url === fileItem.url);
                if (alreadyExists) continue;

                const reqId = `dom_link_${this.tab.id}_${Date.now()}_${i}`;
                const itemData = {
                    requestId: reqId,
                    url: fileItem.url,
                    name: fileItem.name,
                    format: fileItem.format,
                    type: fileItem.type,
                    size: 0,
                    category: fileItem.category,
                    subCategory: fileItem.subCategory,
                    poster: fileItem.poster || null,
                    pageUrl: this.tab.url
                };

                if (this.$empty) this.$empty.classList.add("d-none");
                if (this.$container) this.$container.classList.remove("d-none");
                this.itemCreate(itemData);
                storageUpdates[reqId] = itemData;
                addedCount++;
            }

            if (addedCount > 0) {
                chrome.storage.local.get([this.storageKey], (storeRes) => {
                    const currentStore = storeRes?.[this.storageKey] || {};
                    Object.assign(currentStore, storageUpdates);
                    chrome.storage.local.set({ [this.storageKey]: currentStore });
                });

                this.updateCategoryCounts();
                this.applyFilter();
            }
        } catch (err) {
            console.warn("[FetchStream] DOM Link scan notice:", err);
        }
    }

    async extractPdfFromPage() {
        if (!this.tab || !this.tab.id) return;
        if (!chrome.scripting || typeof chrome.scripting.executeScript !== "function") {
            this.toast("Scripting API not loaded: please reload FetchStream at chrome://extensions", 4500, true);
            return;
        }
        this.toast("Scanning page viewer for PDF document data...", 2000);

        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: this.tab.id, allFrames: true },
                world: "MAIN",
                func: async () => {
                    try {
                        let app = window.PDFViewerApplication;
                        if (!app && window.frames) {
                            for (let i = 0; i < window.frames.length; i++) {
                                try {
                                    if (window.frames[i].PDFViewerApplication) {
                                        app = window.frames[i].PDFViewerApplication;
                                        break;
                                    }
                                } catch (e) {}
                            }
                        }

                        if (!app || !app.pdfDocument || typeof app.pdfDocument.getData !== "function") {
                            return { success: false, error: "No PDFViewerApplication document data found on this page." };
                        }

                        const data = await app.pdfDocument.getData();
                        let title = document.title || "document";
                        try {
                            if (app.pdfDocument.metadata?.info?.Title) {
                                title = app.pdfDocument.metadata.info.Title;
                            }
                        } catch (e) {}
                        title = title.replace(/[\\/:*?"<>|]/g, "_").trim();
                        if (!title.toLowerCase().endsWith(".pdf")) title += ".pdf";

                        const blob = new Blob([data], { type: "application/pdf" });
                        const blobUrl = URL.createObjectURL(blob);
                        const link = document.createElement("a");
                        link.href = blobUrl;
                        link.download = title;
                        document.body.appendChild(link);
                        link.click();
                        setTimeout(() => {
                            link.remove();
                            URL.revokeObjectURL(blobUrl);
                        }, 15000);

                        return { success: true, title, size: data.byteLength };
                    } catch (err) {
                        return { success: false, error: err.message };
                    }
                }
            });

            const successResult = results?.find(r => r.result?.success);
            if (successResult && successResult.result) {
                const { title, size } = successResult.result;
                if (typeof HistoryManager !== "undefined" && HistoryManager.addRecord) {
                    HistoryManager.addRecord({
                        name: title,
                        size: size,
                        service: "Direct Download",
                        resultUrl: "Embedded PDF (Exported)",
                        status: "completed"
                    });
                }
                this.toast(`✓ Exported and downloaded "${title}" (${this.sizeConvert(size)})!`, 3500);
            } else {
                const errResult = results?.find(r => r.result?.error);
                const msg = errResult?.result?.error || "PDFViewerApplication was not found or has not loaded a document yet.";
                this.toast(msg, 4000, true);
            }
        } catch (err) {
            this.toast(`Extraction error: ${err.message}`, 4000, true);
        }
    }

    async extractAndUploadPdf(itemData, uploadService) {
        if (!this.tab || !this.tab.id) return;
        if (!chrome.scripting || typeof chrome.scripting.executeScript !== "function") {
            this.toast("Scripting API not loaded: please reload FetchStream at chrome://extensions", 4500, true);
            return;
        }

        const svc = uploadService || (this.options.upload?.service !== "local" ? this.options.upload?.service : "all");
        if (!svc || svc === "local") {
            this.toast("Please select an Upload Destination", 3500, true);
            if (this.offcanvas) this.offcanvas.show();
            return;
        }

        this.toast(`Exporting PDF and preparing upload to ${this.getServiceDisplayName(svc)}...`, 3000);

        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: this.tab.id, allFrames: true },
                world: "MAIN",
                func: async () => {
                    try {
                        let app = window.PDFViewerApplication;
                        if (!app && window.frames) {
                            for (let i = 0; i < window.frames.length; i++) {
                                try {
                                    if (window.frames[i].PDFViewerApplication) {
                                        app = window.frames[i].PDFViewerApplication;
                                        break;
                                    }
                                } catch (e) {}
                            }
                        }

                        if (!app || !app.pdfDocument || typeof app.pdfDocument.getData !== "function") {
                            return { success: false, error: "No PDFViewerApplication found." };
                        }

                        const data = await app.pdfDocument.getData();
                        let title = document.title || "document";
                        try {
                            if (app.pdfDocument.metadata?.info?.Title) {
                                title = app.pdfDocument.metadata.info.Title;
                            }
                        } catch (e) {}
                        title = title.replace(/[\\/:*?"<>|]/g, "_").trim();
                        if (!title.toLowerCase().endsWith(".pdf")) title += ".pdf";

                        const bytes = new Uint8Array(data);
                        const len = bytes.byteLength;
                        let binaryStr = "";
                        const chunkSize = 8192;
                        for (let i = 0; i < len; i += chunkSize) {
                            const chunk = bytes.subarray(i, i + chunkSize);
                            binaryStr += String.fromCharCode.apply(null, chunk);
                        }
                        const b64 = btoa(binaryStr);
                        return { success: true, title, base64: b64, size: len };
                    } catch (err) {
                        return { success: false, error: err.message };
                    }
                }
            });

            const successResult = results?.find(r => r.result?.success)?.result;
            if (!successResult) {
                this.toast("Failed to extract PDF data from page viewer.", 4000, true);
                return;
            }

            const { title, base64, size } = successResult;
            const byteCharacters = atob(base64);
            const byteArrays = [];
            for (let offset = 0; offset < byteCharacters.length; offset += 512) {
                const slice = byteCharacters.slice(offset, offset + 512);
                const byteNumbers = new Array(slice.length);
                for (let i = 0; i < slice.length; i++) {
                    byteNumbers[i] = slice.charCodeAt(i);
                }
                byteArrays.push(new Uint8Array(byteNumbers));
            }
            const pdfBlob = new Blob(byteArrays, { type: "application/pdf" });
            const pdfFile = new File([pdfBlob], title, { type: "application/pdf" });

            const uploadId = `upload_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
            const uploadConfig = {
                service: svc,
                credentials: this.options.upload?.credentials || {}
            };

            chrome.runtime.sendMessage({
                cmd: "REGISTER_UPLOAD",
                parameter: { id: uploadId, name: title, service: svc, size: size }
            });
            this.renderActiveUpload({
                id: uploadId,
                name: title,
                service: svc,
                size: size,
                progress: 0,
                state: "uploading"
            });

            FetchStreamUploader.upload(
                pdfFile,
                title,
                uploadConfig,
                (loaded, total) => {
                    const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
                    chrome.runtime.sendMessage({
                        cmd: "UPDATE_UPLOAD_PROGRESS",
                        parameter: { id: uploadId, progress: pct, speed: `${pct}%`, uploadedBytes: loaded, totalBytes: total }
                    });
                    this.renderActiveUpload({
                        id: uploadId,
                        name: title,
                        service: svc,
                        progress: pct,
                        state: "uploading"
                    });
                }
            ).then((res) => {
                const finalUrl = res?.url || "";
                chrome.runtime.sendMessage({
                    cmd: "UPLOAD_FINISHED",
                    parameter: { id: uploadId, url: finalUrl }
                });
                if (typeof HistoryManager !== "undefined" && HistoryManager.addRecord) {
                    HistoryManager.addRecord({
                        name: title,
                        size: size,
                        service: svc,
                        resultUrl: finalUrl,
                        status: "completed"
                    });
                }
                if (finalUrl) {
                    const matched = this.items.find(i => i.detail.isProtectedPdf || (itemData && i.requestId === itemData.requestId) || (i.detail.name === title));
                    if (matched) {
                        this.showItemCopyButton(matched, finalUrl);
                    }
                }
                this.toast(`✓ Uploaded "${title}" to ${this.getServiceDisplayName(svc)}!`, 4000);
            }).catch((err) => {
                chrome.runtime.sendMessage({
                    cmd: "UPLOAD_FINISHED",
                    parameter: { id: uploadId, error: err.message }
                });
                this.toast(`Upload failed: ${err.message}`, 4500, true);
            });
        } catch (e) {
            this.toast(`Upload failed: ${e.message}`, 4000, true);
        }
    }

    optionRender() {
        if (this.bootstrap && this.bootstrap.Offcanvas) {
            this.offcanvas = new this.bootstrap.Offcanvas(this.$options);
            this.$optionsBtn.onclick = () => this.offcanvas.toggle();
        } else {
            this.$optionsBtn.onclick = () => this.$options.classList.toggle("show");
        }

        const $sizeMin = this.selector("sizeMin", false, this.$options);
        const $sizeMax = this.selector("sizeMax", false, this.$options);
        const $concurrency = this.selector("concurrency", false, this.$options);
        const $retries = this.selector("retries", false, this.$options);

        if ($sizeMin) $sizeMin.value = this.options.size.min ? this.options.size.min / 1024 : 0;
        if ($sizeMax) $sizeMax.value = this.options.size.max ? this.options.size.max / 1024 : 0;
        if ($concurrency) $concurrency.value = this.options.concurrency || 6;
        if ($retries) $retries.value = this.options.retries || 3;

        const updateCurrentTabBtnState = () => {
            if (this.$currentTabOnlyBtn) {
                if (this.options.currentTabOnly) {
                    this.$currentTabOnlyBtn.classList.add("text-primary");
                    this.$currentTabOnlyBtn.style.borderColor = "var(--primary)";
                    this.$currentTabOnlyBtn.style.backgroundColor = "var(--bg-surface-hover)";
                } else {
                    this.$currentTabOnlyBtn.classList.remove("text-primary");
                    this.$currentTabOnlyBtn.style.borderColor = "";
                    this.$currentTabOnlyBtn.style.backgroundColor = "";
                }
                this.$currentTabOnlyBtn.style.opacity = this.options.keepHistory ? "1" : "0.5";
            }
        };

        updateCurrentTabBtnState();

        if (this.$currentTabOnlyBtn) {
            this.$currentTabOnlyBtn.onclick = () => {
                if (!this.options.keepHistory) {
                    this.toast("Enable 'Keep History' in settings first.", 2000, true);
                    return;
                }
                this.options.currentTabOnly = !this.options.currentTabOnly;
                updateCurrentTabBtnState();
                this.saveOptions().then(() => {
                    this.applyFilter();
                    this.updateCategoryCounts();
                });
            };
        }

        if (this.$keepHistoryToggle) {
            this.$keepHistoryToggle.checked = this.options.keepHistory;
            this.$keepHistoryToggle.onchange = () => {
                this.options.keepHistory = this.$keepHistoryToggle.checked;
                if (!this.options.keepHistory) {
                    this.options.currentTabOnly = false;
                }
                updateCurrentTabBtnState();
                this.saveOptions().then(() => {
                    this.applyFilter();
                    this.updateCategoryCounts();
                });
            };
        }

        const $openFiltersPageBtn = document.getElementById("openFiltersPageBtn");
        if ($openFiltersPageBtn) {
            $openFiltersPageBtn.onclick = (e) => {
                e.preventDefault();
                const filtersUrl = chrome.runtime.getURL("filters.html");
                chrome.tabs.query({}, (tabs) => {
                    const existing = tabs.find(t => t.url && t.url.startsWith(filtersUrl));
                    if (existing) {
                        chrome.tabs.update(existing.id, { active: true });
                        chrome.windows.update(existing.windowId, { focused: true });
                    } else {
                        chrome.tabs.create({ url: filtersUrl });
                    }
                });
            };
        }

        for (const domain of this.options.domain) {
            this.createOptionDomain(domain);
        }

        if ($sizeMin) {
            $sizeMin.oninput = () => {
                let val = parseInt($sizeMin.value, 10) || 0;
                this.options.size.min = Math.max(0, val) * 1024;
                this.applyFilter();
                this.updateCategoryCounts();
            };
            $sizeMin.onblur = () => {
                let val = parseInt($sizeMin.value, 10) || 0;
                val = Math.max(0, val) * 1024;
                if (val !== this.options.size.min) {
                    this.options.size.min = val;
                    this.saveOptions().then(() => {
                        this.toast("Settings saved successfully!");
                        this.applyFilter();
                        this.updateCategoryCounts();
                    });
                }
            };
        }

        if ($sizeMax) {
            $sizeMax.oninput = () => {
                let val = parseInt($sizeMax.value, 10) || 0;
                this.options.size.max = Math.max(0, val) * 1024;
                this.applyFilter();
                this.updateCategoryCounts();
            };
            $sizeMax.onblur = () => {
                let val = parseInt($sizeMax.value, 10) || 0;
                val = Math.max(0, val) * 1024;
                if (val !== this.options.size.max) {
                    this.options.size.max = val;
                    this.saveOptions().then(() => {
                        this.toast("Settings saved successfully!");
                        this.applyFilter();
                        this.updateCategoryCounts();
                    });
                }
            };
        }

        if ($concurrency) {
            $concurrency.onchange = () => {
                this.options.concurrency = parseInt($concurrency.value, 10) || 6;
                this.saveOptions().then(() => this.toast("Settings saved successfully!"));
            };
        }

        if ($retries) {
            $retries.onchange = () => {
                this.options.retries = parseInt($retries.value, 10) || 3;
                this.saveOptions().then(() => this.toast("Settings saved successfully!"));
            };
        }

        const $uploadService = this.selector("uploadService", false, this.$options);
        const $configPanels = this.$options.querySelector("#uploadConfigPanels");

        if ($uploadService && $configPanels) {
            if (!this.options.upload) {
                this.options.upload = { service: "local", credentials: {} };
            }
            if (!this.options.upload.credentials) {
                this.options.upload.credentials = {};
            }

            const currentService = this.options.upload.service || "local";
            $uploadService.value = currentService;

            if (!this.options.upload.customList || !this.options.upload.customList.length) {
                this.options.upload.customList = ["gofile.io", "buzzheavier.com"];
            }

            const updateCustomUploadSummary = () => {
                const summaryEl = document.getElementById("customUploadSummaryText");
                if (summaryEl) {
                    summaryEl.textContent = this.formatCustomListSummary(this.options.upload.customList);
                }
            };
            updateCustomUploadSummary();

            const btnConfigCustomUpload = document.getElementById("btnConfigureCustomUpload");
            if (btnConfigCustomUpload) {
                btnConfigCustomUpload.onclick = (e) => {
                    e.preventDefault();
                    this.openMultiHostModal({
                        context: 'settings-local',
                        currentList: this.options.upload.customList,
                        onSave: (list) => {
                            this.options.upload.customList = list;
                            updateCustomUploadSummary();
                            this.saveOptions().then(() => this.toast("Custom upload destinations saved!"));
                        }
                    });
                };
            }

            const showActivePanel = (service) => {
                const panels = $configPanels.querySelectorAll(".upload-panel");
                panels.forEach(p => {
                    const s = p.getAttribute("data-service");
                    if (s === service) {
                        p.classList.remove("d-none");
                        if (s === "custom") {
                            updateCustomUploadSummary();
                        } else {
                            const creds = this.options.upload.credentials[service] || {};
                            p.querySelectorAll("[data-field]").forEach(input => {
                                const field = input.getAttribute("data-field");
                                if (creds[field] !== undefined) {
                                    input.value = creds[field];
                                }
                            });
                        }
                    } else {
                        p.classList.add("d-none");
                    }
                });
            };

            showActivePanel(currentService);

            $uploadService.onchange = () => {
                const selected = $uploadService.value;
                this.options.upload.service = selected;
                showActivePanel(selected);
                this.saveOptions().then(() => this.toast("Upload destination updated!"));
            };

            $configPanels.querySelectorAll("[data-field]").forEach(input => {
                const panel = input.closest(".upload-panel");
                if (!panel) return;
                const service = panel.getAttribute("data-service");

                input.oninput = () => {
                    if (!this.options.upload.credentials[service]) {
                        this.options.upload.credentials[service] = {};
                    }
                    const field = input.getAttribute("data-field");
                    this.options.upload.credentials[service][field] = input.value.trim();
                };

                input.onblur = () => {
                    this.saveOptions().then(() => this.toast("Configuration saved!"));
                };
            });
        }

        const $srvDefaultService = this.selector("serverUploadDefaultService", false, this.$options);
        const $srvRelayUrl = this.selector("serverUploadRelayUrl", false, this.$options);
        const $srvApiKey = this.selector("serverUploadApiKey", false, this.$options);
        const $srvFallbackProxy = this.selector("serverUploadFallbackProxy", false, this.$options);

        if (!this.options.serverUpload) {
            this.options.serverUpload = {
                relayUrl: "",
                apiKey: "",
                service: "gofile.io",
                customList: ["gofile.io", "buzzheavier.com"],
                useFallbackProxy: true
            };
        }
        if (!this.options.serverUpload.customList || !this.options.serverUpload.customList.length) {
            this.options.serverUpload.customList = ["gofile.io", "buzzheavier.com"];
        }

        const customServerUploadBox = document.getElementById("customServerUploadBox");
        const customServerUploadSummaryText = document.getElementById("customServerUploadSummaryText");
        const btnConfigureCustomServerUpload = document.getElementById("btnConfigureCustomServerUpload");

        const updateCustomServerUploadUI = () => {
            const isCustom = this.options.serverUpload.service === "custom";
            if (customServerUploadBox) {
                if (isCustom) {
                    customServerUploadBox.classList.remove("d-none");
                } else {
                    customServerUploadBox.classList.add("d-none");
                }
            }
            if (customServerUploadSummaryText) {
                customServerUploadSummaryText.textContent = this.formatCustomListSummary(this.options.serverUpload.customList);
            }
        };

        if (btnConfigureCustomServerUpload) {
            btnConfigureCustomServerUpload.onclick = (e) => {
                e.preventDefault();
                this.openMultiHostModal({
                    context: 'settings-server',
                    currentList: this.options.serverUpload.customList,
                    onSave: (list) => {
                        this.options.serverUpload.customList = list;
                        updateCustomServerUploadUI();
                        this.saveOptions().then(() => this.toast("Custom server upload destinations saved!"));
                    }
                });
            };
        }

        if ($srvDefaultService) {
            $srvDefaultService.value = this.options.serverUpload.service || "gofile.io";
            updateCustomServerUploadUI();
            $srvDefaultService.onchange = () => {
                this.options.serverUpload.service = $srvDefaultService.value;
                updateCustomServerUploadUI();
                this.saveOptions().then(() => this.toast("Server upload default destination updated!"));
            };
        }

        if ($srvRelayUrl) {
            $srvRelayUrl.value = this.options.serverUpload.relayUrl || "";
            const persistRelayUrl = () => {
                this.options.serverUpload.relayUrl = $srvRelayUrl.value.trim();
                this.saveOptions();
            };
            $srvRelayUrl.oninput = persistRelayUrl;
            $srvRelayUrl.onchange = persistRelayUrl;
            $srvRelayUrl.onblur = () => {
                persistRelayUrl();
                this.toast("Server Upload URL saved!");
            };
        }

        if ($srvApiKey) {
            $srvApiKey.value = this.options.serverUpload.apiKey || "";
            const persistApiKey = () => {
                this.options.serverUpload.apiKey = $srvApiKey.value.trim();
                this.saveOptions();
            };
            $srvApiKey.oninput = persistApiKey;
            $srvApiKey.onchange = persistApiKey;
            $srvApiKey.onblur = () => {
                persistApiKey();
                this.toast("Server API Key saved!");
            };
        }

        const $docLink = document.getElementById("linkServerDocumentation");
        if ($docLink) {
            $docLink.onclick = (e) => {
                e.preventDefault();
                const docUrl = "https://fetchstream.in/documentation";
                if (chrome.tabs?.create) {
                    chrome.tabs.create({ url: docUrl });
                } else {
                    window.open(docUrl, "_blank");
                }
            };
        }

        if ($srvFallbackProxy) {
            $srvFallbackProxy.checked = this.options.serverUpload.useFallbackProxy !== false;
            $srvFallbackProxy.onchange = () => {
                this.options.serverUpload.useFallbackProxy = $srvFallbackProxy.checked;
                this.saveOptions().then(() => this.toast("Proxy fallback setting saved!"));
            };
        }

        const $addDomainInput = this.selector("addDomainInput", false, this.$options);
        const $addDomainBtn = this.selector("addDomainBtn", false, this.$options);

        const handleAddDomain = () => {
            if (!$addDomainInput) return;
            let val = $addDomainInput.value.trim().toLowerCase();
            if (!val) return;

            if (val.startsWith("http://") || val.startsWith("https://")) {
                try {
                    val = new URL(val).hostname.toLowerCase();
                } catch (e) {}
            }
            val = val.replace(/^\*\./, "").replace(/^\/+|\/+$/g, "");
            if (!val) return;

            if (this.options.domain.includes(val)) {
                this.toast("Domain already in blocklist");
                $addDomainInput.value = "";
                return;
            }

            this.options.domain.push(val);
            this.createOptionDomain(val);
            this.saveOptions(true).then(() => {
                this.toast(`Blocked: ${val}`);
                $addDomainInput.value = "";

                const toRemove = [];
                this.items.forEach(item => {
                    try {
                        const h = new URL(item.detail.url).hostname.toLowerCase();
                        if (h === val || h.endsWith("." + val)) {
                            toRemove.push(item);
                        }
                    } catch (e) {}
                });
                toRemove.forEach(item => {
                    item.$item.remove();
                    const idx = this.items.indexOf(item);
                    if (idx > -1) this.items.splice(idx, 1);
                });
                this.updateBadge();
            });
        };

        if ($addDomainBtn) $addDomainBtn.onclick = handleAddDomain;
        if ($addDomainInput) {
            $addDomainInput.onkeydown = (e) => {
                if (e.key === "Enter") handleAddDomain();
            };
        }
    }

    createOptionDomain(domain) {
        const $domainContainer = this.selector("domain", false, this.$options);
        const $noDomainText = this.selector("noDomain", false, this.$options);

        if ($noDomainText && !$noDomainText.classList.contains("d-none")) {
            $noDomainText.classList.add("d-none");
        }

        const $row = document.createElement("div");
        $row.className = "d-flex justify-content-between align-items-center mb-1.5 p-1.5 rounded";
        $row.style.backgroundColor = "var(--bg-surface-hover)";

        const $name = document.createElement("span");
        $name.className = "text-truncate me-2 small";
        $name.innerText = domain;

        const $delBtn = document.createElement("button");
        $delBtn.className = "btn btn-sm btn-link text-danger p-0";
        $delBtn.innerHTML = '<i class="bi bi-trash3"></i>';

        $row.appendChild($name);
        $row.appendChild($delBtn);
        $domainContainer.appendChild($row);

        $delBtn.onclick = () => {
            const index = this.options.domain.indexOf(domain);
            if (index > -1) {
                this.options.domain.splice(index, 1);
                this.saveOptions();
            }
            $row.remove();
            if (this.options.domain.length === 0 && $noDomainText) {
                $noDomainText.classList.remove("d-none");
            }
        };
    }

    saveOptions(triggerReset = false) {
        const optionsCopy = JSON.parse(JSON.stringify(this.options));
        optionsCopy.size.min = optionsCopy.size.min / 1024;
        optionsCopy.size.max = optionsCopy.size.max / 1024;
        
        // Ensure credentials are never saved in plaintext local storage
        if (optionsCopy.upload && optionsCopy.upload.credentials) {
            delete optionsCopy.upload.credentials;
        }

        return new Promise((resolve) => {
            chrome.storage.local.set({ options: optionsCopy }).then(() => {
                const param = triggerReset ? { storageKey: this.storageKey } : {};
                chrome.runtime.sendMessage({ cmd: "RESET_OPTIONS", parameter: param }, () => {
                    resolve();
                });
            });
        });
    }

    getOptions() {
        return new Promise((resolve) => {
            chrome.storage.local.get(["options"]).then(({ options }) => {
                if (options) {
                    for (const key in this.options) {
                        if (options.hasOwnProperty(key)) {
                            this.options[key] = options[key];
                        }
                    }
                }
                if (this.options.size?.min) this.options.size.min *= 1024;
                if (this.options.size?.max) this.options.size.max *= 1024;
                resolve();
            }).catch(() => resolve());
        });
    }

    creatRules(headers) {
        const rules = [];
        if (!headers) return null;
        let hasOriginOrReferer = false;

        for (const key in headers) {
            const lower = key.toLowerCase();
            if (lower === "origin" || lower === "referer") {
                hasOriginOrReferer = true;
            }
            rules.push({ header: key, operation: "set", value: headers[key] });
        }
        return hasOriginOrReferer ? rules : null;
    }

    setRules(headers, domains) {
        return new Promise((resolve) => {
            try {
                const condition = {
                    domainType: "thirdParty",
                    resourceTypes: ["xmlhttprequest", "media"],
                    tabIds: [-1]
                };

                if (typeof domains === "string") {
                    condition.urlFilter = domains;
                } else if (Array.isArray(domains)) {
                    condition.requestDomains = domains;
                }

                chrome.declarativeNetRequest.updateSessionRules({
                    removeRuleIds: [this.ruleId],
                    addRules: [{
                        id: this.ruleId,
                        priority: 1,
                        action: { type: "modifyHeaders", requestHeaders: headers },
                        condition: condition
                    }]
                }, () => resolve(this.ruleId));
            } catch (err) {
                resolve(0);
            }
        });
    }

    removeRules() {
        chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [this.ruleId] });
    }

    getTopLevelDomain(url) {
        try {
            const hostname = new URL(url).hostname;
            const parts = hostname.split(".");
            if (parts.length >= 3 && ["co", "com", "org", "net", "gov", "edu"].includes(parts[parts.length - 2])) {
                return parts.slice(-3).join(".");
            }
            return parts.slice(-2).join(".");
        } catch (e) {
            return "";
        }
    }

    player(details, container, resolutionElement, onResolutionFound = null) {
        const video = document.createElement("video");
        video.autoplay = true;
        video.controls = true;
        video.style.maxWidth = "100%";
        video.style.maxHeight = "240px";
        container.appendChild(video);

        let detectedCodec = "";

        const formatResolution = (width, height, codec) => {
            const h = Math.min(width, height);
            let pLabel = `${h}p`;
            if (h >= 2160) pLabel = "4K UHD";
            else if (h >= 1080) pLabel = "1080p FHD";
            else if (h >= 720) pLabel = "720p HD";
            else if (h >= 480) pLabel = "480p";
            else if (h >= 360) pLabel = "360p";

            const codecShort = codec ? ` • ${codec.split(".")[0].toUpperCase()}` : "";
            return {
                badgeLabel: pLabel,
                headerLabel: `${pLabel} (${width}x${height})${codecShort}`
            };
        };

        const updateDetectedInfo = () => {
            if (video.videoWidth && video.videoHeight) {
                const { badgeLabel, headerLabel } = formatResolution(video.videoWidth, video.videoHeight, detectedCodec);

                if (resolutionElement) {
                    resolutionElement.innerHTML = `<strong>${headerLabel}</strong>`;
                }

                if (typeof onResolutionFound === "function") {
                    onResolutionFound(badgeLabel);
                }

                details.resolution = badgeLabel;
                if (this.storageKey && details.requestId) {
                    chrome.storage.local.get([this.storageKey], (res) => {
                        const stored = res?.[this.storageKey] || {};
                        if (stored[details.requestId]) {
                            stored[details.requestId].resolution = badgeLabel;
                            chrome.storage.local.set({ [this.storageKey]: stored });
                        }
                    });
                }
            }
        };

        video.addEventListener("loadedmetadata", updateDetectedInfo);
        video.addEventListener("resize", updateDetectedInfo);

        const rules = this.creatRules(details.headers);

        if (details.type === "hls" && Hls.isSupported()) {
            const domains = [];
            const hls = new Hls({ autoStartLoad: false });

            hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
                hls.startLoad();
                let width = 0;
                let height = 0;
                for (const level of data.levels) {
                    if (level.width && level.height && level.width > width) {
                        width = level.width;
                        height = level.height;
                    }
                }
                if (width && height) {
                    const { badgeLabel, headerLabel } = formatResolution(width, height, detectedCodec);
                    if (resolutionElement) resolutionElement.innerHTML = `<strong>${headerLabel}</strong>`;
                    if (typeof onResolutionFound === "function") onResolutionFound(badgeLabel);
                }
            });

            hls.on(Hls.Events.BUFFER_CODECS, (event, data) => {
                if (data.video && data.video.codec) {
                    detectedCodec = data.video.codec;
                    updateDetectedInfo();
                }
            });

            hls.on(Hls.Events.DESTROYING, () => {
                if (rules) this.removeRules();
            });

            if (rules) {
                domains.push(this.getTopLevelDomain(details.url));
                this.setRules(rules, domains).then(() => {
                    hls.loadSource(details.url);
                    hls.attachMedia(video);
                });
            } else {
                hls.loadSource(details.url);
                hls.attachMedia(video);
            }
            return hls;
        } else {
            if (rules) {
                this.setRules(rules, details.url).then(() => {
                    video.src = details.url;
                });
            } else {
                video.src = details.url;
            }
            return {
                destroy: () => {
                    try {
                        video.pause();
                        video.removeAttribute("src");
                        video.load();
                    } catch (e) {}
                }
            };
        }
    }

    async downloadStream(details, action = "download", overrideService = null) {
        let rawName = details.name ? details.name.trim() : "stream";
        try {
            rawName = decodeURIComponent(rawName);
        } catch (e) {}
        const cleanName = rawName.replace(/[\\/:*?"<>|]/g, "_");
        const targetUrl = details.selectedVariantUrl || details.url;
        let uploadService = overrideService || details.uploadService || (this.options.upload?.service !== "local" ? this.options.upload?.service : "gofile.io");
        if (uploadService === "custom") {
            uploadService = (details.customList && details.customList.length > 0)
                ? details.customList.join(",")
                : ((this.options.upload?.customList && this.options.upload.customList.length > 0)
                    ? this.options.upload.customList.join(",")
                    : "gofile.io");
        }

        if (action === "upload" && (!uploadService || uploadService === "local")) {
            this.toast("Please select an Upload Destination or pick one from the Upload dropdown", 3500, true);
            if (this.offcanvas) this.offcanvas.show();
            return;
        }

        const format = (details.format || "").toLowerCase();
        let fileName = cleanName;

        const isHls = details.type === "hls" || (targetUrl && (targetUrl.toLowerCase().includes(".m3u8") || targetUrl.toLowerCase().includes(".m3u")));
        if (isHls) {
            const targetExt = format === "mp3" ? ".mp3" : ".mp4";
            if (fileName.toLowerCase().endsWith(".m3u8") || fileName.toLowerCase().endsWith(".m3u")) {
                fileName = fileName.replace(/\.m3u8?$/i, targetExt);
            } else if (!fileName.toLowerCase().endsWith(targetExt)) {
                fileName = `${fileName}${targetExt}`;
            }
        } else {
            const dotIdx = fileName.lastIndexOf(".");
            if (dotIdx !== -1) {
                const curExt = fileName.substring(dotIdx).toLowerCase();
                if (format === "mp3" && (curExt === ".mp4" || curExt === ".m4a")) {
                    fileName = fileName.substring(0, dotIdx) + ".mp3";
                }
            } else {
                const ext = format ? `.${format}` : "";
                if (ext) fileName = `${fileName}${ext}`;
            }
        }

        if (action === "upload") {
            const isHls = details.type === "hls" || 
                          (targetUrl && targetUrl.toLowerCase().includes(".m3u8")) || 
                          (details.format && details.format.toLowerCase() === "m3u8");
            let estimatedSize = typeof ServiceLimits !== "undefined" ? ServiceLimits.estimateStreamSize(details) : 0;
            const streamMeta = {
                isHls,
                url: targetUrl,
                format: details.format,
                duration: details.duration || details.estimatedDuration || 0
            };

            if (estimatedSize <= 0 && isHls && typeof ServiceLimits !== "undefined" && ServiceLimits.probeStreamSize) {
                try {
                    estimatedSize = await ServiceLimits.probeStreamSize(details);
                    if (details.estimatedDuration) streamMeta.duration = details.estimatedDuration;
                } catch (probeErr) {}
            }

            const preFlight = await this.confirmPreFlight(fileName, estimatedSize, uploadService, false, streamMeta);
            if (!preFlight.proceed || !preFlight.services || preFlight.services.length === 0) {
                return;
            }
            uploadService = Array.isArray(preFlight.services) ? preFlight.services.join(',') : preFlight.services;
        }

        if (details.type === "hls" || action === "upload") {
            const dlId = `dl_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

            const dlData = {
                ...details,
                id: dlId,
                name: fileName,
                url: targetUrl,
                selectedUrl: targetUrl,
                resolution: details.resolution || details.selectedResolution || null,
                action: action,
                uploadService: action === "upload" ? uploadService : null,
                telegramCaption: details.telegramCaption || "",
                preFlightConfirmed: true
            };

            const downloaderUrl = chrome.runtime.getURL("downloader.html");
            chrome.tabs.query({}, (tabs) => {
                const existingTab = tabs.find(t => t.url && t.url.startsWith(downloaderUrl));

                if (existingTab) {
                    chrome.storage.local.set({ [dlId]: dlData }, () => {
                        chrome.tabs.sendMessage(existingTab.id, {
                            cmd: "ADD_DOWNLOAD_TASK",
                            parameter: dlData
                        }, (response) => {
                            if (chrome.runtime.lastError || !response?.received) {
                                chrome.storage.local.set({ dl_queue: dlData });
                            }
                        });
                    });
                } else {
                    chrome.storage.local.set({ [dlId]: dlData, dl_queue: dlData }, () => {
                        chrome.tabs.create({ url: `${downloaderUrl}?id=${dlId}`, active: false });
                    });
                }

                this.renderActiveDownload({
                    id: dlId,
                    name: fileName,
                    progress: 0,
                    speed: action === "upload" ? `Uploading to ${this.getServiceDisplayName(uploadService)}...` : "Starting...",
                    completedSegments: 0,
                    totalSegments: 0,
                    state: "downloading"
                });

                this.toast(action === "upload" ? `Upload task (${this.getServiceDisplayName(uploadService)}) queued!` : "Download queued in Downloads Manager!", 2500);
            });
        } else {
            chrome.downloads.download({
                url: targetUrl,
                filename: fileName,
                saveAs: true
            }, (downloadId) => {
                if (chrome.runtime.lastError) {
                    chrome.tabs.create({ url: targetUrl });
                } else if (downloadId) {
                    if (typeof HistoryManager !== "undefined" && HistoryManager.addRecord) {
                        HistoryManager.addRecord({
                            name: fileName,
                            size: details.size || 0,
                            service: "Direct Download",
                            resultUrl: targetUrl,
                            status: "completed"
                        });
                    }
                }
            });
        }
    }

    itemCreate(itemData) {
        let playerInstance = null;
        const $item = this.$templateItem.cloneNode(true);
        
        let isCurrentPage = false;
        if (this.tab && this.tab.url && itemData.pageUrl) {
            try {
                const u1 = new URL(this.tab.url);
                const u2 = new URL(itemData.pageUrl);
                if (u1.hostname.includes('youtube.com')) {
                    if (u1.searchParams.get('v') === u2.searchParams.get('v')) isCurrentPage = true;
                } else if (u1.origin === u2.origin && u1.pathname === u2.pathname) {
                    isCurrentPage = true;
                }
            } catch (e) {
                if (this.tab.url.split('?')[0].split('#')[0] === itemData.pageUrl.split('?')[0].split('#')[0]) {
                    isCurrentPage = true;
                }
            }
        }

        const itemObj = {
            requestId: itemData.requestId,
            detail: itemData,
            $item: $item,
            isCurrentPage: isCurrentPage
        };

        const $playBtn = this.selector("play", false, $item);
        const $itemIcon = this.selector("item-icon", false, $item);
        const $nameInput = this.selector("name-input", false, $item);
        const $renameBtn = this.selector("rename-btn", false, $item);
        const $size = this.selector("size", false, $item);
        const $qualitySelect = this.selector("quality-select", false, $item);
        const $resBadge = this.selector("res-badge", false, $item);
        const $urlToggle = this.selector("url-toggle", false, $item);
        const $downloadBtn = this.selector("download", false, $item);
        const $blockedBtn = this.selector("blocked", false, $item);
        const $urlCollapse = this.selector("url-collapse", false, $item);
        const $url = this.selector("url", false, $item);
        const $urlClose = this.selector("url-close", false, $item);
        const $copyBtn = this.selector("copy", false, $item);
        const $playerCollapse = this.selector("player-collapse", false, $item);
        const $resolution = this.selector("resolution", false, $item);
        const $playerContainer = this.selector("player", false, $item);
        const $playerClose = this.selector("player-close", false, $item);
        const $uploadBtn = this.selector("upload", false, $item);
        const $uploadText = this.selector("uploadText", false, $item);
        const $serviceSelectBtn = this.selector("serviceSelectBtn", false, $item);
        const $serviceSelectText = this.selector("serviceSelectText", false, $item);
        const $uploadDropdownMenu = this.selector("uploadDropdownMenu", false, $item);
        const $serverUploadBtn = this.selector("serverUpload", false, $item);
        const $serverUploadText = this.selector("serverUploadText", false, $item);
        const $captionContainer = this.selector("captionContainer", false, $item);
        const $captionInput = this.selector("captionInput", false, $item);
        const $currentPageBadge = this.selector("current-page-badge", false, $item);

        if ($captionInput) {
            $captionInput.value = itemData.telegramCaption || "";
            $captionInput.oninput = () => {
                itemData.telegramCaption = $captionInput.value;
            };
        }

        if ($currentPageBadge && isCurrentPage) {
            $currentPageBadge.classList.remove("d-none");
        }

        const { category, subCategory } = this.categorizeItem(itemData);
        itemData.category = category;
        itemData.subCategory = subCategory;

        let initialService = itemData.uploadService;
        if (!initialService) {
            if (this.options.upload?.service && this.options.upload.service !== "local") {
                initialService = this.options.upload.service;
            } else if (this.options.serverUpload?.service) {
                initialService = this.options.serverUpload.service;
            } else {
                initialService = "gofile.io";
            }
        }
        itemData.uploadService = initialService;
        if (!itemData.customList || !itemData.customList.length) {
            itemData.customList = [...(this.options.upload?.customList || this.options.serverUpload?.customList || ["gofile.io", "buzzheavier.com"])];
        }

        const updateServiceSelectUI = async () => {
            const svc = itemData.uploadService || "gofile.io";
            const customCount = (itemData.customList || []).length;
            const dispName = this.getServiceDisplayName(svc, customCount);
            if ($serviceSelectText) {
                $serviceSelectText.textContent = `Dest: ${dispName}`;
            }
            if ($serviceSelectBtn) {
                if (svc === "custom" || svc.includes(",")) {
                    const listSummary = (itemData.customList || []).map(s => this.getServiceDisplayName(s)).join(", ");
                    $serviceSelectBtn.title = `Destination: Custom List (${listSummary})`;
                } else {
                    $serviceSelectBtn.title = `Destination: ${dispName}`;
                }
            }

            // Dynamic visual disabling based on Vault state (but still clickable to show disclaimers)
            const isSetup = typeof Vault !== 'undefined' ? await Vault.isVaultSetup() : false;
            const creds = isSetup ? await Vault.getUnlockedCreds() : {};
            const isLocked = isSetup && !creds;

            const reqCredServices = {
                'telegram': 'telegramBotToken',
                's3_compatible': 's3AccessKey',
                'b2': 'b2AppKeyId',
                'r2': 'r2AccessKey',
                'pixeldrain.com': 'pixeldrainApiKey'
            };

            let isLocalDisabled = false;
            let isServerDisabled = false;

            // Condition 1: Single service that requires creds
            if (svc !== "custom" && !svc.includes(",")) {
                if (reqCredServices[svc]) {
                    const reqKey = reqCredServices[svc];
                    if (isLocked || (creds && !creds[reqKey])) {
                        isLocalDisabled = true;
                        isServerDisabled = true;
                    }
                }
            }

            // Condition 2: Server Upload MUST have serverRelayUrl
            if (isLocked || (creds && !creds.serverRelayUrl)) {
                isServerDisabled = true;
            }

            if ($uploadBtn) {
                $uploadBtn.disabled = isLocalDisabled;
                $uploadBtn.style.opacity = isLocalDisabled ? "0.4" : "1";
                $uploadBtn.style.filter = isLocalDisabled ? "grayscale(100%)" : "none";
            }
            if ($serverUploadBtn) {
                $serverUploadBtn.disabled = isServerDisabled;
                $serverUploadBtn.style.opacity = isServerDisabled ? "0.4" : "1";
                $serverUploadBtn.style.filter = isServerDisabled ? "grayscale(100%)" : "none";
            }

            if ($captionContainer) {
                const customArr = Array.isArray(itemData.customList) ? itemData.customList : [];
                const svcParts = typeof svc === "string" ? svc.split(",").map(s => s.trim()) : [];
                const hasTelegram = svc === "telegram" ||
                                    svc === "s3_hf_telegram" ||
                                    svc === "all" ||
                                    svcParts.includes("telegram") ||
                                    customArr.includes("telegram");
                if (hasTelegram) {
                    $captionContainer.classList.remove("d-none");
                } else {
                    $captionContainer.classList.add("d-none");
                }
            }
        };
        updateServiceSelectUI();
        itemObj.updateServiceSelectUI = updateServiceSelectUI;

        if ($itemIcon) {
            function replaceWithImage(srcStr, fallbackClass) {
                const img = document.createElement('img');
                img.src = srcStr;
                img.style = "width: 32px; height: 32px; object-fit: cover; border-radius: 6px; box-shadow: 0 1px 3px rgba(0,0,0,0.15);";
                img.loading = "lazy";
                img.alt = "thumbnail";
                img.onerror = () => {
                    const fallback = document.createElement('i');
                    fallback.className = fallbackClass;
                    fallback.setAttribute('selector', 'item-icon');
                    img.replaceWith(fallback);
                };
                $itemIcon.replaceWith(img);
            }

            if (category === "videos") {
                if (itemData.poster) {
                    replaceWithImage(itemData.poster, "bi bi-play-circle text-primary");
                } else {
                    $itemIcon.className = "bi bi-play-circle text-primary";
                }
                if ($playBtn) $playBtn.title = "Preview Video";
            } else if (category === "audio") {
                $itemIcon.className = "bi bi-music-note-beamed text-info";
                if ($playBtn) $playBtn.title = "Preview Audio";
            } else if (subCategory === "images") {
                replaceWithImage(itemData.url, "bi bi-file-earmark-image text-success");
                if ($playBtn) $playBtn.title = "View Full Image";
            } else if (subCategory === "pdf") {
                $itemIcon.className = "bi bi-file-earmark-pdf text-danger";
                if ($playBtn) $playBtn.title = "Open PDF";
            } else if (subCategory === "sheets") {
                $itemIcon.className = "bi bi-file-earmark-spreadsheet text-success";
                if ($playBtn) $playBtn.title = "Spreadsheet";
            } else if (subCategory === "slides") {
                $itemIcon.className = "bi bi-file-earmark-slides text-warning";
                if ($playBtn) $playBtn.title = "Presentation";
            } else if (subCategory === "archives") {
                $itemIcon.className = "bi bi-file-earmark-zip text-secondary";
                if ($playBtn) $playBtn.title = "Archive";
            } else {
                $itemIcon.className = "bi bi-file-earmark-text text-primary";
                if ($playBtn) $playBtn.title = "Document";
            }
        }

        const fullFileName = itemData.name || "file";
        let originalExt = "";
        let baseName = fullFileName;
        const dotIdx = fullFileName.lastIndexOf(".");
        if (dotIdx > 0) {
            baseName = fullFileName.substring(0, dotIdx);
            originalExt = fullFileName.substring(dotIdx);
        } else if (itemData.format) {
            originalExt = `.${itemData.format.toLowerCase()}`;
        }

        let currentExt = originalExt;

        const getFullName = () => {
            const base = ($nameInput ? $nameInput.value.trim() : "") || baseName || "file";
            return currentExt ? (base.endsWith(currentExt) ? base : base + currentExt) : base;
        };

        const persistName = () => {
            const fullName = getFullName();
            itemData.name = fullName;
            if ($nameInput) $nameInput.setAttribute("title", fullName);
            if (this.storageKey && itemData.requestId) {
                chrome.storage.local.get([this.storageKey], (res) => {
                    const stored = res?.[this.storageKey] || {};
                    if (stored[itemData.requestId]) {
                        stored[itemData.requestId].name = fullName;
                        chrome.storage.local.set({ [this.storageKey]: stored });
                    }
                });
            }
        };

        if ($nameInput) {
            $nameInput.value = baseName;
            $nameInput.setAttribute("title", fullFileName);

            const $extSpan = document.createElement("span");
            $extSpan.className = "badge bg-light text-secondary border font-monospace flex-shrink-0 px-1.5 py-1";
            $extSpan.style.fontSize = "0.75rem";
            $extSpan.style.userSelect = "none";
            $extSpan.style.cursor = "pointer";
            $extSpan.title = "File extension (click to modify)";
            $extSpan.textContent = currentExt || `.${itemData.format || "bin"}`;

            $extSpan.onclick = (e) => {
                e.stopPropagation();
                const promptVal = prompt("Modify file extension (e.g. mp4, mkv, zip):", currentExt.replace(/^\./, ""));
                if (promptVal !== null && promptVal.trim().length > 0) {
                    currentExt = "." + promptVal.trim().replace(/^\./, "").toLowerCase();
                    $extSpan.textContent = currentExt;
                    persistName();
                }
            };

            $nameInput.parentNode.insertBefore($extSpan, $nameInput.nextSibling);

            $nameInput.oninput = () => {
                itemData.name = getFullName();
            };

            $nameInput.onchange = () => {
                persistName();
            };

            $nameInput.onkeydown = (e) => {
                if (e.key === "Enter") $nameInput.blur();
            };
        }

        if ($renameBtn && $nameInput) {
            $renameBtn.onclick = () => {
                $nameInput.focus();
                $nameInput.select();
            };
        }

        if (itemData.isProtectedPdf || itemData.isEmbeddedPdf) {
            $size.innerText = `PDF • ${itemData.numPages ? itemData.numPages + ' Pages' : 'Document'}`;
            $size.className = "size badge bg-danger text-white";
        } else if (itemData.type === "hls") {
            $size.innerText = "HLS Stream";
            $size.classList.add("hls");
        } else {
            const fmt = (itemData.format || "FILE").toUpperCase();
            $size.innerText = `${fmt} • ${this.sizeConvert(itemData.size)}`;

            if ((!itemData.size || itemData.size <= 0) && itemData.url && itemData.url.startsWith("http")) {
                fetch(itemData.url, { method: "HEAD" }).then(res => {
                    const cl = res.headers.get("content-length");
                    if (cl) {
                        const bytes = parseInt(cl, 10);
                        if (bytes > 0) {
                            itemData.size = bytes;
                            $size.innerText = `${fmt} • ${this.sizeConvert(bytes)}`;
                            this.applyFilter();
                            this.updateCategoryCounts();
                        }
                    }
                }).catch(() => {});
            }
        }

        const updateQuality = (variants, resLabel) => {
            if (variants && variants.length > 0) {
                if ($qualitySelect) {
                    $qualitySelect.innerHTML = "";
                    variants.forEach((v, idx) => {
                        const opt = document.createElement("option");
                        opt.value = v.url;
                        opt.textContent = `${v.label}${v.bandwidth ? ` (${Math.round(v.bandwidth / 1000)}k)` : ""}`;
                        if (idx === 0) opt.selected = true;
                        $qualitySelect.appendChild(opt);
                    });
                    $qualitySelect.classList.remove("d-none");

                    itemData.selectedVariantUrl = variants[0].url;
                    itemData.selectedResolution = variants[0].label;

                    $qualitySelect.onchange = () => {
                        itemData.selectedVariantUrl = $qualitySelect.value;
                        const chosen = variants.find((v) => v.url === $qualitySelect.value);
                        if (chosen) itemData.selectedResolution = chosen.label;
                    };
                }
                if ($resBadge) $resBadge.classList.add("d-none");
            } else if (resLabel || itemData.resolution) {
                const label = resLabel || itemData.resolution;
                if ($qualitySelect) $qualitySelect.classList.add("d-none");
                if ($resBadge) {
                    $resBadge.innerText = label;
                    $resBadge.classList.remove("d-none");
                    if (label.includes("1080") || label.includes("4K") || label.includes("2160")) {
                        $resBadge.classList.add("res-hd");
                    }
                }
            } else {
                if ($qualitySelect) $qualitySelect.classList.add("d-none");
                if ($resBadge) $resBadge.classList.add("d-none");
            }
        };

        if (!itemData.resolution && itemData.url && category === "videos") {
            const terms = [
                "_2160p", "2160p", "_2160", "_1440p", "1440p", "_1440", 
                "_1080p", "1080p", "_1080", "_720p", "720p", "_720", 
                "_576p", "576p", "_576", "_480p", "480p", "_480", 
                "_360p", "360p", "_360", "_240p", "240p", "_240", 
                "_160p", "160p", "_160"
            ];
            const urlLower = itemData.url.toLowerCase();
            for (const term of terms) {
                if (urlLower.includes(term)) {
                    const num = term.replace(/[^0-9]/g, '');
                    itemData.resolution = `${num}p*`;
                    if ($resBadge) {
                        $resBadge.setAttribute("title", "*beta feature: quality guessed from URL");
                    }
                    break;
                }
            }
        }

        updateQuality(itemData.variants, itemData.resolution);
        itemObj.updateQuality = updateQuality;

        if (itemData.type === "hls" && (!itemData.variants || itemData.variants.length === 0)) {
            this.probeHlsManifestInPopup(itemData, updateQuality);
        } else if (category === "videos" && !itemData.resolution) {
            this.probePageVideoResolution(itemData, updateQuality);
        }

        $url.innerText = itemData.url;
        $item.updateVaultState = updateServiceSelectUI;
        this.$list.prepend($item);

        let collapseUrl = null;
        let collapsePlayer = null;
        if (this.bootstrap && this.bootstrap.Collapse) {
            collapseUrl = new this.bootstrap.Collapse($urlCollapse, { toggle: false });
            collapsePlayer = new this.bootstrap.Collapse($playerCollapse, { toggle: false });
        } else {
            collapseUrl = {
                toggle: () => $urlCollapse.classList.toggle("show"),
                hide: () => $urlCollapse.classList.remove("show")
            };
            collapsePlayer = {
                toggle: () => $playerCollapse.classList.toggle("show"),
                hide: () => $playerCollapse.classList.remove("show")
            };
        }

        if ($urlToggle) {
            $urlToggle.onclick = () => {
                collapsePlayer.hide();
                collapseUrl.toggle();
            };
        }

        $urlClose.onclick = () => collapseUrl.hide();
        $playerClose.onclick = () => collapsePlayer.hide();

        $playerCollapse.addEventListener("hide.bs.collapse", () => {
            if (playerInstance && typeof playerInstance.destroy === "function") {
                playerInstance.destroy();
                playerInstance = null;
            }
            if ($playerContainer.firstElementChild) {
                const el = $playerContainer.firstElementChild;
                if (el.tagName === "VIDEO") {
                    try {
                        el.pause();
                        el.removeAttribute("src");
                        el.load();
                    } catch (e) {}
                }
                el.remove();
            }
        });

        $playBtn.onclick = () => {
            collapseUrl.hide();
            if (category === "videos" || category === "audio") {
                if (!$playerCollapse.classList.contains("show")) {
                    playerInstance = this.player(itemData, $playerContainer, $resolution, (resLabel) => {
                        updateQuality(null, resLabel);
                    });
                    collapsePlayer.show();
                } else {
                    collapsePlayer.hide();
                }
            } else if (subCategory === "images") {
                if (!$playerCollapse.classList.contains("show")) {
                    $playerContainer.innerHTML = '';
                    const img = document.createElement('img');
                    img.src = itemData.url;
                    img.style = "max-height: 220px; max-width: 100%; object-fit: contain; border-radius: 4px;";
                    img.alt = "Image Preview";
                    $playerContainer.appendChild(img);
                    if ($resolution) $resolution.innerText = itemData.format ? itemData.format.toUpperCase() : "Image";
                    collapsePlayer.show();
                } else {
                    collapsePlayer.hide();
                }
            } else {
                window.open(itemData.url, "_blank");
            }
        };

        $downloadBtn.onclick = () => {
            itemData.name = getFullName();
            if ($captionInput) itemData.telegramCaption = $captionInput.value.trim();
            if (itemData.isProtectedPdf) {
                this.extractPdfFromPage();
                return;
            }
            this.downloadStream(itemData, "download");
        };

        const checkUploadCredentials = async (svcStr, isServerUpload = false) => {
            if (typeof Vault === 'undefined') return true;
            
            const isSetup = await Vault.isVaultSetup();
            if (!isSetup) return true;

            const creds = await Vault.getUnlockedCreds() || {};
            const isLocked = !await Vault.getUnlockedCreds();

            // Rule 1: Server Upload requires Vault to be unlocked and serverRelayUrl to be set.
            if (isServerUpload) {
                if (isLocked) {
                    await CustomDialog.alert("Vault is locked. The Cloud Runner URL and API Key are encrypted. Please unlock the Vault to use Server Upload.", "Vault Locked", "warning");
                    return false;
                }
                if (!creds.serverRelayUrl) {
                    await CustomDialog.alert("Remote Server / Cloud Runner URL is not configured in the Vault.", "Missing Configuration", "warning");
                    return false;
                }
            }

            const svcs = svcStr.split(',').map(s => s.trim()).filter(s => s);
            const reqCredServices = {
                'telegram': 'Bot Token & Chat ID',
                's3_compatible': 'S3 Access Key & Secret Key',
                'b2': 'B2 App Key',
                'r2': 'R2 Access Key',
                'pixeldrain.com': 'Pixeldrain API Key'
            };

            const missing = [];
            const present = [];

            for (const s of svcs) {
                let hasCreds = false;
                if (s === 'telegram') {
                    if (creds.telegramBotToken && creds.telegramChatId) hasCreds = true;
                } else if (s === 's3_compatible') {
                    if (creds.s3AccessKey && creds.s3SecretKey) hasCreds = true;
                } else if (s === 'b2') {
                    if (creds.b2AppKeyId && creds.b2AppKey) hasCreds = true;
                } else if (s === 'r2') {
                    if (creds.r2AccessKey && creds.r2SecretKey) hasCreds = true;
                } else if (s === 'pixeldrain.com') {
                    if (creds.pixeldrainApiKey) hasCreds = true;
                } else {
                    hasCreds = true; // Public services don't need creds
                }

                if (!hasCreds && reqCredServices[s]) {
                    missing.push(s);
                } else {
                    present.push(s);
                }
            }

            if (missing.length > 0) {
                const lockReason = isLocked ? "Vault is currently locked" : "You have not added credentials";
                if (svcs.length === 1) {
                    await CustomDialog.alert(`${lockReason} for ${reqCredServices[missing[0]]}. Please unlock or configure them in the Vault.`, "Action Required", "warning");
                    return false;
                } else {
                    if (present.length === 0) {
                        await CustomDialog.alert(`${lockReason} for any of the required services in your list.`, "Action Required", "warning");
                        return false;
                    }
                    const proceed = await CustomDialog.confirm(`${lockReason}, so some services in your list will be skipped (${missing.join(', ')}).\n\nDo you want to proceed uploading to the remaining ${present.length} public services?`, "Partial Upload Warning", "warning", "Proceed");
                    if (!proceed) return false;
                    return present.join(",");
                }
            }
            return svcStr;
        };

        if ($uploadBtn) {
            $uploadBtn.onclick = async () => {
                itemData.name = getFullName();
                if ($captionInput) itemData.telegramCaption = $captionInput.value.trim();
                let svc = itemData.uploadService || (this.options.upload?.service !== "local" ? this.options.upload?.service : "gofile.io");
                if (svc === "custom") {
                    svc = (itemData.customList && itemData.customList.length > 0)
                        ? itemData.customList.join(",")
                        : ((this.options.upload?.customList && this.options.upload.customList.length > 0)
                            ? this.options.upload.customList.join(",")
                            : "gofile.io");
                }
                
                const finalSvc = await checkUploadCredentials(svc);
                if (!finalSvc) return;

                if (itemData.isProtectedPdf) {
                    this.extractAndUploadPdf(itemData, finalSvc);
                } else {
                    this.downloadStream(itemData, "upload", finalSvc);
                }
            };
        }
        if ($serverUploadBtn) {
            $serverUploadBtn.onclick = async () => {
                try {
                    itemData.name = getFullName();
                    if ($captionInput) itemData.telegramCaption = $captionInput.value.trim();
                    let svc = itemData.uploadService || this.options.serverUpload?.service || "gofile.io";
                    if (svc === "custom") {
                        svc = (itemData.customList && itemData.customList.length > 0)
                            ? itemData.customList.join(",")
                            : ((this.options.serverUpload?.customList && this.options.serverUpload.customList.length > 0)
                                ? this.options.serverUpload.customList.join(",")
                                : "gofile.io");
                    }
                    const finalSvc = await checkUploadCredentials(svc, true);
                    if (!finalSvc) return;

                    await this.serverUploadStream(itemData, finalSvc);
                } catch (btnErr) {
                    console.error('[FetchStream] Server upload error:', btnErr);
                    this.toast(`Server upload error: ${btnErr.message || btnErr}`, 4500, true);
                }
            };
        }

        if ($serviceSelectBtn && this.bootstrap && this.bootstrap.Dropdown) {
            new this.bootstrap.Dropdown($serviceSelectBtn);
        }
        if ($uploadDropdownMenu) {
            $uploadDropdownMenu.querySelectorAll("[data-service]").forEach(itemEl => {
                itemEl.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const chosen = itemEl.getAttribute("data-service");
                    if (chosen) {
                        itemData.uploadService = chosen;
                        updateServiceSelectUI();
                        if ($serviceSelectBtn && this.bootstrap && this.bootstrap.Dropdown) {
                            const instance = this.bootstrap.Dropdown.getInstance($serviceSelectBtn);
                            if (instance) instance.hide();
                        }
                        this.toast(`Upload destination set to ${this.getServiceDisplayName(chosen)}`, 2000);
                    }
                };
            });

            const $multiHostBtn = this.selector("multiHostBtn", false, $item);
            if ($multiHostBtn) {
                $multiHostBtn.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if ($serviceSelectBtn && this.bootstrap && this.bootstrap.Dropdown) {
                        const instance = this.bootstrap.Dropdown.getInstance($serviceSelectBtn);
                        if (instance) instance.hide();
                    }
                    if ($nameInput && $nameInput.value.trim()) {
                        itemData.name = $nameInput.value.trim();
                    }
                    this.openMultiHostModal({
                        itemData: itemData,
                        context: 'item',
                        currentList: itemData.customList || this.options.upload?.customList,
                        onSave: (selectedList) => {
                            itemData.uploadService = "custom";
                            itemData.customList = selectedList;
                            updateServiceSelectUI();
                            this.toast(`Custom destination list saved (${selectedList.length} hosts)`);
                        }
                    });
                };
            }
        }

        $copyBtn.onclick = () => {
            const copyTarget = (itemData.uploadedUrl && !itemData.uploadedUrl.includes('.m3u8')) ? itemData.uploadedUrl : itemData.url;
            navigator.clipboard.writeText(copyTarget).then(() => {
                const msg = (itemData.uploadedUrl && !itemData.uploadedUrl.includes('.m3u8'))
                    ? "✓ Upload link copied to clipboard!"
                    : "URL copied successfully!";
                this.toast(msg);
            }).catch(() => {
                this.toast("Failed to copy URL.", 3000, true);
            });
        };

        const $curlBtn = this.selector("curl", false, $item);
        if ($curlBtn) {
            $curlBtn.onclick = () => {
                let cmd = `curl "${itemData.url}"`;
                if (itemData.headers) {
                    for (const [k, v] of Object.entries(itemData.headers)) {
                        cmd += ` -H "${k}: ${v}"`;
                    }
                }
                navigator.clipboard.writeText(cmd).then(() => {
                    this.toast("cURL command copied to clipboard!");
                }).catch(() => {
                    this.toast("Failed to copy cURL command.", 3000, true);
                });
            };
        }

        $blockedBtn.onclick = () => {
            try {
                const hostname = new URL(itemData.url).hostname;
                if (!this.options.domain.includes(hostname)) {
                    this.options.domain.push(hostname);
                    this.saveOptions(true).then(() => {
                        this.createOptionDomain(hostname);
                        $item.remove();
                        this.items = this.items.filter(i => i.requestId !== itemData.requestId);
                        this.updateBadge();
                        this.toast("Domain blocked successfully!");
                    });
                } else {
                    $item.remove();
                    this.items = this.items.filter(i => i.requestId !== itemData.requestId);
                    this.updateBadge();
                }
            } catch (e) {}
        };

        itemObj.urlCollapse = collapseUrl;
        itemObj.playerCollapse = collapsePlayer;
        this.items.push(itemObj);

        if (itemData.uploadedUrl) {
            this.showItemCopyButton(itemObj, itemData.uploadedUrl);
        }

        this.updateCategoryCounts();
        this.applyFilter();
    }

    openMultiHostModal(params = {}) {
        const isLegacyItemCall = params && params.requestId !== undefined && params.url !== undefined;
        const itemData = isLegacyItemCall ? params : (params.itemData || null);
        const context = isLegacyItemCall ? 'item' : (params.context || 'item');
        const onSave = isLegacyItemCall ? null : (params.onSave || null);
        let currentList = isLegacyItemCall ? null : (params.currentList || null);

        const modalEl = document.getElementById("multiHostModal");
        if (!modalEl) return;

        const nameEl = document.getElementById("multiHostFileName");
        if (nameEl) {
            if (context === 'settings-local') {
                nameEl.textContent = "Default Local Upload Destinations";
            } else if (context === 'settings-server') {
                nameEl.textContent = "Default Server Upload Destinations";
            } else {
                nameEl.textContent = itemData?.name || "Media Stream Destinations";
            }
        }

        if (!currentList || !currentList.length) {
            if (itemData) {
                if (itemData.customList && itemData.customList.length) {
                    currentList = itemData.customList;
                } else if (itemData.uploadService && itemData.uploadService.includes(",")) {
                    currentList = itemData.uploadService.split(",").filter(Boolean);
                } else if (this.options.upload?.customList?.length) {
                    currentList = this.options.upload.customList;
                }
            } else if (context === 'settings-server') {
                currentList = this.options.serverUpload?.customList || ["gofile.io", "buzzheavier.com"];
            } else {
                currentList = this.options.upload?.customList || ["gofile.io", "buzzheavier.com"];
            }
        }
        if (!currentList || !currentList.length) {
            currentList = ["gofile.io", "buzzheavier.com"];
        }

        const checkboxes = modalEl.querySelectorAll("#multiHostCheckboxList input[type='checkbox']");
        checkboxes.forEach(cb => {
            cb.checked = currentList.includes(cb.value);
        });

        const bsModal = this.bootstrap && this.bootstrap.Modal
            ? (this.bootstrap.Modal.getInstance(modalEl) || new this.bootstrap.Modal(modalEl))
            : null;

        const saveBtn = document.getElementById("multiHostSaveBtn");
        if (saveBtn) {
            saveBtn.onclick = () => {
                const checkedBoxes = Array.from(modalEl.querySelectorAll("#multiHostCheckboxList input[type='checkbox']:checked"));
                const selectedServices = checkedBoxes.map(cb => cb.value);

                if (selectedServices.length === 0) {
                    this.toast("Please select at least one destination service.", 3000, true);
                    return;
                }

                if (bsModal) bsModal.hide();

                if (typeof onSave === "function") {
                    onSave(selectedServices);
                }
            };
        }

        if (bsModal) bsModal.show();
    }

    showItemCopyButton(itemObj, url, multiLinks = null) {
        if (!itemObj || !itemObj.$item || !url) return;
        itemObj.detail.uploadedUrl = url;

        const incomingLinks = (Array.isArray(multiLinks) && multiLinks.length > 0)
            ? multiLinks.filter(l => l && l.url)
            : [{ service: 'Cloud', url: url }];

        if (!itemObj.detail.multiLinks) itemObj.detail.multiLinks = [];
        
        incomingLinks.forEach(inc => {
            if (!itemObj.detail.multiLinks.some(existing => existing.url === inc.url)) {
                itemObj.detail.multiLinks.push(inc);
            }
        });

        const linksList = itemObj.detail.multiLinks;

        if (this.storageKey && itemObj.requestId) {
            chrome.storage.local.get([this.storageKey], (res) => {
                const stored = res?.[this.storageKey] || {};
                if (stored[itemObj.requestId]) {
                    stored[itemObj.requestId].uploadedUrl = url;
                    stored[itemObj.requestId].multiLinks = linksList;
                    chrome.storage.local.set({ [this.storageKey]: stored });
                }
            });
        }

        const existingBtn = itemObj.$item.querySelector(".copy-uploaded-btn");
        if (existingBtn) existingBtn.remove();

        const actionsContainer = itemObj.$item.querySelector('[selector="serverUpload"]')?.parentNode || itemObj.$item.querySelector(".btn-group")?.parentNode;
        if (!actionsContainer) return;

        if (linksList.length > 1) {
            const dropdown = document.createElement("div");
            dropdown.className = "btn-group ms-1 copy-uploaded-btn";
            dropdown.innerHTML = `
                <button type="button" class="btn btn-sm btn-success py-1 px-2 dropdown-toggle d-inline-flex align-items-center gap-1" data-bs-toggle="dropdown" aria-expanded="false" style="font-size:0.78rem;">
                    <i class="bi bi-link-45deg"></i> <span>Links (${linksList.length})</span>
                </button>
                <ul class="dropdown-menu dropdown-menu-end shadow-sm p-1" style="min-width: 180px; font-size: 0.78rem;">
                    ${linksList.map(l => `
                        <li>
                            <div class="d-flex align-items-center justify-content-between gap-2 px-2 py-1 hover-bg">
                                <span class="fw-bold text-truncate" style="max-width: 80px;" title="${l.url || 'Error'}">${this.getServiceDisplayName(l.service) || l.service}</span>
                                <div class="d-flex gap-1">
                                    ${l.url && l.url.startsWith('http') ? `<a href="${l.url}" target="_blank" class="btn btn-xs btn-outline-primary py-0 px-1" style="font-size: 0.7rem;"><i class="bi bi-box-arrow-up-right"></i></a>` : ''}
                                    ${!l.error && l.url && l.url.startsWith('http') ? `<button class="btn btn-xs btn-outline-success py-0 px-1 copy-sub-btn" data-url="${l.url}" style="font-size: 0.7rem;"><i class="bi bi-clipboard"></i> Copy</button>` : (!l.url || !l.url.startsWith('http') ? `<span class="text-danger fw-bold" style="font-size:0.65rem;" title="${l.url}">Error</span>` : '')}
                                </div>
                            </div>
                        </li>
                    `).join('')}
                </ul>
            `;
            dropdown.querySelectorAll(".copy-sub-btn").forEach(btn => {
                btn.onclick = (e) => {
                    e.stopPropagation();
                    const targetU = btn.getAttribute("data-url");
                    navigator.clipboard.writeText(targetU).then(() => {
                        btn.innerHTML = '<i class="bi bi-check2"></i>';
                        this.toast("✓ Link copied!");
                        setTimeout(() => { btn.innerHTML = '<i class="bi bi-clipboard"></i> Copy'; }, 1500);
                    });
                };
            });
            actionsContainer.appendChild(dropdown);
        } else {
            const singleUrl = linksList[0]?.url || url;
            const copyBtn = document.createElement("button");
            copyBtn.className = "btn btn-sm btn-success py-1 px-2 d-inline-flex align-items-center gap-1 copy-uploaded-btn ms-1";
            copyBtn.style.fontSize = "0.78rem";
            copyBtn.title = `Copy upload link: ${singleUrl}`;
            copyBtn.innerHTML = '<i class="bi bi-link-45deg"></i> <span>Copy Link</span>';
            copyBtn.onclick = (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(singleUrl).then(() => {
                    copyBtn.innerHTML = '<i class="bi bi-check2"></i> <span>Copied!</span>';
                    this.toast("✓ Upload link copied to clipboard!");
                    setTimeout(() => {
                        copyBtn.innerHTML = '<i class="bi bi-link-45deg"></i> <span>Copy Link</span>';
                    }, 2000);
                });
            };
            actionsContainer.appendChild(copyBtn);
        }
    }

    updateBadge() {
        const count = this.items.length;
        if (count === 0) {
            this.$container.classList.add("d-none");
            this.$empty.classList.remove("d-none");
        } else {
            this.$empty.classList.add("d-none");
            this.$container.classList.remove("d-none");
        }
        this.updateCategoryCounts();
        this.applyFilter();
        const text = count > 0 ? count.toString() : "";
        if (this.tab) {
            chrome.action.setBadgeText({ text: text, tabId: this.tab.id });
        }
    }

    async fetchActiveDownloads() {
        chrome.runtime.sendMessage({ cmd: "GET_ACTIVE_DOWNLOADS" }, (activeMap) => {
            if (chrome.runtime.lastError || !activeMap) {
                chrome.storage.local.get(["active_downloads"], (res) => {
                    const fallback = res?.active_downloads || {};
                    for (const id in fallback) {
                        this.renderActiveDownload(fallback[id]);
                    }
                });
                return;
            }
            for (const id in activeMap) {
                this.renderActiveDownload(activeMap[id]);
            }
        });
    }

    renderActiveDownload(dl) {
        if (!dl || !dl.id) return;

        let card = this.activeDownloadCards[dl.id];
        if (!card) {
            const cardEl = document.createElement("div");
            cardEl.className = "active-dl-card shadow-sm";
            cardEl.innerHTML = `
                <div class="d-flex justify-content-between align-items-center mb-1">
                    <span class="fw-semibold text-truncate small text-dark me-2 dl-title" style="max-width: 220px;"></span>
                    <span class="badge dl-badge font-monospace bg-primary" style="font-size: 0.65rem;">DOWNLOADING</span>
                </div>
                <div class="progress mb-1.5" style="height: 6px; border-radius: 3px; background-color: #e2e8f0;">
                    <div class="progress-bar dl-progress-bar bg-primary progress-bar-striped progress-bar-animated" role="progressbar" style="width: 0%;"></div>
                </div>
                <div class="d-flex justify-content-between align-items-center mt-1">
                    <span class="text-muted font-monospace dl-stats" style="font-size: 0.72rem;">0% • 0 KB/s</span>
                    <div class="d-flex gap-1">
                        <button class="btn btn-sm btn-light border p-1 py-0 dl-pause-btn" title="Pause / Resume" style="font-size: 0.75rem; line-height: 1;">
                            <i class="bi bi-pause-fill text-warning"></i>
                        </button>
                        <button class="btn btn-sm btn-light border p-1 py-0 dl-cancel-btn" title="Cancel Download" style="font-size: 0.75rem; line-height: 1;">
                            <i class="bi bi-x-lg text-danger"></i>
                        </button>
                    </div>
                </div>
            `;

            const $title = cardEl.querySelector(".dl-title");
            if ($title) {
                const displayName = dl.name || 'HLS Stream';
                $title.textContent = displayName;
                $title.setAttribute('title', displayName);
            }
            const $badge = cardEl.querySelector(".dl-badge");
            const $bar = cardEl.querySelector(".dl-progress-bar");
            const $stats = cardEl.querySelector(".dl-stats");
            const $pauseBtn = cardEl.querySelector(".dl-pause-btn");
            const $cancelBtn = cardEl.querySelector(".dl-cancel-btn");

            $pauseBtn.onclick = () => {
                const isPaused = card.state === "paused";
                if (isPaused) {
                    chrome.runtime.sendMessage({ cmd: "RESUME_DOWNLOAD", parameter: { id: dl.id } });
                } else {
                    chrome.runtime.sendMessage({ cmd: "PAUSE_DOWNLOAD", parameter: { id: dl.id } });
                }
            };

            $cancelBtn.onclick = () => {
                chrome.runtime.sendMessage({ cmd: "CANCEL_DOWNLOAD", parameter: { id: dl.id } });
                this.removeActiveDownload(dl.id);
            };

            this.$activeDownloadsList.appendChild(cardEl);
            card = {
                el: cardEl,
                $title,
                $badge,
                $bar,
                $stats,
                $pauseBtn,
                state: dl.state || "downloading"
            };
            this.activeDownloadCards[dl.id] = card;
        }

        card.state = dl.state || card.state;
        const progress = dl.progress !== undefined ? dl.progress : 0;
        card.$bar.style.width = `${progress}%`;

        if (card.state === "failed") {
            card.$badge.textContent = "UPLOAD FAILED";
            card.$badge.className = "badge dl-badge font-monospace text-white";
            card.$badge.style.backgroundColor = "#dc2626";
            card.$bar.className = "progress-bar dl-progress-bar";
            card.$bar.style.backgroundColor = "#dc2626";
            card.$bar.style.width = "100%";
            if (card.$pauseBtn) card.$pauseBtn.style.display = "none";
            const errMsg = dl.error || "Upload failed";
            const isTgLimit = errMsg.includes("50 MB") || errMsg.includes("Telegram");
            card.$stats.innerHTML = `
                <div class="mt-1 w-100">
                    <div class="text-danger small fw-semibold text-truncate mb-1" title="${errMsg}">
                        <i class="bi bi-exclamation-triangle-fill me-1"></i>${errMsg}
                    </div>
                    <div class="d-flex align-items-center justify-content-between gap-1 pt-1 border-top mt-1">
                        <button class="btn btn-xs btn-outline-danger py-0 px-2 popup-save-pc-btn" style="font-size: 0.72rem; line-height: 1.4;">
                            <i class="bi bi-download me-1"></i> Save to PC Instead
                        </button>
                        ${isTgLimit ? '<span class="text-muted small" style="font-size: 0.65rem;">Tip: Use ⚡ Server Upload</span>' : ''}
                    </div>
                </div>
            `;
            const saveBtn = card.$stats.querySelector(".popup-save-pc-btn");
            if (saveBtn) {
                saveBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.requestTaskSaveToPc(dl.id, saveBtn);
                };
            }
        } else if (card.state === "uploading") {
            const svc = (dl.service || "cloud").toUpperCase();
            card.$badge.textContent = `UPLOADING (${svc})`;
            card.$badge.className = "badge dl-badge font-monospace text-white";
            card.$badge.style.backgroundColor = "#059669";
            card.$bar.className = "progress-bar dl-progress-bar progress-bar-striped progress-bar-animated";
            card.$bar.style.backgroundColor = "#059669";
            if (card.$pauseBtn) card.$pauseBtn.style.display = "none";
            const speedInfo = dl.speed ? ` • ${dl.speed}` : "";
            card.$stats.innerHTML = `<span class="fw-bold" style="color: #059669;">${progress}%</span>${speedInfo} <span class="text-muted small">(${dl.service || 'Cloud'})</span>`;
        } else if (card.state === "paused") {
            card.$badge.textContent = "PAUSED";
            card.$badge.className = "badge dl-badge font-monospace bg-warning text-dark";
            card.$badge.style.backgroundColor = "";
            card.$bar.className = "progress-bar dl-progress-bar bg-warning";
            card.$bar.style.backgroundColor = "";
            if (card.$pauseBtn) {
                card.$pauseBtn.style.display = "";
                card.$pauseBtn.innerHTML = '<i class="bi bi-play-fill text-success"></i>';
                card.$pauseBtn.setAttribute("title", "Resume Download");
            }
            const segInfo = dl.totalSegments > 0 ? ` • ${dl.completedSegments || 0}/${dl.totalSegments} segs` : "";
            const speedInfo = dl.speed ? ` • ${dl.speed}` : "";
            card.$stats.innerHTML = `<span class="text-warning fw-bold">${progress}%</span>${speedInfo}${segInfo}`;
        } else {
            card.$badge.textContent = "DOWNLOADING";
            card.$badge.className = "badge dl-badge font-monospace bg-primary";
            card.$badge.style.backgroundColor = "";
            card.$bar.className = "progress-bar dl-progress-bar bg-primary progress-bar-striped progress-bar-animated";
            card.$bar.style.backgroundColor = "";
            if (card.$pauseBtn) {
                card.$pauseBtn.style.display = "";
                card.$pauseBtn.innerHTML = '<i class="bi bi-pause-fill text-warning"></i>';
                card.$pauseBtn.setAttribute("title", "Pause Download");
            }
            const segInfo = dl.totalSegments > 0 ? ` • ${dl.completedSegments || 0}/${dl.totalSegments} segs` : "";
            const speedInfo = dl.speed ? ` • ${dl.speed}` : "";
            card.$stats.innerHTML = `<span class="text-primary fw-bold">${progress}%</span>${speedInfo}${segInfo}`;
        }

        this.updateActiveDownloadsHeader();
    }

    requestTaskSaveToPc(dlId, saveBtn) {
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1" style="width: 0.7rem; height: 0.7rem;"></span>Saving...';
        }

        const handleSuccess = () => {
            if (saveBtn) {
                saveBtn.className = "btn btn-xs btn-success py-0 px-2";
                saveBtn.innerHTML = '<i class="bi bi-check2 me-1"></i> Saved to PC';
            }
            this.toast("✓ File saved to PC Downloads!", 3000);
        };

        const handleFailure = (msg) => {
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.innerHTML = '<i class="bi bi-download me-1"></i> Save to PC Instead';
            }
            this.toast(msg || "Could not save to PC. Please check Download Manager tab.", 4000, true);
        };

        chrome.runtime.sendMessage({
            cmd: "ACTION_SAVE_TASK_TO_PC",
            parameter: { id: dlId }
        }, (res) => {
            if (res?.ok) {
                handleSuccess();
            } else {
                const downloaderUrl = chrome.runtime.getURL("downloader.html");
                chrome.tabs.query({}, (tabs) => {
                    const dTab = tabs.find(t => t.url && t.url.startsWith(downloaderUrl));
                    if (dTab) {
                        chrome.tabs.sendMessage(dTab.id, {
                            cmd: "ACTION_SAVE_TASK_TO_PC",
                            parameter: { id: dlId }
                        }, (tabRes) => {
                            if (tabRes?.ok) {
                                handleSuccess();
                            } else {
                                handleFailure(tabRes?.error || res?.error);
                            }
                        });
                    } else {
                        handleFailure("Downloader tab holding the completed file is closed.");
                    }
                });
            }
        });
    }

    removeActiveDownload(id) {
        if (this.activeDownloadCards[id]) {
            this.activeDownloadCards[id].el.remove();
            delete this.activeDownloadCards[id];
            this.updateActiveDownloadsHeader();
        }
    }

    updateActiveDownloadsHeader() {
        const count = Object.keys(this.activeDownloadCards).length;
        if (this.$activeDownloadsCount) {
            this.$activeDownloadsCount.textContent = count.toString();
        }
        if (this.$activeDownloadsSection) {
            if (count > 0) {
                this.$activeDownloadsSection.classList.remove("d-none");
            } else {
                this.$activeDownloadsSection.classList.add("d-none");
            }
        }
    }

    async fetchActiveUploads() {
        chrome.runtime.sendMessage({ cmd: "GET_ACTIVE_UPLOADS" }, (activeMap) => {
            if (chrome.runtime.lastError || !activeMap) {
                chrome.storage.local.get(["active_uploads"], (res) => {
                    const fallback = res?.active_uploads || {};
                    for (const id in fallback) {
                        this.renderActiveUpload(fallback[id]);
                    }
                });
                return;
            }
            for (const id in activeMap) {
                this.renderActiveUpload(activeMap[id]);
            }
        });
    }

    renderActiveUpload(ul) {
        if (!ul || !ul.id) return;

        let card = this.activeUploadCards[ul.id];
        if (!card) {
            const cardEl = document.createElement("div");
            cardEl.className = "active-dl-card shadow-sm";
            cardEl.innerHTML = `
                <div class="d-flex justify-content-between align-items-center mb-1">
                    <span class="fw-semibold text-truncate small text-dark me-2 ul-title" style="max-width: 170px;">
                        <i class="bi bi-cloud-arrow-up-fill me-1" style="color: #059669;"></i><span class="ul-name-text"></span>
                    </span>
                    <div class="d-flex align-items-center gap-1 flex-shrink-0">
                        <span class="badge ul-badge font-monospace" style="font-size: 0.65rem; background-color: #059669;">UPLOADING</span>
                        <button class="btn btn-sm btn-link text-muted p-0 ul-pause-btn" style="line-height: 1;" title="Pause Upload">
                            <i class="bi bi-pause-fill text-warning"></i>
                        </button>
                        <button class="btn btn-sm btn-link text-muted p-0 ul-cancel-btn" style="line-height: 1;" title="Cancel Upload">
                            <i class="bi bi-x text-danger"></i>
                        </button>
                    </div>
                </div>
                <div class="progress mb-1.5" style="height: 6px; border-radius: 3px; background-color: #e2e8f0;">
                    <div class="progress-bar ul-progress-bar progress-bar-striped progress-bar-animated" role="progressbar" style="width: 0%; background-color: #059669;"></div>
                </div>
                <div class="d-flex justify-content-between align-items-center mt-1">
                    <span class="text-muted font-monospace ul-stats" style="font-size: 0.72rem;">0% • Starting...</span>
                    <span class="text-muted small ul-service">${ul.service || ''}</span>
                </div>
                <div class="ul-result mt-2 d-none flex-column gap-1"></div>
            `;
            const nameEl = cardEl.querySelector('.ul-title');
            if (ul.name) {
                const nameText = cardEl.querySelector('.ul-name-text');
                if (nameText) {
                    nameText.textContent = ul.name;
                    nameEl.title = ul.name;
                }
            }

            const $cancelBtn = cardEl.querySelector(".ul-cancel-btn");
            const $pauseBtn = cardEl.querySelector(".ul-pause-btn");

            if ($cancelBtn) {
                $cancelBtn.onclick = () => {
                    chrome.runtime.sendMessage({
                        cmd: "CANCEL_UPLOAD",
                        parameter: { id: ul.id }
                    });
                    this.removeActiveUpload(ul.id);
                    this.toast("Upload cancelled.", 2000);
                };
            }

            if ($pauseBtn) {
                $pauseBtn.onclick = () => {
                    const isPaused = card.state === "paused";
                    if (isPaused) {
                        chrome.runtime.sendMessage({ cmd: "RESUME_UPLOAD", parameter: { id: ul.id } });
                    } else {
                        chrome.runtime.sendMessage({ cmd: "PAUSE_UPLOAD", parameter: { id: ul.id } });
                    }
                };
            }

            this.$activeUploadsList.appendChild(cardEl);
            card = {
                el: cardEl,
                $bar: cardEl.querySelector(".ul-progress-bar"),
                $stats: cardEl.querySelector(".ul-stats"),
                $badge: cardEl.querySelector(".ul-badge"),
                $service: cardEl.querySelector(".ul-service"),
                $pauseBtn: $pauseBtn,
                $result: cardEl.querySelector(".ul-result"),
                state: ul.state || "uploading",
                links: []
            };
            this.activeUploadCards[ul.id] = card;
        }

        card.state = ul.state || card.state;
        const progress = ul.progress !== undefined ? ul.progress : 0;
        card.$bar.style.width = `${progress}%`;

        if (card.state === "paused") {
            card.$badge.textContent = "PAUSED";
            card.$badge.style.backgroundColor = "#d97706";
            card.$bar.className = "progress-bar ul-progress-bar bg-warning";
            card.$pauseBtn.innerHTML = '<i class="bi bi-play-fill text-success"></i>';
            card.$pauseBtn.setAttribute("title", "Resume Upload");
            card.$stats.innerHTML = `<span style="color: #d97706; font-weight: bold;">${progress}% • Paused</span>`;
        } else {
            card.$badge.textContent = "UPLOADING";
            card.$badge.style.backgroundColor = "#059669";
            card.$bar.className = "progress-bar ul-progress-bar progress-bar-striped progress-bar-animated";
            card.$bar.style.backgroundColor = "#059669";
            card.$pauseBtn.innerHTML = '<i class="bi bi-pause-fill text-warning"></i>';
            card.$pauseBtn.setAttribute("title", "Pause Upload");
            const speedInfo = ul.speed ? ` • ${ul.speed}` : "";
            card.$stats.innerHTML = `<span style="color: #059669; font-weight: bold;">${progress}%</span>${speedInfo}`;
        }

        this.updateActiveUploadsHeader();
    }

    renderActiveUploadLinks(card) {
        if (!card || !card.$result) return;
        const links = card.links || [];
        if (links.length > 0) {
            card.$result.classList.remove("d-none");
            card.$result.innerHTML = '';
            links.forEach(item => {
                const svcName = this.getServiceDisplayName(item.service) || item.service || "Link";
                const u = item.url || "";
                if (u) {
                    const row = document.createElement('div');
                    row.className = "d-flex justify-content-between align-items-center gap-1 mb-1";
                    
                    const badge = document.createElement('span');
                    badge.className = "badge bg-light text-dark border me-1 text-truncate";
                    badge.style.fontSize = "0.65rem";
                    badge.style.maxWidth = "80px";
                    badge.textContent = svcName;
                    badge.title = svcName;
                    
                    const urlSpan = document.createElement('span');
                    urlSpan.className = "text-truncate text-muted font-monospace small flex-grow-1";
                    urlSpan.style.maxWidth = "140px";
                    urlSpan.textContent = u;
                    urlSpan.title = u;
                    
                    const actionsDiv = document.createElement('div');
                    actionsDiv.className = "d-flex gap-1 flex-shrink-0";
                    
                    if (u.startsWith("http")) {
                        const a = document.createElement('a');
                        a.href = u;
                        a.target = "_blank";
                        a.className = "btn btn-xs btn-outline-success py-0 px-1.5";
                        a.style.fontSize = "0.7rem";
                        a.innerHTML = '<i class="bi bi-box-arrow-up-right"></i>';
                        actionsDiv.appendChild(a);
                    }
                    
                    const copyBtn = document.createElement('button');
                    copyBtn.className = "btn btn-xs btn-outline-secondary py-0 px-1.5 active-dl-copy-btn";
                    copyBtn.style.fontSize = "0.7rem";
                    copyBtn.setAttribute('data-url', u);
                    copyBtn.innerHTML = '<i class="bi bi-clipboard"></i> Copy';
                    actionsDiv.appendChild(copyBtn);
                    
                    row.appendChild(badge);
                    row.appendChild(urlSpan);
                    row.appendChild(actionsDiv);
                    card.$result.appendChild(row);
                }
            });
            card.$result.querySelectorAll(".active-dl-copy-btn").forEach(btn => {
                btn.onclick = (e) => {
                    e.stopPropagation();
                    const targetUrl = btn.getAttribute("data-url");
                    navigator.clipboard.writeText(targetUrl).then(() => {
                        btn.innerHTML = '<i class="bi bi-check2"></i>';
                        this.toast("Link copied!");
                        setTimeout(() => { btn.innerHTML = '<i class="bi bi-clipboard"></i> Copy'; }, 1500);
                    });
                };
            });
        } else {
            card.$result.classList.add("d-none");
        }
    }

    removeActiveUpload(id) {
        if (this.activeUploadCards[id]) {
            this.activeUploadCards[id].el.remove();
            delete this.activeUploadCards[id];
            this.updateActiveUploadsHeader();
        }
    }

    updateActiveUploadsHeader() {
        const count = Object.keys(this.activeUploadCards).length;
        if (this.$activeUploadsCount) {
            this.$activeUploadsCount.textContent = count.toString();
        }
        if (this.$activeUploadsSection) {
            if (count > 0) {
                this.$activeUploadsSection.classList.remove("d-none");
            } else {
                this.$activeUploadsSection.classList.add("d-none");
            }
        }
        if (this.$uploadIndicator) {
            if (count > 0) {
                this.$uploadIndicator.classList.remove("d-none");
            } else {
                this.$uploadIndicator.classList.add("d-none");
            }
        }
    }

    async fetchActiveServerUploads() {
        chrome.runtime.sendMessage({ cmd: "GET_ACTIVE_SERVER_UPLOADS" }, (activeMap) => {
            if (chrome.runtime.lastError || !activeMap) {
                chrome.storage.local.get(["active_server_uploads"], (res) => {
                    this.syncActiveServerUploads(res?.active_server_uploads || {});
                });
                return;
            }
            this.syncActiveServerUploads(activeMap);
        });
    }

    syncActiveServerUploads(activeMap) {
        if (!activeMap) return;
        const downloaderUrl = chrome.runtime.getURL("downloader.html");
        chrome.tabs.query({}, (tabs) => {
            const hasDownloaderTab = tabs.some(t => t.url && t.url.startsWith(downloaderUrl));
            for (const id in activeMap) {
                const job = activeMap[id];
                if (!job || job.status === "CANCELLED" || job.status === "COMPLETED" || job.status === "FAILED") {
                    this.removeActiveServerUpload(id);
                } else {
                    this.renderActiveServerUpload(job);
                    if (!hasDownloaderTab) {
                        this.resumeServerUploadPollingIfNeeded(job);
                    }
                }
            }
        });
    }

    async resumeServerUploadPollingIfNeeded(job) {
        if (!job || !job.id) return;
        if (job.status === "COMPLETED" || job.status === "FAILED" || job.status === "CANCELLED") return;
        if (this.serverPollingJobs.has(job.id)) return;

        const downloaderUrl = chrome.runtime.getURL("downloader.html");
        const openTabs = await new Promise(res => chrome.tabs.query({}, res)).catch(() => []);
        const hasDownloader = openTabs.some(t => t.url && t.url.startsWith(downloaderUrl));
        if (hasDownloader) {
            return;
        }

        this.serverPollingJobs.add(job.id);
        
        let serverConfig = { ...(this.options.serverUpload || {}) };
        try {
            const session = await chrome.storage.session.get('fs_vault_unlocked');
            if (session?.fs_vault_unlocked) {
                if (session.fs_vault_unlocked.serverRelayUrl) serverConfig.relayUrl = session.fs_vault_unlocked.serverRelayUrl.trim();
                if (session.fs_vault_unlocked.serverApiKey) serverConfig.apiKey = session.fs_vault_unlocked.serverApiKey.trim();
            }
        } catch(e) {}
        
        const relayUrl = (serverConfig.relayUrl || "").replace(/\/+$/, "");
        if (!relayUrl) return;

        const maxWaitMs = 60 * 60 * 1000;
        const startTime = Date.now();
        let notFoundCount = 0;

        while (Date.now() - startTime < maxWaitMs && this.serverPollingJobs.has(job.id)) {
            await new Promise(r => setTimeout(r, 1000));
            if (!this.serverPollingJobs.has(job.id)) break;
            try {
                const statusHeaders = {};
                if (serverConfig.apiKey) {
                    statusHeaders['Authorization'] = `Bearer ${serverConfig.apiKey}`;
                    statusHeaders['X-API-Key'] = serverConfig.apiKey;
                }
                const statusUrl = `${relayUrl}/api/server-status?jobId=${encodeURIComponent(job.id)}`;
                const statusRes = await fetch(statusUrl, { headers: statusHeaders, cache: 'no-store' });
                if (!statusRes.ok) {
                    if (statusRes.status === 404) {
                        notFoundCount++;
                        if (notFoundCount >= 3) {
                            this.serverPollingJobs.delete(job.id);
                            this.removeActiveServerUpload(job.id);
                            chrome.runtime.sendMessage({
                                cmd: "ACTION_CANCEL_SERVER_UPLOAD",
                                parameter: { id: job.id }
                            });
                            break;
                        }
                    }
                    continue;
                }
                notFoundCount = 0;
                const statusData = await statusRes.json();

                if (statusData.status === "CANCELLED") {
                    this.serverPollingJobs.delete(job.id);
                    this.removeActiveServerUpload(job.id);
                    chrome.runtime.sendMessage({
                        cmd: "ACTION_CANCEL_SERVER_UPLOAD",
                        parameter: { id: job.id }
                    });
                    break;
                }

                const rawPollUrl = statusData.url || (statusData.links && statusData.links[0]?.url) || '';
                const cloudPollUrl = (rawPollUrl && !rawPollUrl.includes('.m3u8')) ? rawPollUrl : (job.url && !job.url.includes('.m3u8') ? job.url : '');
                const cleanPollLinks = Array.isArray(statusData.links) 
                    ? statusData.links.filter(l => l.url && !l.url.includes('.m3u8')) 
                    : (Array.isArray(job.links) ? job.links.filter(l => l.url && !l.url.includes('.m3u8')) : []);

                if (!this._recordedHistoryLinks) this._recordedHistoryLinks = new Set();
                if (cleanPollLinks.length > 0 && typeof HistoryManager !== "undefined" && HistoryManager.addRecord) {
                    for (const lnk of cleanPollLinks) {
                        const historyKey = `${job.id}_${lnk.url}`;
                        if (lnk.url && !this._recordedHistoryLinks.has(historyKey)) {
                            this._recordedHistoryLinks.add(historyKey);
                            const svcName = this.getServiceDisplayName(lnk.service) || lnk.service || "Cloud";
                            HistoryManager.addRecord({
                                id: `${job.id}_${lnk.service || 'host'}`,
                                jobId: job.id,
                                type: "upload",
                                name: job.name,
                                size: statusData.fileSize || job.fileSize || 0,
                                service: `Server (${svcName})`,
                                url: lnk.url,
                                links: [lnk],
                                status: "completed"
                            });
                        }
                    }
                }

                const updated = {
                    ...job,
                    mediaUrl: job.mediaUrl || job.url,
                    status: statusData.status || job.status,
                    stage: statusData.stage || job.stage,
                    progress: statusData.progress || job.progress,
                    speed: statusData.speed || statusData.message || job.speed,
                    url: cloudPollUrl,
                    links: cleanPollLinks,
                    fileSize: statusData.fileSize || job.fileSize,
                    error: statusData.error || job.error
                };
                this.renderActiveServerUpload(updated);

                if (statusData.status === "COMPLETED" || statusData.status === "FAILED") {
                    this.serverPollingJobs.delete(job.id);
                    const finalUrl = (rawPollUrl && !rawPollUrl.includes('.m3u8')) ? rawPollUrl : '';
                    chrome.runtime.sendMessage({
                        cmd: "SERVER_UPLOAD_FINISHED",
                        parameter: { 
                            id: job.id, 
                            status: statusData.status, 
                            url: finalUrl,
                            links: cleanPollLinks,
                            mediaUrl: job.mediaUrl || job.url,
                            error: statusData.error 
                        }
                    });
                    if (statusData.status === "COMPLETED" && (finalUrl || cleanPollLinks.length > 0)) {
                        if (typeof HistoryManager !== "undefined" && HistoryManager.addRecord) {
                            HistoryManager.addRecord({
                                id: job.id,
                                jobId: job.id,
                                type: "upload",
                                name: job.name,
                                size: statusData.fileSize || 0,
                                service: `Server (${this.getServiceDisplayName(job.service)})`,
                                url: finalUrl,
                                links: cleanPollLinks,
                                status: "completed"
                            });
                        }
                    }
                    break;
                } else {
                    chrome.runtime.sendMessage({
                        cmd: "UPDATE_SERVER_UPLOAD_PROGRESS",
                        parameter: {
                            id: job.id,
                            progress: statusData.progress,
                            stage: statusData.stage,
                            status: statusData.status,
                            speed: statusData.speed,
                            links: cleanPollLinks,
                            url: cloudPollUrl
                        }
                    });
                }
            } catch (err) {}
        }
    }

    async confirmPreFlight(fileName, sizeBytes, services, isServerUpload = false, streamMeta = null) {
        if (typeof ServiceLimits === "undefined") {
            return { proceed: true, services };
        }

        const report = ServiceLimits.check(sizeBytes, services, this.options, isServerUpload, streamMeta);
        if (!report.hasWarnings) {
            return { proceed: true, services };
        }

        const modalEl = document.getElementById("preFlightModal");
        if (!modalEl || typeof bootstrap === "undefined" || !bootstrap.Modal) {
            return { proceed: true, services };
        }

        const fileNameEl = document.getElementById("preFlightFileName");
        const fileSizeEl = document.getElementById("preFlightFileSize");
        const warningsContainer = document.getElementById("preFlightWarningsContainer");
        const runnerNotice = document.getElementById("preFlightRunnerNotice");
        const safeContainer = document.getElementById("preFlightSafeContainer");
        const safeText = document.getElementById("preFlightSafeText");
        const skipBtn = document.getElementById("preFlightSkipBtn");
        const proceedBtn = document.getElementById("preFlightProceedBtn");
        const cancelBtn = document.getElementById("preFlightCancelBtn");

        if (fileNameEl) fileNameEl.textContent = fileName || "Media File";
        if (fileSizeEl) fileSizeEl.textContent = report.formattedSize;

        if (warningsContainer) {
            warningsContainer.innerHTML = report.problematic.map(p => `
                <div class="alert alert-warning py-1.5 px-2.5 small mb-0 border-warning" style="font-size: 0.72rem; line-height: 1.35;">
                    <div class="d-flex align-items-center gap-1.5 fw-bold text-dark mb-0.5">
                        <i class="bi bi-exclamation-triangle-fill text-warning"></i>
                        <span>${p.name} (Limit: ${p.limitStr})</span>
                    </div>
                    <div class="text-muted">${p.reason}</div>
                </div>
            `).join("");
        }

        if (runnerNotice) {
            runnerNotice.classList.toggle("d-none", !report.runnerWarning);
        }

        if (safeContainer && safeText) {
            if (report.safe.length > 0 && report.problematic.length > 0) {
                safeContainer.classList.remove("d-none");
                safeText.textContent = `Compatible: ${report.safe.map(s => s.name).join(", ")} (fits within limits).`;
            } else {
                safeContainer.classList.add("d-none");
            }
        }

        if (skipBtn) {
            skipBtn.classList.toggle("d-none", !report.canSkipIncompatible);
        }

        const modal = bootstrap.Modal.getOrCreateInstance(modalEl);

        return new Promise((resolve) => {
            let resolved = false;

            const cleanup = () => {
                modalEl.removeEventListener("hidden.bs.modal", onHidden);
                if (proceedBtn) proceedBtn.removeEventListener("click", onProceed);
                if (skipBtn) skipBtn.removeEventListener("click", onSkip);
                if (cancelBtn) cancelBtn.removeEventListener("click", onCancel);
            };

            const onProceed = () => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    modal.hide();
                    resolve({ proceed: true, services });
                }
            };

            const onSkip = () => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    modal.hide();
                    const filtered = report.safe.map(s => s.service);
                    resolve({ proceed: true, services: filtered });
                }
            };

            const onCancel = () => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    modal.hide();
                    resolve({ proceed: false, services: [] });
                }
            };

            const onHidden = () => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    resolve({ proceed: false, services: [] });
                }
            };

            if (proceedBtn) proceedBtn.addEventListener("click", onProceed, { once: true });
            if (skipBtn) skipBtn.addEventListener("click", onSkip, { once: true });
            if (cancelBtn) cancelBtn.addEventListener("click", onCancel, { once: true });
            modalEl.addEventListener("hidden.bs.modal", onHidden, { once: true });

            modal.show();
        });
    }

    async serverUploadStream(details, overrideService = null) {
        let rawName = details.name ? details.name.trim() : "stream";
        try {
            rawName = decodeURIComponent(rawName);
        } catch (e) {}
        const cleanName = rawName.replace(/[\\/:*?"<>|]/g, "_");
        const targetUrl = details.selectedVariantUrl || details.url;
        let uploadService = overrideService || details.serverUploadService || this.options.serverUpload?.service || "gofile.io";
        if (uploadService === "custom") {
            uploadService = (details.customList && details.customList.length > 0)
                ? details.customList.join(",")
                : ((this.options.serverUpload?.customList && this.options.serverUpload.customList.length > 0)
                    ? this.options.serverUpload.customList.join(",")
                    : "gofile.io");
        }

        const format = (details.format || "").toLowerCase();
        let fileName = cleanName;

        const isHlsStream = details.type === "hls" || (targetUrl && (targetUrl.toLowerCase().includes(".m3u8") || targetUrl.toLowerCase().includes(".m3u")));
        if (isHlsStream) {
            const targetExt = format === "mp3" ? ".mp3" : ".mp4";
            if (fileName.toLowerCase().endsWith(".m3u8") || fileName.toLowerCase().endsWith(".m3u")) {
                fileName = fileName.replace(/\.m3u8?$/i, targetExt);
            } else if (!fileName.toLowerCase().endsWith(targetExt)) {
                fileName = `${fileName}${targetExt}`;
            }
        } else {
            const dotIdx = fileName.lastIndexOf(".");
            if (dotIdx !== -1) {
                const curExt = fileName.substring(dotIdx).toLowerCase();
                if (format === "mp3" && (curExt === ".mp4" || curExt === ".m4a")) {
                    fileName = fileName.substring(0, dotIdx) + ".mp3";
                }
            } else {
                const ext = format ? `.${format}` : "";
                if (ext) fileName = `${fileName}${ext}`;
            }
        }

        const serverConfig = { ...(this.options.serverUpload || {}) };
        try {
            const session = await chrome.storage.session.get('fs_vault_unlocked');
            if (session?.fs_vault_unlocked) {
                if (session.fs_vault_unlocked.serverRelayUrl) {
                    serverConfig.relayUrl = session.fs_vault_unlocked.serverRelayUrl.trim();
                }
                if (session.fs_vault_unlocked.serverApiKey) {
                    serverConfig.apiKey = session.fs_vault_unlocked.serverApiKey.trim();
                }
            }
        } catch(e) {}
        const relayUrl = (serverConfig.relayUrl || "").trim();

        const isHls = details.type === "hls" || targetUrl.toLowerCase().includes(".m3u8");
        const hasAuthHeaders = details.headers && Object.keys(details.headers).some(k => ["cookie", "authorization"].includes(k.toLowerCase()));
        const isEligibleDirect = !isHls && !hasAuthHeaders && (uploadService === "catbox.moe" || uploadService === "pixeldrain.com");

        if (!relayUrl && !isEligibleDirect) {
            this.toast("Remote Server URL not configured. Please set your Runner URL in Settings -> Server Upload (e.g. http://localhost:8000).", 4500, true);
            return;
        }

        let estimatedSize = typeof ServiceLimits !== "undefined" ? ServiceLimits.estimateStreamSize(details) : 0;
        const streamMeta = {
            isHls,
            url: targetUrl,
            format: details.format,
            duration: details.duration || details.estimatedDuration || 0
        };

        if (estimatedSize <= 0 && isHls && typeof ServiceLimits !== "undefined" && ServiceLimits.probeStreamSize) {
            try {
                estimatedSize = await ServiceLimits.probeStreamSize(details);
                if (details.estimatedDuration) streamMeta.duration = details.estimatedDuration;
            } catch (probeErr) {
                console.warn("[FetchStream] Server stream size probe notice:", probeErr);
            }
        }

        const preFlight = await this.confirmPreFlight(fileName, estimatedSize, uploadService, true, streamMeta);
        if (!preFlight.proceed || !preFlight.services || preFlight.services.length === 0) {
            return;
        }
        uploadService = Array.isArray(preFlight.services) ? preFlight.services.join(',') : preFlight.services;

        const jobId = `srv_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        const abortController = new AbortController();

        const taskData = {
            id: jobId,
            url: targetUrl,
            name: fileName,
            type: details.type,
            format: details.format,
            resolution: details.resolution || details.selectedResolution || null,
            threads: this.options.concurrency || 8,
            headers: details.headers || {},
            service: uploadService,
            credentials: {},
            signal: abortController.signal
        };

        if (details.telegramCaption) {
            taskData.credentials.caption = details.telegramCaption;
            taskData.credentials.telegram = {
                ...(taskData.credentials.telegram || {}),
                caption: details.telegramCaption
            };
        }

        if (chrome.cookies) {
            try {
                const targetObj = new URL(targetUrl);
                const hostParts = targetObj.hostname.split('.');
                const apexDomain = hostParts.length >= 2 ? hostParts.slice(-2).join('.') : targetObj.hostname;

                const allTabs = await new Promise(r => chrome.tabs.query({}, r));
                const matchingTabs = (allTabs || []).filter(t => t.url && (t.url.includes(apexDomain) || t.url.includes(targetObj.hostname)));
                const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

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
                    const urlCookies = await chrome.cookies.getAll({ url: targetUrl });
                    if (urlCookies && urlCookies.length) allCookies.push(...urlCookies);
                } catch (e) {}

                for (const mt of matchingTabs) {
                    try {
                        const tabCookies = await chrome.cookies.getAll({ url: mt.url });
                        if (tabCookies && tabCookies.length) allCookies.push(...tabCookies);
                    } catch (e) {}
                }

                if (activeTab && activeTab.url && activeTab.url.startsWith('http')) {
                    try {
                        const tabCookies = await chrome.cookies.getAll({ url: activeTab.url });
                        if (tabCookies && tabCookies.length) allCookies.push(...tabCookies);
                    } catch (e) {}
                }

                if (allCookies.length > 0) {
                    const cookieMap = new Map();
                    const existingCookieStr = taskData.headers['Cookie'] || taskData.headers['cookie'];
                    if (existingCookieStr) {
                        existingCookieStr.split(';').forEach(pair => {
                            const [k, ...v] = pair.trim().split('=');
                            if (k) cookieMap.set(k, v.join('='));
                        });
                    }
                    allCookies.forEach(c => cookieMap.set(c.name, c.value));
                    taskData.headers['Cookie'] = Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
                }

                const pageOrigin = matchingTabs[0] ? new URL(matchingTabs[0].url).origin : `https://${targetObj.hostname}`;
                const pageUrl = matchingTabs[0] ? matchingTabs[0].url : `https://${targetObj.hostname}/`;
                if (!taskData.headers['Origin'] || taskData.headers['Origin'].includes('chrome-extension://')) {
                    taskData.headers['Origin'] = pageOrigin;
                }
                if (!taskData.headers['Referer'] || taskData.headers['Referer'].includes('chrome-extension://')) {
                    taskData.headers['Referer'] = pageUrl;
                }
            } catch (err) {
                console.warn('[FetchStream] Could not gather cookies:', err);
            }
        }

        if (chrome.scripting) {
            try {
                const allTabs = await new Promise(r => chrome.tabs.query({}, r));
                const targetObj = new URL(targetUrl);
                const hostParts = targetObj.hostname.split('.');
                const apex = hostParts.length >= 2 ? hostParts.slice(-2).join('.') : targetObj.hostname;
                const candidateTab = (allTabs || []).find(t => t.url && t.url.startsWith('http') && (t.url.includes(apex) || t.url.includes(targetObj.hostname)));
                const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                const tabToInspect = candidateTab || (activeTab?.url?.startsWith('http') ? activeTab : null);

                if (tabToInspect?.id) {
                    const res = await chrome.scripting.executeScript({
                        target: { tabId: tabToInspect.id },
                        func: () => {
                            const tokens = {};
                            try {
                                for (let i = 0; i < localStorage.length; i++) {
                                    const k = localStorage.key(i);
                                    if (/token|auth|jwt|session|user/i.test(k)) tokens[k] = localStorage.getItem(k);
                                }
                                for (let i = 0; i < sessionStorage.length; i++) {
                                    const k = sessionStorage.key(i);
                                    if (/token|auth|jwt|session|user/i.test(k)) tokens[k] = sessionStorage.getItem(k);
                                }
                            } catch (e) {}
                            return tokens;
                        }
                    });
                    if (res && res[0]?.result) {
                        const tokens = res[0].result;
                        for (const [k, raw] of Object.entries(tokens)) {
                            if (!raw || typeof raw !== 'string') continue;
                            const cleanVal = raw.replace(/^["']|["']$/g, '').trim();
                            if (cleanVal.length > 8) {
                                if (!taskData.headers['Authorization']) {
                                    taskData.headers['Authorization'] = cleanVal.startsWith('Bearer ') ? cleanVal : `Bearer ${cleanVal}`;
                                }
                                taskData.headers[k] = cleanVal;
                            }
                        }
                    }
                }
            } catch (err) {
                console.warn('[FetchStream] Could not inspect tab storage:', err);
            }
        }

        const initialJob = {
            id: jobId,
            name: fileName,
            service: uploadService,
            progress: 5,
            stage: "STARTING",
            status: "RUNNING",
            speed: "Connecting to Cloud Runner...",
            abortController: abortController
        };

        this.renderActiveServerUpload(initialJob);

        if (this.$activeServerUploadsSection) {
            this.$activeServerUploadsSection.classList.remove("d-none");
        }

        let isDispatched = false;
        if (relayUrl) {
            try {
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
                if (serverConfig?.apiKey) {
                    reqHeaders['Authorization'] = `Bearer ${serverConfig.apiKey}`;
                    reqHeaders['X-API-Key'] = serverConfig.apiKey;
                }

                const vaultData = await chrome.storage.session.get('fs_vault_unlocked');
                const relayRes = await fetch(`${relayUrl.replace(/\/+$/, '')}/api/server-relay`, {
                        method: 'POST',
                        headers: reqHeaders,
                        body: JSON.stringify({
                            jobId: jobId,
                            mediaUrl: targetUrl,
                            headers: cleanHeaders,
                            fileName: fileName,
                            type: isHls ? 'hls' : 'direct',
                            format: details.format || 'mp4',
                            service: uploadService,
                            threads: Number(this.options.concurrency) || 8,
                            credentials: {
                                gofile: {
                                    token: vaultData?.fs_vault_unlocked?.gofileToken,
                                    folderId: vaultData?.fs_vault_unlocked?.gofileFolderId
                                },
                                s3_compatible: {
                                    endpoint: vaultData?.fs_vault_unlocked?.s3Endpoint,
                                    bucket: vaultData?.fs_vault_unlocked?.s3Bucket,
                                    region: vaultData?.fs_vault_unlocked?.s3Region,
                                    accessKeyId: vaultData?.fs_vault_unlocked?.s3AccessKey,
                                    secretAccessKey: vaultData?.fs_vault_unlocked?.s3SecretKey,
                                    prefix: vaultData?.fs_vault_unlocked?.s3Prefix
                                },
                                telegram: {
                                    botToken: vaultData?.fs_vault_unlocked?.telegramBotToken,
                                    chatId: vaultData?.fs_vault_unlocked?.telegramChatId
                                }
                            },
                            useFallbackProxy: serverConfig.useFallbackProxy !== false
                        }),
                        signal: abortController.signal
                    });

                const relayData = await relayRes.json().catch(() => ({}));
                if (!relayRes.ok || !relayData.jobId) {
                    throw new Error(relayData.error || `Server runner rejected relay job (${relayRes.status})`);
                }
                isDispatched = true;
                this.renderActiveServerUpload({
                    ...initialJob,
                    progress: 10,
                    stage: 'DISPATCHED',
                    speed: 'Runner processing in cloud...'
                });
            } catch (connErr) {
                console.error('[FetchStream] Error contacting cloud runner:', connErr);
                this.renderActiveServerUpload({
                    ...initialJob,
                    status: 'FAILED',
                    error: connErr.message || 'Could not connect to Cloud Runner'
                });
                this.toast(`Runner Error: ${connErr.message || 'Could not connect to Cloud Runner'}`, 5000, true);
                return;
            }
        }

        const serverTaskData = {
            id: jobId,
            mediaUrl: targetUrl,
            url: "",
            name: fileName,
            type: details.type,
            format: details.format,
            resolution: details.resolution || details.selectedResolution || null,
            threads: this.options.concurrency || 8,
            headers: taskData.headers,
            service: uploadService,
            credentials: {
                ...(this.options.upload?.credentials || {}),
                ...((uploadService && this.options.upload?.credentials?.[uploadService]) ? this.options.upload.credentials[uploadService] : {})
            },
            action: 'server_upload',
            isDispatched: isDispatched,
            serverConfig: serverConfig
        };

        chrome.runtime.sendMessage({
            cmd: "REGISTER_SERVER_UPLOAD",
            parameter: {
                id: jobId,
                mediaUrl: targetUrl,
                url: "",
                name: fileName,
                service: uploadService,
                progress: 10,
                stage: "DISPATCHED",
                status: "RUNNING",
                speed: "Runner processing in cloud...",
                isDispatched: isDispatched
            }
        });

        const downloaderUrl = chrome.runtime.getURL("downloader.html");
        chrome.tabs.query({}, (tabs) => {
            const existingTab = tabs.find(t => t.url && t.url.startsWith(downloaderUrl));

            if (existingTab) {
                chrome.storage.local.set({ [jobId]: serverTaskData }, () => {
                    chrome.tabs.sendMessage(existingTab.id, {
                        cmd: "ADD_SERVER_TASK",
                        parameter: serverTaskData
                    }, (response) => {
                        if (chrome.runtime.lastError || !response?.received) {
                            chrome.storage.local.set({ srv_queue: serverTaskData });
                        }
                    });
                });
                chrome.tabs.update(existingTab.id, { active: true });
                if (existingTab.windowId) chrome.windows.update(existingTab.windowId, { focused: true });
            } else {
                chrome.storage.local.set({ [jobId]: serverTaskData }, () => {
                    chrome.tabs.create({ url: `${downloaderUrl}?srvId=${encodeURIComponent(jobId)}` });
                });
            }
        });

        this.toast(`🚀 Server Upload dispatched to Download & Upload Manager: "${fileName}"!`, 3500);
    }

    renderActiveServerUpload(job) {
        if (!job || !job.id) return;

        let card = this.activeServerUploadCards[job.id];
        if (!card) {
            const cardEl = document.createElement("div");
            cardEl.className = "active-dl-card shadow-sm border";
            cardEl.style.borderColor = "#ddd6fe !important";
            cardEl.innerHTML = `
                <div class="d-flex justify-content-between align-items-center mb-1">
                    <span class="fw-semibold text-truncate small text-dark me-2 srv-title" style="max-width: 170px;">
                        <i class="bi bi-hdd-network-fill me-1" style="color: #7c3aed;"></i><span class="srv-name-text"></span>
                    </span>
                    <div class="d-flex align-items-center gap-1 flex-shrink-0">
                        <span class="badge srv-badge font-monospace" style="font-size: 0.65rem; background-color: #7c3aed; color: #fff;">RUNNING</span>
                        <button class="btn btn-sm btn-link text-muted p-0 srv-cancel-btn" style="line-height: 1;" title="Cancel / Dismiss">
                            <i class="bi bi-x text-danger"></i>
                        </button>
                    </div>
                </div>
                <div class="progress mb-1.5" style="height: 6px; border-radius: 3px; background-color: #ede9fe;">
                    <div class="progress-bar srv-progress-bar progress-bar-striped progress-bar-animated" role="progressbar" style="width: 5%; background-color: #7c3aed;"></div>
                </div>
                <div class="d-flex justify-content-between align-items-center mt-1">
                    <span class="text-muted font-monospace srv-stats" style="font-size: 0.72rem;">Starting...</span>
                    <span class="text-muted small srv-service"></span>
                </div>
                <div class="srv-result d-none mt-2 pt-1 border-top" style="font-size: 0.75rem;"></div>
            `;
            
            const nameEl = cardEl.querySelector('.srv-title');
            const nameTextEl = cardEl.querySelector('.srv-name-text');
            const srvServiceEl = cardEl.querySelector('.srv-service');
            nameEl.setAttribute('title', job.name || '');
            nameTextEl.textContent = job.name || 'File';
            srvServiceEl.textContent = this.getServiceDisplayName(job.service) || 'Cloud';

            const $cancelBtn = cardEl.querySelector(".srv-cancel-btn");
            $cancelBtn.onclick = async () => {
                this.serverPollingJobs.delete(job.id);
                if (job.abortController) {
                    try { job.abortController.abort(); } catch(e) {}
                }
                let relayUrl = (this.options.serverUpload?.relayUrl || "").replace(/\/+$/, "");
                let apiKey = this.options.serverUpload?.apiKey || "";
                try {
                    const session = await chrome.storage.session.get('fs_vault_unlocked');
                    if (session?.fs_vault_unlocked) {
                        if (session.fs_vault_unlocked.serverRelayUrl) relayUrl = session.fs_vault_unlocked.serverRelayUrl.trim().replace(/\/+$/, "");
                        if (session.fs_vault_unlocked.serverApiKey) apiKey = session.fs_vault_unlocked.serverApiKey.trim();
                    }
                } catch(e) {}
                
                if (relayUrl) {
                    try {
                        const reqHeaders = { 'Content-Type': 'application/json' };
                        if (apiKey) {
                            reqHeaders['Authorization'] = `Bearer ${apiKey}`;
                            reqHeaders['X-API-Key'] = apiKey;
                        }
                        await fetch(`${relayUrl}/api/server-cancel?jobId=${encodeURIComponent(job.id)}`, {
                            method: 'POST',
                            headers: reqHeaders,
                            body: JSON.stringify({ jobId: job.id })
                        });
                    } catch (e) {
                        console.warn("[FetchStream] Error notifying server cancel:", e);
                    }
                }
                chrome.runtime.sendMessage({
                    cmd: "ACTION_CANCEL_SERVER_UPLOAD",
                    parameter: { id: job.id }
                });
                chrome.runtime.sendMessage({
                    cmd: "SERVER_UPLOAD_FINISHED",
                    parameter: { id: job.id, status: "CANCELLED" }
                });
                this.removeActiveServerUpload(job.id);
                this.toast("Server upload task cancelled.", 2500);
            };

            this.$activeServerUploadsList.appendChild(cardEl);
            card = {
                el: cardEl,
                $bar: cardEl.querySelector(".srv-progress-bar"),
                $stats: cardEl.querySelector(".srv-stats"),
                $badge: cardEl.querySelector(".srv-badge"),
                $result: cardEl.querySelector(".srv-result"),
                state: job.status || "RUNNING"
            };
            this.activeServerUploadCards[job.id] = card;
        }

        card.state = job.status || card.state;
        const progress = job.progress !== undefined ? job.progress : 10;
        card.$bar.style.width = `${progress}%`;

        if (card.state === "COMPLETED") {
            card.$badge.textContent = "COMPLETED";
            card.$badge.style.backgroundColor = "#059669";
            card.$bar.className = "progress-bar srv-progress-bar bg-success";
            card.$bar.style.width = "100%";
            card.$stats.innerHTML = `<span class="text-success fw-bold">✓ 100% • Uploaded to ${this.getServiceDisplayName(job.service)}</span>`;
        } else if (card.state === "RUNNING" || card.state === "QUEUED") {
            const hasReadyLinks = Array.isArray(job.links) && job.links.length > 0;
            const extra = hasReadyLinks ? ` (${job.links.length} ready)` : '';
            card.$stats.textContent = `${progress}% • ${(job.speed || job.stage || 'Processing in cloud...')}${extra}`;
        } else if (card.state === "FAILED") {
            card.$badge.textContent = "FAILED";
            card.$badge.style.backgroundColor = "#dc2626";
            card.$bar.className = "progress-bar srv-progress-bar bg-danger";
            const failMsg = job.error || (job.speed && !job.speed.toLowerCase().includes('download') && !job.speed.toLowerCase().includes('starting') ? job.speed : null) || 'Error in cloud runner';
            card.$stats.innerHTML = `<span class="text-danger fw-bold">Failed</span> • <span class="srv-err-msg"></span>`;
            card.$stats.querySelector('.srv-err-msg').textContent = failMsg;
            card.$result.classList.remove("d-none");
            card.$result.innerHTML = `
                <div class="d-flex justify-content-between align-items-center gap-1 mt-1 pt-1 border-top">
                    <span class="text-danger small text-truncate srv-err-msg2" style="max-width: 170px;"></span>
                    <button class="btn btn-xs btn-outline-danger py-0 px-2 srv-save-pc-btn" style="font-size: 0.72rem; line-height: 1.4;">
                        <i class="bi bi-download me-1"></i> Save to PC
                    </button>
                </div>
            `;
            const errMsg2 = card.$result.querySelector('.srv-err-msg2');
            errMsg2.textContent = failMsg;
            errMsg2.title = failMsg;
            const srvSaveBtn = card.$result.querySelector(".srv-save-pc-btn");
            if (srvSaveBtn) {
                srvSaveBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.dispatchLocalDownloadFromJob(job, srvSaveBtn);
                };
            }
            return;
        }

        const uploadUrl = (job.url && job.url !== job.mediaUrl && !job.url.includes('.m3u8')) ? job.url : '';
        const linksList = (Array.isArray(job.links) && job.links.length > 0)
            ? job.links.filter(l => l.url && l.url !== job.mediaUrl && !l.url.includes('.m3u8'))
            : (uploadUrl ? [{ service: job.service, url: uploadUrl }] : []);

        if (linksList.length > 0) {
            card.$result.classList.remove("d-none");
            card.$result.innerHTML = ''; // Clear previous content
            linksList.forEach(item => {
                const svcName = this.getServiceDisplayName(item.service) || item.service || "Link";
                const u = item.url || "";
                if (u) {
                    const row = document.createElement('div');
                    row.className = "d-flex justify-content-between align-items-center gap-1 mb-1";
                    
                    const badge = document.createElement('span');
                    badge.className = "badge bg-light text-dark border me-1 text-truncate";
                    badge.style.fontSize = "0.65rem";
                    badge.style.maxWidth = "80px";
                    badge.textContent = svcName;
                    badge.title = svcName;
                    
                    const urlSpan = document.createElement('span');
                    urlSpan.className = "text-truncate text-muted font-monospace small flex-grow-1";
                    urlSpan.style.maxWidth = "140px";
                    urlSpan.textContent = u;
                    urlSpan.title = u;
                    
                    const actionsDiv = document.createElement('div');
                    actionsDiv.className = "d-flex gap-1 flex-shrink-0";
                    
                    if (u.startsWith("http")) {
                        const a = document.createElement('a');
                        a.href = u;
                        a.target = "_blank";
                        a.className = "btn btn-xs btn-outline-success py-0 px-1.5";
                        a.style.fontSize = "0.7rem";
                        a.innerHTML = '<i class="bi bi-box-arrow-up-right"></i> Open';
                        actionsDiv.appendChild(a);
                    }
                    
                    const copyBtn = document.createElement('button');
                    copyBtn.className = "btn btn-xs btn-outline-secondary py-0 px-1.5 srv-copy-link-btn";
                    copyBtn.style.fontSize = "0.7rem";
                    copyBtn.setAttribute('data-url', u);
                    copyBtn.innerHTML = '<i class="bi bi-clipboard"></i> Copy';
                    actionsDiv.appendChild(copyBtn);
                    
                    row.appendChild(badge);
                    row.appendChild(urlSpan);
                    row.appendChild(actionsDiv);
                    card.$result.appendChild(row);
                }
            });
            card.$result.querySelectorAll(".srv-copy-link-btn").forEach(btn => {
                btn.onclick = () => {
                    const targetUrl = btn.getAttribute("data-url");
                    navigator.clipboard.writeText(targetUrl).then(() => {
                        btn.innerHTML = '<i class="bi bi-check2 text-success"></i> Copied!';
                        this.toast("✓ Link copied to clipboard!");
                        setTimeout(() => { btn.innerHTML = '<i class="bi bi-clipboard"></i> Copy'; }, 2000);
                    });
                };
            });
        } else if (card.state !== "COMPLETED") {
            card.$result.classList.add("d-none");
        }

        this.updateActiveServerUploadsHeader();
    }

    dispatchLocalDownloadFromJob(job, btn) {
        if (!job || !job.url) {
            this.toast("Original media URL unavailable to save.", 3000, true);
            return;
        }
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1" style="width: 0.7rem; height: 0.7rem;"></span>Starting...';
        }
        const dlData = {
            id: `dl_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            url: job.url,
            name: job.name || 'video.mp4',
            type: job.type || 'direct',
            format: job.format || 'mp4',
            resolution: job.resolution || null,
            headers: job.headers || {},
            action: 'download',
            service: 'local'
        };
        const downloaderUrl = chrome.runtime.getURL("downloader.html");
        chrome.tabs.query({}, (tabs) => {
            const existingTab = tabs.find(t => t.url && t.url.startsWith(downloaderUrl));
            if (existingTab) {
                chrome.tabs.sendMessage(existingTab.id, {
                    cmd: "ADD_TASK",
                    parameter: dlData
                }, (response) => {
                    if (chrome.runtime.lastError || !response?.received) {
                        chrome.storage.local.set({ [dlData.id]: dlData, queue: dlData });
                    }
                });
                chrome.tabs.update(existingTab.id, { active: true });
            } else {
                chrome.storage.local.set({ [dlData.id]: dlData }, () => {
                    chrome.tabs.create({ url: `${downloaderUrl}?id=${encodeURIComponent(dlData.id)}` });
                });
            }
            this.toast(`⬇ Started local download for "${job.name || 'file'}"!`, 3000);
            this.removeActiveServerUpload(job.id);
        });
    }

    removeActiveServerUpload(id) {
        this.serverPollingJobs.delete(id);
        if (this.activeServerUploadCards[id]) {
            this.activeServerUploadCards[id].el.remove();
            delete this.activeServerUploadCards[id];
            this.updateActiveServerUploadsHeader();
        }
    }

    updateActiveServerUploadsHeader() {
        const count = Object.keys(this.activeServerUploadCards).length;
        if (this.$activeServerUploadsCount) {
            this.$activeServerUploadsCount.textContent = count.toString();
        }
        if (this.$activeServerUploadsSection) {
            if (count > 0) {
                this.$activeServerUploadsSection.classList.remove("d-none");
            } else {
                this.$activeServerUploadsSection.classList.add("d-none");
            }
        }
    }

    async checkForUpdates() {
        // Removed manual GitHub version check.
        // Microsoft Edge Add-ons store handles background auto-updates automatically.
    }

    toast(message, duration = 3000, isError = false) {
        const wrapper = document.createElement("div");
        wrapper.style.zIndex = "99999";
        wrapper.className = "w-100 position-fixed top-0 start-0 d-flex justify-content-center pt-3 pe-none";

        const toastEl = document.createElement("div");
        toastEl.className = `alert ${isError ? 'alert-danger' : 'alert-info'} py-2 px-3 shadow small pe-auto d-flex align-items-center gap-2`;
        toastEl.innerText = message;

        wrapper.appendChild(toastEl);
        document.body.appendChild(wrapper);

        setTimeout(() => wrapper.remove(), duration);
    }

    async init() {
        if (typeof window !== "undefined" && window.bootstrap) {
            this.bootstrap = window.bootstrap;
        } else {
            try {
                const bsMod = await import("../bootstrap/js/bootstrap.bundle.min.js");
                this.bootstrap = window.bootstrap || bsMod?.bootstrap || bsMod?.default || bsMod;
            } catch (e) {
                console.warn("[FetchStream] Bootstrap bundle load warning:", e);
                this.bootstrap = window.bootstrap || null;
            }
        }

        try {
            await this.getOptions();
            this.optionRender();
            this.setupCategoryTabs();
        } catch (e) {
            console.error("[FetchStream] Options/tabs init error:", e);
        }

        this.$homeBtn.onclick = () => {
            chrome.tabs.create({ url: "chrome://downloads/" });
        };

        const openDownloaderPage = () => {
            const downloaderUrl = chrome.runtime.getURL("downloader.html");
            chrome.tabs.query({}, (tabs) => {
                const found = tabs.find(t => t.url && t.url.startsWith(downloaderUrl));
                if (found) {
                    chrome.tabs.update(found.id, { active: true });
                    chrome.windows.update(found.windowId, { focused: true });
                } else {
                    chrome.tabs.create({ url: downloaderUrl });
                }
            });
        };

        if (this.$openDownloadsTab) {
            this.$openDownloadsTab.onclick = openDownloaderPage;
        }

        if (this.$openDownloadsTabForServer) {
            this.$openDownloadsTabForServer.onclick = openDownloaderPage;
        }

        if (this.$dashboardBtn) {
            this.$dashboardBtn.onclick = openDownloaderPage;
        }

        if (this.$clearListBtn) {
            this.$clearListBtn.onclick = () => {
                if (this.tab && this.tab.id) {
                    chrome.runtime.sendMessage({ cmd: "CLEAR_TAB_STORAGE", parameter: { tabId: this.tab.id } }, () => {
                        this.items.forEach(item => item.$item.remove());
                        this.items = [];
                        this.updateBadge();
                        this.toast("List cleared", 2000);
                    });
                }
            };
        }

        if (this.$refreshPageBtn) {
            this.$refreshPageBtn.onclick = () => {
                const icon = this.$refreshPageBtn.querySelector("i");
                if (icon) icon.classList.add("spin-animation");
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    if (tabs && tabs[0] && tabs[0].id) {
                        chrome.runtime.sendMessage({ cmd: "CLEAR_TAB_STORAGE", parameter: { tabId: tabs[0].id } }, () => {
                            chrome.tabs.reload(tabs[0].id, () => {
                                this.items.forEach(item => item.$item.remove());
                                this.items = [];
                                this.renderedCards = {};
                                if (this.$mediaList) {
                                    this.$mediaList.innerHTML = `
                                        <div class="text-center py-4 text-muted">
                                            <div class="spinner-border spinner-border-sm text-primary mb-2" role="status"></div>
                                            <div class="small fw-semibold">Reloading page and capturing media streams...</div>
                                        </div>
                                    `;
                                }
                                this.updateBadge();
                                this.toast("Refreshing page & rescanning media...", 2500);
                                setTimeout(() => {
                                    if (icon) icon.classList.remove("spin-animation");
                                }, 1200);
                            });
                        });
                    } else {
                        if (icon) icon.classList.remove("spin-animation");
                    }
                });
            };
        }

        const openUploadPage = () => {
            const uploadUrl = chrome.runtime.getURL("upload.html");
            chrome.tabs.query({}, (tabs) => {
                const found = tabs.find(t => t.url && t.url.startsWith(uploadUrl));
                if (found) {
                    chrome.tabs.update(found.id, { active: true });
                    chrome.windows.update(found.windowId, { focused: true });
                } else {
                    chrome.tabs.create({ url: uploadUrl });
                }
            });
        };

        if (this.$manualUploadBtn) {
            this.$manualUploadBtn.onclick = openUploadPage;
        }

        if (this.$openUploadTab) {
            this.$openUploadTab.onclick = openUploadPage;
        }

        if (this.$historyBtn) {
            this.$historyBtn.onclick = () => {
                const historyUrl = chrome.runtime.getURL("history.html");
                chrome.tabs.query({}, (tabs) => {
                    const found = tabs.find(t => t.url && t.url.startsWith(historyUrl));
                    if (found) {
                        chrome.tabs.update(found.id, { active: true });
                        chrome.windows.update(found.windowId, { focused: true });
                        chrome.tabs.sendMessage(found.id, { cmd: "HISTORY_UPDATED" }, () => { if (chrome.runtime.lastError) {} });
                    } else {
                        chrome.tabs.create({ url: historyUrl });
                    }
                });
            };
        }

        const $apiDocsBtn = this.selector("apiDocsBtn");
        if ($apiDocsBtn) {
            $apiDocsBtn.onclick = (e) => {
                e.preventDefault();
                const docUrl = "https://fetchstream.in/documentation";
                if (chrome.tabs?.create) {
                    chrome.tabs.create({ url: docUrl });
                } else {
                    window.open(docUrl, "_blank");
                }
            };
        }

        const $faqBtn = this.selector("faqBtn");
        if ($faqBtn) {
            $faqBtn.onclick = (e) => {
                e.preventDefault();
                const faqUrl = "https://fetchstream.in#faq";
                if (chrome.tabs?.create) {
                    chrome.tabs.create({ url: faqUrl });
                } else {
                    window.open(faqUrl, "_blank");
                }
            };
        }

        const $websiteBtn = this.selector("websiteBtn");
        if ($websiteBtn) {
            $websiteBtn.onclick = (e) => {
                e.preventDefault();
                const webUrl = "https://fetchstream.in";
                if (chrome.tabs?.create) {
                    chrome.tabs.create({ url: webUrl });
                } else {
                    window.open(webUrl, "_blank");
                }
            };
        }

        if (this.$pauseAllUploadsBtn) {
            this.$pauseAllUploadsBtn.onclick = () => {
                chrome.runtime.sendMessage({ cmd: "PAUSE_ALL_UPLOADS" });
            };
        }

        if (this.$cancelAllUploadsBtn) {
            this.$cancelAllUploadsBtn.onclick = () => {
                chrome.runtime.sendMessage({ cmd: "CANCEL_ALL_UPLOADS" });
                for (const id in this.activeUploadCards) {
                    this.removeActiveUpload(id);
                }
            };
        }

        // Determine active tab
        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tabs || tabs.length === 0) {
                this.$loading?.remove();
                this.$empty?.classList.remove("d-none");
                return;
            }
            this.tab = tabs[0];
            this.storageKey = `storage${this.tab.id}`;
            this.checkPdfViewerOnPage();
        } catch (e) {
            console.warn("[FetchStream] Tab query error:", e);
            this.$loading?.remove();
            this.$empty?.classList.remove("d-none");
            return;
        }

        // Retrieve active downloads & uploads
        this.fetchActiveDownloads();
        this.fetchActiveUploads();
        this.fetchActiveServerUploads();

        // Retrieve stored streams for this tab
        const storedItems = await new Promise((resolve) => {
            chrome.storage.local.get([this.storageKey], (res) => {
                resolve(res?.[this.storageKey] || {});
            });
        });

        // Listen for new items and download progress updates
        chrome.runtime.onMessage.addListener((message) => {
            if (message?.cmd === "POPUP_APPEND_ITEMS" && message.parameter?.tab === this.tab.id) {
                const itemMap = message.parameter.item || {};
                this.$loading?.remove();
                this.$empty?.classList.add("d-none");
                this.$container?.classList.remove("d-none");
                for (const key in itemMap) {
                    try {
                        this.itemCreate(itemMap[key]);
                    } catch (e) {
                        console.error("[FetchStream] Error creating streamed item:", e);
                    }
                }
                this.updateCategoryCounts();
                this.applyFilter();
            }

            if (message?.cmd === "POPUP_UPDATE_ITEM" && message.parameter?.tab === this.tab.id) {
                const { requestId, resolution, variants, masterUrl } = message.parameter || {};
                const matched = this.items.find(i => i.requestId === requestId);
                if (matched) {
                    matched.detail.resolution = resolution;
                    if (variants) matched.detail.variants = variants;
                    if (masterUrl) matched.detail.masterUrl = masterUrl;
                    if (typeof matched.updateQuality === "function") {
                        matched.updateQuality(variants || matched.detail.variants, resolution);
                    }
                }
            }

            if (message?.cmd === "DOWNLOAD_PROGRESS_TICK" && message.parameter) {
                this.renderActiveDownload(message.parameter);
            }

            if (message?.cmd === "DOWNLOAD_FINISHED" && message.parameter) {
                const dlId = message.parameter.id;
                const finalUrl = message.parameter.finalUrl;
                const isFailed = message.parameter.status === 'FAILED' || 
                                 message.parameter.state === 'FAILED' || 
                                 Boolean(message.parameter.error);
                const card = this.activeDownloadCards[dlId];
                if (card) {
                    if (isFailed) {
                        card.state = "failed";
                        if (card.$badge) {
                            card.$badge.textContent = "UPLOAD FAILED";
                            card.$badge.className = "badge dl-badge font-monospace text-white";
                            card.$badge.style.backgroundColor = "#dc2626";
                        }
                        if (card.$bar) {
                            card.$bar.className = "progress-bar dl-progress-bar";
                            card.$bar.style.backgroundColor = "#dc2626";
                            card.$bar.style.width = "100%";
                        }
                        if (card.$pauseBtn) card.$pauseBtn.remove();

                        const errMsg = message.parameter.error || "Upload failed";
                        const isTgLimit = errMsg.includes("50 MB") || errMsg.includes("Telegram");

                        card.$stats.innerHTML = `
                            <div class="mt-1 w-100">
                                <div class="text-danger small fw-semibold text-truncate mb-1" title="${errMsg}">
                                    <i class="bi bi-exclamation-triangle-fill me-1"></i>${errMsg}
                                </div>
                                <div class="d-flex align-items-center justify-content-between gap-1 pt-1 border-top mt-1">
                                    <button class="btn btn-xs btn-outline-danger py-0 px-2 popup-save-pc-btn" style="font-size: 0.72rem; line-height: 1.4;">
                                        <i class="bi bi-download me-1"></i> Save to PC Instead
                                    </button>
                                    ${isTgLimit ? '<span class="text-muted small" style="font-size: 0.65rem;">Tip: Use ⚡ Server Upload</span>' : ''}
                                </div>
                            </div>
                        `;

                        const saveBtn = card.$stats.querySelector(".popup-save-pc-btn");
                        if (saveBtn) {
                            saveBtn.onclick = (e) => {
                                e.stopPropagation();
                                this.requestTaskSaveToPc(dlId, saveBtn);
                            };
                        }
                        return;
                    }

                    card.state = "completed";
                    if (card.$badge) {
                        card.$badge.textContent = "COMPLETED";
                        card.$badge.className = "badge dl-badge font-monospace bg-success";
                        card.$badge.style.backgroundColor = "";
                    }
                    if (card.$bar) {
                        card.$bar.className = "progress-bar dl-progress-bar bg-success";
                        card.$bar.style.backgroundColor = "";
                        card.$bar.style.width = "100%";
                    }
                    if (card.$stats) {
                        if (finalUrl) {
                            const rawLinks = (message.parameter.multiLinks && message.parameter.multiLinks.length > 0)
                                ? message.parameter.multiLinks
                                : ((Array.isArray(message.parameter.links) && message.parameter.links.length > 0)
                                    ? message.parameter.links
                                    : [{ service: this.getServiceDisplayName(message.parameter.service) || 'Cloud', url: finalUrl }]);

                            const linksList = rawLinks.filter(l => l && l.url && !l.error);

                            if (linksList.length > 1) {
                                card.$stats.innerHTML = `<span class="text-success fw-bold d-block mb-1">✓ Upload Complete (${linksList.length} mirrors)</span><div class="d-flex flex-column gap-1 mt-1 w-100 srv-links-list"></div>`;
                                const listDiv = card.$stats.querySelector('.srv-links-list');
                                
                                linksList.forEach(lnk => {
                                    const svcName = this.getServiceDisplayName(lnk.service) || lnk.service || 'Link';
                                    const row = document.createElement('div');
                                    row.className = "d-flex justify-content-between align-items-center bg-light p-1 rounded border";
                                    
                                    const nameSpan = document.createElement('span');
                                    nameSpan.className = "small fw-bold text-dark text-truncate";
                                    nameSpan.style.maxWidth = "85px";
                                    nameSpan.textContent = svcName;
                                    nameSpan.title = svcName;
                                    
                                    const actionsDiv = document.createElement('div');
                                    actionsDiv.className = "d-flex align-items-center gap-1";
                                    
                                    if (lnk.url.startsWith('http')) {
                                        const aOpen = document.createElement('a');
                                        aOpen.href = lnk.url;
                                        aOpen.target = "_blank";
                                        aOpen.className = "btn btn-xs btn-outline-success py-0 px-1.5";
                                        aOpen.style.fontSize = "0.7rem";
                                        aOpen.innerHTML = '<i class="bi bi-box-arrow-up-right"></i> Open';
                                        actionsDiv.appendChild(aOpen);
                                    }
                                    
                                    const copyBtn = document.createElement('button');
                                    copyBtn.className = "btn btn-xs btn-success py-0 px-2 active-dl-copy-btn";
                                    copyBtn.style.fontSize = "0.75rem";
                                    copyBtn.setAttribute('data-url', lnk.url);
                                    copyBtn.innerHTML = '<i class="bi bi-clipboard me-1"></i>Copy';
                                    actionsDiv.appendChild(copyBtn);
                                    
                                    row.appendChild(nameSpan);
                                    row.appendChild(actionsDiv);
                                    listDiv.appendChild(row);
                                });

                                card.$stats.querySelectorAll(".active-dl-copy-btn").forEach(btn => {
                                    btn.onclick = (e) => {
                                        e.stopPropagation();
                                        const u = btn.getAttribute("data-url");
                                        navigator.clipboard.writeText(u).then(() => {
                                            btn.innerHTML = '<i class="bi bi-check2"></i> Copied!';
                                            this.toast("✓ Upload link copied!");
                                            setTimeout(() => { btn.innerHTML = '<i class="bi bi-clipboard me-1"></i>Copy'; }, 2000);
                                        });
                                    };
                                });
                            } else {
                                const singleU = linksList[0]?.url || finalUrl;
                                card.$stats.innerHTML = `<div class="d-flex align-items-center justify-content-between mt-1"><span class="text-success fw-bold">✓ Upload Complete</span><button class="btn btn-xs btn-success py-0 px-2 active-dl-copy-btn" style="font-size:0.75rem;"><i class="bi bi-clipboard me-1"></i>Copy Link</button></div>`;
                                const copyBtn = card.$stats.querySelector(".active-dl-copy-btn");
                                if (copyBtn) {
                                    copyBtn.onclick = (e) => {
                                        e.stopPropagation();
                                        navigator.clipboard.writeText(singleU).then(() => {
                                            copyBtn.innerHTML = '<i class="bi bi-check2"></i> Copied!';
                                            this.toast("✓ Upload link copied!");
                                        });
                                    };
                                }
                            }
                        } else {
                            card.$stats.innerHTML = '<span class="text-success fw-bold">✓ Download Complete & File Saved</span>';
                        }
                    }
                    if (card.$pauseBtn) card.$pauseBtn.remove();
                    setTimeout(() => {
                        this.removeActiveDownload(dlId);
                    }, finalUrl ? 8000 : 3500);
                } else if (!isFailed) {
                    this.removeActiveDownload(dlId);
                }

                if (finalUrl) {
                    const matched = this.items.find(i => 
                        (i.detail.url === message.parameter.url) || 
                        (message.parameter.name && i.detail.name && (i.detail.name === message.parameter.name || message.parameter.name.startsWith(i.detail.name)))
                    );
                    if (matched) {
                        this.showItemCopyButton(matched, finalUrl, message.parameter.multiLinks || message.parameter.links);
                    }
                }
            }

            if (message?.cmd === "UPLOAD_LINK_GENERATED" && message.parameter) {
                const matched = this.items.find(i => 
                    (message.parameter.name && i.detail.name && (i.detail.name === message.parameter.name || message.parameter.name.startsWith(i.detail.name)))
                );
                if (matched && message.parameter.link) {
                    this.showItemCopyButton(matched, message.parameter.link.url, [message.parameter.link]);
                }
                
                const ulCard = this.activeUploadCards[message.parameter.id];
                if (ulCard && message.parameter.link) {
                    if (!ulCard.links) ulCard.links = [];
                    if (!ulCard.links.some(l => l.url === message.parameter.link.url)) {
                        ulCard.links.push(message.parameter.link);
                        this.renderActiveUploadLinks(ulCard);
                    }
                }
            }

            if (message?.cmd === "UPLOAD_PROGRESS_TICK" && message.parameter) {
                this.renderActiveUpload(message.parameter);
            }

            if (message?.cmd === "UPLOAD_FINISHED_TICK" && message.parameter) {
                const ulId = message.parameter.id;
                const uploadUrl = message.parameter.url || (message.parameter.result && message.parameter.result.url);
                const card = this.activeUploadCards[ulId];
                if (card) {
                    if (card.$badge) {
                        card.$badge.textContent = "COMPLETED";
                        card.$badge.className = "badge ul-badge font-monospace bg-success";
                    }
                    if (card.$bar) {
                        card.$bar.className = "progress-bar ul-progress-bar bg-success";
                        card.$bar.style.width = "100%";
                    }
                    if (card.$stats) {
                        if (uploadUrl) {
                            card.$stats.innerHTML = `<div class="d-flex align-items-center justify-content-between mt-1"><span class="text-success fw-bold">✓ Upload Complete</span><button class="btn btn-xs btn-success py-0 px-2 active-ul-copy-btn" style="font-size:0.75rem;"><i class="bi bi-clipboard me-1"></i>Copy Link</button></div>`;
                            const copyBtn = card.$stats.querySelector(".active-ul-copy-btn");
                            if (copyBtn) {
                                copyBtn.onclick = (e) => {
                                    e.stopPropagation();
                                    navigator.clipboard.writeText(uploadUrl).then(() => {
                                        copyBtn.innerHTML = '<i class="bi bi-check2"></i> Copied!';
                                        this.toast("✓ Upload link copied!");
                                    });
                                };
                            }
                        } else {
                            card.$stats.innerHTML = '<span class="text-success fw-bold">✓ Upload Complete</span>';
                        }
                    }
                    setTimeout(() => {
                        this.removeActiveUpload(ulId);
                    }, uploadUrl ? 5500 : 3500);
                } else {
                    this.removeActiveUpload(ulId);
                }

                if (uploadUrl) {
                    const matched = this.items.find(i => 
                        (message.parameter.name && i.detail.name && (i.detail.name === message.parameter.name || message.parameter.name.startsWith(i.detail.name)))
                    );
                    if (matched) {
                        this.showItemCopyButton(matched, uploadUrl);
                    }
                }
            }

            if (message?.cmd === "UPLOAD_CANCEL_ALL_TICK") {
                for (const id in this.activeUploadCards) {
                    this.removeActiveUpload(id);
                }
            }

            if (message?.cmd === "UPDATE_SERVER_UPLOAD_PROGRESS" && message.parameter) {
                this.renderActiveServerUpload(message.parameter);
            }

            if (message?.cmd === "SERVER_UPLOAD_FINISHED" && message.parameter) {
                const srvJob = message.parameter;
                if (srvJob && srvJob.id) {
                    this.serverPollingJobs.delete(srvJob.id);
                    if (srvJob.status === "CANCELLED") {
                        this.removeActiveServerUpload(srvJob.id);
                    } else if (srvJob.status === "FAILED") {
                        if (this.activeServerUploadCards[srvJob.id]) {
                            this.renderActiveServerUpload({
                                ...srvJob,
                                status: "FAILED",
                                error: srvJob.error || "Server upload failed"
                            });
                        }
                    } else if (this.activeServerUploadCards[srvJob.id]) {
                        this.renderActiveServerUpload({
                            ...srvJob,
                            status: "COMPLETED",
                            progress: 100
                        });
                        setTimeout(() => {
                            this.removeActiveServerUpload(srvJob.id);
                        }, 8000);
                    }

                    const rawFinalUrl = srvJob.url || (srvJob.links && srvJob.links[0]?.url) || '';
                    const finalUploadUrl = (rawFinalUrl && !rawFinalUrl.includes('.m3u8')) ? rawFinalUrl : '';
                    if (finalUploadUrl) {
                        const matched = this.items.find(i => 
                            (srvJob.mediaUrl && i.detail.url === srvJob.mediaUrl) || 
                            (srvJob.name && i.detail.name && (i.detail.name === srvJob.name || srvJob.name.startsWith(i.detail.name)))
                        );
                        if (matched) {
                            this.showItemCopyButton(matched, finalUploadUrl, srvJob.links);
                        }
                    }
                }
            }

            if (message?.cmd === "ACTION_CANCEL_SERVER_UPLOAD" && message.parameter?.id) {
                this.serverPollingJobs.delete(message.parameter.id);
                this.removeActiveServerUpload(message.parameter.id);
            }
        });

        try {
            if (Object.keys(storedItems).length === 0) {
                this.$empty?.classList.remove("d-none");
            } else {
                this.$empty?.classList.add("d-none");
                this.$container?.classList.remove("d-none");
                for (const key in storedItems) {
                    try {
                        this.itemCreate(storedItems[key]);
                    } catch (err) {
                        console.error("[FetchStream] Error rendering stream item:", err, storedItems[key]);
                    }
                }
                this.updateCategoryCounts();
                this.applyFilter();
            }
        } catch (err) {
            console.error("[FetchStream] Error rendering stored items:", err);
            this.$empty?.classList.remove("d-none");
        } finally {
            this.$loading?.remove();
        }

        this.scanPageForDownloadLinks();
        this.checkForUpdates();
    }
}

const popupManager = new PopupManager();
popupManager.init();
chrome.runtime.connect({ name: "POPUP" });
