/**
 * FetchStream Manual Upload Page Controller
 * Handles batch file/folder drag-and-drop, client-side ZIP packaging,
 * per-item service selection, sequential uploads, and real-time progress tracking.
 */

document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const folderInput = document.getElementById('folderInput');
    const selectFilesBtn = document.getElementById('selectFilesBtn');
    const selectFolderBtn = document.getElementById('selectFolderBtn');
    const serviceSelect = document.getElementById('serviceSelect');
    const serviceHelp = document.getElementById('serviceHelp');
    
    const startUploadBtn = document.getElementById('startUploadBtn');
    const pauseAllBtn = document.getElementById('pauseAllBtn');
    const cancelAllBtn = document.getElementById('cancelAllBtn');
    const clearQueueBtn = document.getElementById('clearQueueBtn');
    
    const queueList = document.getElementById('queueList');
    const emptyQueue = document.getElementById('emptyQueue');
    const queueCount = document.getElementById('queueCount');
    
    const summaryDiv = document.getElementById('uploadSummary');
    const summaryText = document.getElementById('summaryText');
    const summaryPercent = document.getElementById('summaryPercent');
    const summaryProgress = document.getElementById('summaryProgress');
    
    const zipNotice = document.getElementById('zipNotice');
    const zipNoticeText = document.getElementById('zipNoticeText');

    let uploadConfig = { service: 'all', credentials: {} };
    let fileQueue = [];
    let isUploading = false;
    let isQueuePaused = false;
    let currentActiveItem = null;

    // Load saved options
    chrome.storage.local.get(['options'], (res) => {
        const opts = res.options || (typeof OPTION !== 'undefined' ? OPTION : {});
        uploadConfig.credentials = opts.upload?.credentials || {};
        
        // Default to saved service if not local, or keep 'all'
        const saved = opts.upload?.service;
        if (saved && saved !== 'local') {
            const opt = serviceSelect.querySelector(`option[value="${saved}"]`);
            if (opt && !opt.disabled) {
                serviceSelect.value = saved;
            }
        }
        uploadConfig.service = serviceSelect.value;
        updateServiceHint();
    });

    serviceSelect.addEventListener('change', () => {
        uploadConfig.service = serviceSelect.value;
        updateServiceHint();
        fileQueue.forEach(item => {
            if (item.status === 'pending' && !item.customServiceSet) {
                item.service = serviceSelect.value;
                const selectEl = item.el?.querySelector('.item-service-select');
                if (selectEl) selectEl.value = serviceSelect.value;
                const captionContainer = item.el?.querySelector('.item-caption-container');
                if (captionContainer) {
                    if (item.service === 'telegram' || item.service === 'all') {
                        captionContainer.classList.remove('d-none');
                    } else {
                        captionContainer.classList.add('d-none');
                    }
                }
            }
        });
    });

    function getServiceOptionsHtml(selectedVal) {
        const services = [
            { value: 'all', label: '⚡ All Working (Multi-Link)' },
            { value: 'gofile.io', label: 'GoFile' },
            { value: 'buzzheavier.com', label: 'Buzzheavier' },
            { value: 'fuckingfast.co', label: 'FuckingFast' },
            { value: 'storage.to', label: 'Storage.to' },
            { value: 'catbox.moe', label: 'Catbox.moe' },
            { value: 'pixeldrain.com', label: 'Pixeldrain' },
            { value: 's3_compatible', label: 'S3-Compatible Storage' },
            { value: 'telegram', label: 'Telegram Bot' }
        ];
        return services.map(s => `<option value="${s.value}" ${s.value === selectedVal ? 'selected' : ''}>${s.label}</option>`).join('');
    }

    async function confirmLargeFolder(folderName, totalBytes) {
        const sizeStr = formatBytes(totalBytes);
        const modalEl = document.getElementById('largeFolderModal');
        if (modalEl && typeof bootstrap !== 'undefined' && bootstrap.Modal) {
            const nameEl = document.getElementById('largeFolderName');
            const sizeEl = document.getElementById('largeFolderSize');
            if (nameEl) nameEl.textContent = `"${folderName}"`;
            if (sizeEl) sizeEl.textContent = sizeStr;

            const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
            const proceedBtn = document.getElementById('proceedLargeFolderBtn');
            const cancelBtn = document.getElementById('cancelLargeFolderBtn');

            return new Promise((resolve) => {
                let resolved = false;
                const onProceed = () => {
                    if (!resolved) {
                        resolved = true;
                        cleanup();
                        modal.hide();
                        resolve(true);
                    }
                };
                const onCancel = () => {
                    if (!resolved) {
                        resolved = true;
                        cleanup();
                        modal.hide();
                        resolve(false);
                    }
                };
                const onHidden = () => {
                    if (!resolved) {
                        resolved = true;
                        cleanup();
                        resolve(false);
                    }
                };
                function cleanup() {
                    proceedBtn?.removeEventListener('click', onProceed);
                    cancelBtn?.removeEventListener('click', onCancel);
                    modalEl.removeEventListener('hidden.bs.modal', onHidden);
                }

                proceedBtn?.addEventListener('click', onProceed);
                cancelBtn?.addEventListener('click', onCancel);
                modalEl.addEventListener('hidden.bs.modal', onHidden);

                modal.show();
            });
        } else {
            const msg = `⚠️ Large Folder Warning (>100MB)\n\nThe selected folder "${folderName}" contains ${sizeStr} of files.\n\nCreating a ZIP archive of folders over 100MB directly inside your browser tab may cause high RAM usage or crash the browser.\n\nIt is strongly advised to compress this folder into a .zip file using your computer's ZIP tool first, then upload that .zip file directly.\n\nDo you want to proceed with in-browser packaging anyway?`;
            return Promise.resolve(await CustomDialog.confirm(msg));
        }
    }

    function updateServiceHint() {
        const val = serviceSelect.value;
        if (val === 'all') {
            serviceHelp.textContent = 'Uploads simultaneously to GoFile, Buzzheavier, FuckingFast, Storage.to, and Catbox.';
        } else {
            serviceHelp.textContent = `Using ${val} as default upload destination.`;
        }
    }

    // Format bytes
    function formatBytes(bytes, decimals = 2) {
        if (!+bytes) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
    }

    // Button click triggers
    selectFilesBtn.addEventListener('click', () => fileInput.click());
    selectFolderBtn.addEventListener('click', () => folderInput.click());
    dropZone.addEventListener('click', (e) => {
        if (e.target.tagName !== 'INPUT') fileInput.click();
    });

    fileInput.addEventListener('change', function() {
        if (this.files.length) {
            handleFileList(Array.from(this.files));
        }
        this.value = '';
    });

    folderInput.addEventListener('change', async function() {
        if (this.files.length) {
            await handleFolderFiles(Array.from(this.files));
        }
        this.value = '';
    });

    // Drag & Drop
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(name => {
        dropZone.addEventListener(name, (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
    });

    ['dragenter', 'dragover'].forEach(name => {
        dropZone.addEventListener(name, () => dropZone.classList.add('dragover'));
    });

    ['dragleave', 'drop'].forEach(name => {
        dropZone.addEventListener(name, () => dropZone.classList.remove('dragover'));
    });

    dropZone.addEventListener('drop', async (e) => {
        const items = e.dataTransfer.items;
        if (items && items.length > 0) {
            const files = [];
            const folderEntries = [];

            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (item.webkitGetAsEntry) {
                    const entry = item.webkitGetAsEntry();
                    if (entry) {
                        if (entry.isDirectory) {
                            folderEntries.push(entry);
                        } else {
                            const file = item.getAsFile();
                            if (file) files.push(file);
                        }
                    }
                } else {
                    const file = item.getAsFile();
                    if (file) files.push(file);
                }
            }

            if (files.length) handleFileList(files);

            for (const folder of folderEntries) {
                await processDirectoryEntry(folder);
            }
        } else if (e.dataTransfer.files.length) {
            handleFileList(Array.from(e.dataTransfer.files));
        }
    });

    // Handle standard files
    function handleFileList(files) {
        try {
            files.forEach(file => {
                addQueueItem(file, file.name, file.size, false);
            });
            updateUI();
        } catch(e) {
            CustomDialog.show({ title: 'Upload Error', message: e.message, type: 'danger' });
            console.error(e);
        }
    }

    // Handle folder files from <input webkitdirectory>
    async function handleFolderFiles(fileArray) {
        try {
            if (!fileArray.length) return;
            
            // Find folder name from webkitRelativePath
            const firstPath = fileArray[0].webkitRelativePath || '';
            const folderName = firstPath.split('/')[0] || 'folder';

            // Check if total folder size > 500MB (advise zipping on host PC due to time)
            const totalSize = fileArray.reduce((acc, f) => acc + (f.size || 0), 0);
            if (totalSize > 500 * 1024 * 1024) {
                const proceed = await confirmLargeFolder(folderName, totalSize);
                if (!proceed) {
                    return;
                }
            }

            showZipNotice(`Folder detected: "${folderName}" (${formatBytes(totalSize)}). Packaging into "${folderName}.zip"...`);

            const zip = new ZipBuilder();
            for (const f of fileArray) {
                const relativePath = f.webkitRelativePath || f.name;
                await zip.addFile(relativePath, f);
            }

            const zipBlob = await zip.generateBlob();
            hideZipNotice();

            const zipFile = new File([zipBlob], `${folderName}.zip`, { type: 'application/zip' });
            addQueueItem(zipFile, zipFile.name, zipFile.size, true);
            updateUI();
        } catch (e) {
            CustomDialog.show({ title: 'Folder Upload Error', message: e.message, type: 'danger' });
            console.error(e);
        }
    }

    // Process drag & dropped directory entry
    async function processDirectoryEntry(dirEntry) {
        const folderName = dirEntry.name || 'folder';

        try {
            const files = [];
            async function scan(entry, currentPath = '') {
                if (entry.isFile) {
                    const file = await new Promise((res, rej) => entry.file(res, rej));
                    files.push({ path: currentPath + entry.name, file });
                } else if (entry.isDirectory) {
                    const reader = entry.createReader();
                    const readEntries = () => new Promise((res, rej) => reader.readEntries(res, rej));
                    let batch;
                    do {
                        batch = await readEntries();
                        for (const child of batch) {
                            await scan(child, currentPath + entry.name + '/');
                        }
                    } while (batch.length > 0);
                }
            }

            await scan(dirEntry);

            // Check if total folder size > 100MB (advise zipping on host PC)
            const totalSize = files.reduce((acc, item) => acc + (item.file.size || 0), 0);
            if (totalSize > 100 * 1024 * 1024) {
                const proceed = await confirmLargeFolder(folderName, totalSize);
                if (!proceed) {
                    return;
                }
            }

            showZipNotice(`Folder detected: "${folderName}" (${formatBytes(totalSize)}). Packaging into "${folderName}.zip"...`);

            const zip = new ZipBuilder();
            for (const item of files) {
                await zip.addFile(item.path, item.file);
            }
            const zipBlob = await zip.generateBlob();
            const zipFile = new File([zipBlob], `${folderName}.zip`, { type: 'application/zip' });
            addQueueItem(zipFile, `${folderName}.zip`, zipFile.size, true);
        } catch(err) {
            console.error("Folder packing error:", err);
            await CustomDialog.alert(`Error packaging folder "${folderName}": ${err.message}`);
        } finally {
            hideZipNotice();
            updateUI();
        }
    }

    function showZipNotice(msg) {
        zipNoticeText.textContent = msg;
        zipNotice.classList.remove('d-none');
    }

    function hideZipNotice() {
        zipNotice.classList.add('d-none');
    }

    // Add item to queue
    function addQueueItem(file, displayName, size, isZipFolder = false) {
        const id = `upload_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        const item = {
            id,
            file,
            name: displayName,
            size: size,
            isZipFolder,
            service: uploadConfig.service,
            status: 'pending', // pending, uploading, paused, success, error, cancelled
            progress: 0,
            speed: '',
            uploadedBytes: 0,
            totalBytes: size,
            url: null,
            links: [],
            error: null,
            xhr: null,
            el: null
        };

        item.el = createQueueElement(item);
        fileQueue.push(item);
        queueList.appendChild(item.el);
    }

    function createQueueElement(item) {
        const div = document.createElement('div');
        div.className = 'queue-card';
        div.id = item.id;

        const currentSvc = item.service || uploadConfig.service || serviceSelect.value || 'all';
        item.service = currentSvc;

        const folderTag = item.isZipFolder ? '<span class="badge bg-info text-dark me-1"><i class="bi bi-folder-symlink me-1"></i>ZIP Folder</span>' : '';

        div.innerHTML = `
            <div class="d-flex justify-content-between align-items-start gap-2 mb-2">
                <div class="overflow-hidden flex-grow-1">
                    <div class="d-flex align-items-center gap-1 text-truncate mb-1">
                        ${folderTag}
                        <strong class="text-dark text-truncate item-title"></strong>
                    </div>
                    <div class="d-flex align-items-center gap-1.5 flex-wrap">
                        <span class="text-muted small">${formatBytes(item.size)} • Service:</span>
                        <select class="form-select form-select-sm item-service-select py-0 px-2 fw-semibold text-primary" style="width: auto; font-size: 0.75rem; height: 24px; border-color: #cbd5e1;" title="Choose upload service for this item">
                            ${getServiceOptionsHtml(item.service)}
                        </select>
                    </div>
                </div>
                <div class="d-flex align-items-center gap-1 flex-shrink-0">
                    <span class="badge bg-secondary font-monospace status-badge" style="font-size: 0.7rem;">PENDING</span>
                    <button class="btn btn-sm btn-outline-primary py-0 px-2 retry-btn d-none" title="Retry Upload" style="font-size: 0.75rem;"><i class="bi bi-arrow-clockwise me-1"></i>Retry</button>
                    <button class="btn btn-sm btn-outline-warning py-0 px-2 pause-btn d-none" title="Pause" style="font-size: 0.75rem;"><i class="bi bi-pause-fill"></i></button>
                    <button class="btn btn-sm btn-outline-success py-0 px-2 resume-btn d-none" title="Resume" style="font-size: 0.75rem;"><i class="bi bi-play-fill"></i></button>
                    <button class="btn btn-sm btn-outline-danger py-0 px-2 cancel-btn d-none" title="Cancel Upload" style="font-size: 0.75rem;"><i class="bi bi-x"></i> Cancel</button>
                    <button class="btn btn-sm btn-outline-danger py-0 px-2 clear-btn" title="Clear / Remove this upload" style="font-size: 0.75rem;"><i class="bi bi-trash"></i></button>
                </div>
            </div>

            <div class="progress mb-2" style="height: 8px; border-radius: 4px; background-color: #e2e8f0;">
                <div class="progress-bar item-progress-bar" role="progressbar" style="width: 0%; transition: width 0.15s ease;"></div>
            </div>

            <div class="d-flex justify-content-between align-items-center small text-muted font-monospace" style="font-size: 0.75rem;">
                <span class="item-stats">Ready to upload</span>
                <span class="item-speed"></span>
            </div>

            <div class="item-caption-container mt-2 ${item.service === 'telegram' || item.service === 'all' ? '' : 'd-none'}">
                <div class="input-group input-group-sm">
                    <span class="input-group-text bg-light text-info py-0 px-2" style="font-size: 0.72rem; border-color: #cbd5e1;">
                        <i class="bi bi-telegram me-1"></i> Caption
                    </span>
                    <input type="text" class="form-control form-control-sm item-caption-input py-0.5 px-2" placeholder="Telegram description / caption (optional)" style="font-size: 0.75rem; border-color: #cbd5e1;" spellcheck="false">
                </div>
            </div>

            <div class="result-container mt-2 pt-2 border-top d-none"></div>
        `;

        const captionInput = div.querySelector('.item-caption-input');
        if (captionInput) {
            captionInput.value = item.telegramCaption || '';
        }

        const titleEl = div.querySelector('.item-title');
        if (titleEl) {
            titleEl.textContent = item.name;
            titleEl.setAttribute('title', item.name);
        }

        const serviceSelectEl = div.querySelector('.item-service-select');
        const captionContainer = div.querySelector('.item-caption-container');
        const captionInputEl = div.querySelector('.item-caption-input');

        if (captionInputEl) {
            captionInputEl.oninput = () => {
                item.telegramCaption = captionInputEl.value;
            };
        }

        if (serviceSelectEl) {
            serviceSelectEl.onchange = (e) => {
                item.service = e.target.value;
                item.customServiceSet = true;
                if (captionContainer) {
                    if (item.service === 'telegram' || item.service === 'all') {
                        captionContainer.classList.remove('d-none');
                    } else {
                        captionContainer.classList.add('d-none');
                    }
                }
            };
        }

        const pauseBtn = div.querySelector('.pause-btn');
        const resumeBtn = div.querySelector('.resume-btn');
        const retryBtn = div.querySelector('.retry-btn');
        const cancelBtn = div.querySelector('.cancel-btn');
        const clearBtn = div.querySelector('.clear-btn');

        pauseBtn.onclick = () => pauseItem(item);
        resumeBtn.onclick = () => resumeItem(item);
        retryBtn.onclick = () => retryItem(item);
        cancelBtn.onclick = () => cancelItem(item);
        clearBtn.onclick = () => clearItem(item);

        return div;
    }

    function updateItemUI(item) {
        if (!item.el) return;
        const el = item.el;
        const badge = el.querySelector('.status-badge');
        const bar = el.querySelector('.item-progress-bar');
        const stats = el.querySelector('.item-stats');
        const speed = el.querySelector('.item-speed');
        const pauseBtn = el.querySelector('.pause-btn');
        const resumeBtn = el.querySelector('.resume-btn');
        const retryBtn = el.querySelector('.retry-btn');
        const cancelBtn = el.querySelector('.cancel-btn');
        const clearBtn = el.querySelector('.clear-btn');
        const resultContainer = el.querySelector('.result-container');

        bar.style.width = `${item.progress}%`;

        if (item.status === 'uploading') {
            badge.textContent = 'UPLOADING';
            badge.className = 'badge bg-primary font-monospace status-badge';
            bar.className = 'progress-bar item-progress-bar progress-bar-striped progress-bar-animated bg-primary';
            stats.textContent = `${formatBytes(item.uploadedBytes)} / ${formatBytes(item.totalBytes)} (${item.progress}%)`;
            speed.textContent = item.speed || '';
            pauseBtn.classList.remove('d-none');
            resumeBtn.classList.add('d-none');
            retryBtn.classList.add('d-none');
            cancelBtn.classList.remove('d-none');
            clearBtn.classList.add('d-none');
        } else if (item.status === 'paused') {
            badge.textContent = 'PAUSED';
            badge.className = 'badge bg-warning text-dark font-monospace status-badge';
            bar.className = 'progress-bar item-progress-bar bg-warning';
            stats.textContent = `Paused at ${item.progress}%`;
            speed.textContent = '';
            pauseBtn.classList.add('d-none');
            resumeBtn.classList.remove('d-none');
            retryBtn.classList.add('d-none');
            cancelBtn.classList.add('d-none');
            clearBtn.classList.remove('d-none');
        } else if (item.status === 'success') {
            badge.textContent = 'COMPLETED';
            badge.className = 'badge bg-success font-monospace status-badge';
            bar.className = 'progress-bar item-progress-bar bg-success';
            bar.style.width = '100%';
            stats.innerHTML = '<span class="text-success fw-bold">✓ Upload Complete</span>';
            speed.textContent = '';
            pauseBtn.classList.add('d-none');
            resumeBtn.classList.add('d-none');
            retryBtn.classList.add('d-none');
            cancelBtn.classList.add('d-none');
            clearBtn.classList.remove('d-none');

            // Render result link(s)
            renderResultLinks(item, resultContainer);
        } else if (item.status === 'error') {
            badge.textContent = 'FAILED';
            badge.className = 'badge bg-danger font-monospace status-badge';
            bar.className = 'progress-bar item-progress-bar bg-danger';
            stats.innerHTML = '<span class="text-danger fw-semibold err-txt"></span>';
            stats.querySelector('.err-txt').textContent = item.error || 'Upload error';
            speed.textContent = '';
            pauseBtn.classList.add('d-none');
            resumeBtn.classList.add('d-none');
            retryBtn.classList.remove('d-none');
            cancelBtn.classList.add('d-none');
            clearBtn.classList.remove('d-none');
        } else if (item.status === 'cancelled') {
            badge.textContent = 'CANCELLED';
            badge.className = 'badge bg-secondary font-monospace status-badge';
            bar.className = 'progress-bar item-progress-bar bg-secondary';
            stats.textContent = 'Upload cancelled';
            speed.textContent = '';
            pauseBtn.classList.add('d-none');
            resumeBtn.classList.add('d-none');
            retryBtn.classList.remove('d-none');
            cancelBtn.classList.add('d-none');
            clearBtn.classList.remove('d-none');
        } else if (item.status === 'pending') {
            badge.textContent = 'PENDING';
            badge.className = 'badge bg-secondary font-monospace status-badge';
            bar.className = 'progress-bar item-progress-bar';
            stats.textContent = 'Ready to upload';
            speed.textContent = '';
            pauseBtn.classList.add('d-none');
            resumeBtn.classList.add('d-none');
            retryBtn.classList.add('d-none');
            cancelBtn.classList.add('d-none');
            clearBtn.classList.remove('d-none');
        }

        const serviceSelectEl = el.querySelector('.item-service-select');
        if (serviceSelectEl) {
            serviceSelectEl.disabled = (item.status === 'uploading' || item.status === 'success');
        }
    }

    function renderResultLinks(item, container) {
        container.classList.remove('d-none');

        if (item.links && item.links.length > 0) {
            container.innerHTML = `
                <span class="small fw-semibold text-muted d-block mb-1">Generated Links (${item.links.length} Services):</span>
                <div class="d-flex flex-column gap-1 result-links-list"></div>
            `;
            const listDiv = container.querySelector('.result-links-list');
            item.links.forEach(l => {
                const box = document.createElement('div');
                box.className = "multi-link-box d-flex justify-content-between align-items-center gap-2";
                box.innerHTML = `
                    <div class="overflow-hidden text-truncate">
                        <strong class="text-dark srv-name"></strong>:
                        <a target="_blank" class="text-decoration-none text-primary ms-1 srv-link"></a>
                    </div>
                    <button class="btn btn-xs btn-outline-secondary copy-link-btn flex-shrink-0" style="font-size: 0.72rem; padding: 2px 6px;">
                        <i class="bi bi-clipboard"></i> Copy
                    </button>
                `;
                box.querySelector('.srv-name').textContent = l.service;
                const aEl = box.querySelector('.srv-link');
                aEl.href = l.url;
                aEl.textContent = l.url;
                aEl.title = l.url;
                const btn = box.querySelector('.copy-link-btn');
                btn.setAttribute('data-url', l.url);
                listDiv.appendChild(box);
            });
        } else if (item.url) {
            const isLink = item.url.startsWith('http');
            container.innerHTML = `
                <div class="d-flex justify-content-between align-items-center gap-2">
                    <span class="text-truncate small text-muted font-monospace srv-single-url" style="font-size: 0.78rem;"></span>
                    <div class="d-flex gap-1 flex-shrink-0 single-actions"></div>
                </div>
            `;
            const spanUrl = container.querySelector('.srv-single-url');
            spanUrl.textContent = item.url;
            spanUrl.title = item.url;
            
            const actionsDiv = container.querySelector('.single-actions');
            if (isLink) {
                const aOpen = document.createElement('a');
                aOpen.href = item.url;
                aOpen.target = "_blank";
                aOpen.className = "btn btn-sm btn-outline-primary py-0 px-2";
                aOpen.style.fontSize = "0.75rem";
                aOpen.innerHTML = '<i class="bi bi-box-arrow-up-right"></i> Open';
                actionsDiv.appendChild(aOpen);
            }
            const btnCopy = document.createElement('button');
            btnCopy.className = "btn btn-sm btn-outline-secondary py-0 px-2 copy-single-btn";
            btnCopy.style.fontSize = "0.75rem";
            btnCopy.setAttribute('data-url', item.url);
            btnCopy.innerHTML = '<i class="bi bi-clipboard"></i> Copy';
            actionsDiv.appendChild(btnCopy);
        }

        const copySingle = container.querySelector('.copy-single-btn');
        if (copySingle) {
            copySingle.onclick = () => {
                navigator.clipboard.writeText(copySingle.getAttribute('data-url')).then(() => {
                    copySingle.innerHTML = '<i class="bi bi-check2"></i> Copied';
                    setTimeout(() => copySingle.innerHTML = '<i class="bi bi-clipboard"></i> Copy', 1500);
                });
            };
        }

        const multiCopies = container.querySelectorAll('.copy-link-btn');
        multiCopies.forEach(btn => {
            btn.onclick = () => {
                navigator.clipboard.writeText(btn.getAttribute('data-url')).then(() => {
                    btn.innerHTML = '<i class="bi bi-check2"></i> Copied';
                    setTimeout(() => btn.innerHTML = '<i class="bi bi-clipboard"></i> Copy', 1500);
                });
            };
        });
    }

    function updateSummary() {
        const total = fileQueue.length;
        queueCount.textContent = total;

        if (total === 0) {
            emptyQueue.classList.remove('d-none');
            summaryDiv.classList.add('d-none');
            return;
        }

        emptyQueue.classList.add('d-none');
        summaryDiv.classList.remove('d-none');

        const completed = fileQueue.filter(i => i.status === 'success').length;
        const overall = Math.round((completed / total) * 100);

        summaryText.textContent = `${completed} of ${total} files uploaded`;
        summaryPercent.textContent = `${overall}%`;
        summaryProgress.style.width = `${overall}%`;
    }

    function updateUI() {
        const pendingCount = fileQueue.filter(i => i.status === 'pending' || i.status === 'paused').length;
        startUploadBtn.disabled = isUploading || pendingCount === 0;
        pauseAllBtn.disabled = !isUploading;
        cancelAllBtn.disabled = fileQueue.length === 0;
        clearQueueBtn.disabled = isUploading || fileQueue.length === 0;
        updateSummary();
    }

    // Queue processing
    startUploadBtn.addEventListener('click', async () => {
        if (isUploading) return;
        isQueuePaused = false;
        isUploading = true;
        updateUI();

        while (!isQueuePaused) {
            const nextItem = fileQueue.find(i => i.status === 'pending' || i.status === 'paused');
            if (!nextItem) break;
            currentActiveItem = nextItem;
            await uploadItem(nextItem);
            currentActiveItem = null;
            updateSummary();
        }

        isUploading = false;
        updateUI();
    });

    pauseAllBtn.addEventListener('click', () => {
        isQueuePaused = true;
        if (currentActiveItem && currentActiveItem.status === 'uploading') {
            pauseItem(currentActiveItem);
        }
        isUploading = false;
        updateUI();
    });

    cancelAllBtn.addEventListener('click', () => {
        isQueuePaused = true;
        if (currentActiveItem && currentActiveItem.status === 'uploading') {
            cancelItem(currentActiveItem);
        }
        fileQueue.forEach(item => {
            if (item.status === 'pending' || item.status === 'paused') {
                item.status = 'cancelled';
                updateItemUI(item);
            }
        });
        isUploading = false;
        updateUI();
    });

    clearQueueBtn.addEventListener('click', () => {
        if (isUploading) return;
        fileQueue.forEach(item => {
            if (typeof item.file?.dispose === 'function') {
                item.file.dispose();
            }
        });
        fileQueue = [];
        queueList.innerHTML = '';
        updateUI();
    });

    function pauseItem(item) {
        if (item.abortController) {
            try { item.abortController.abort(); } catch(e) {}
        }
        if (item.xhr) {
            try { item.xhr.abort(); } catch(e) {}
            item.xhr = null;
        }
        item.status = 'paused';
        isQueuePaused = true;
        updateItemUI(item);
        updateUI();

        try {
            chrome.runtime.sendMessage({
                cmd: 'UPDATE_UPLOAD_PROGRESS',
                parameter: {
                    id: item.id,
                    progress: item.progress,
                    speed: 'Paused',
                    state: 'paused'
                }
            });
        } catch(e) {}
    }

    function resumeItem(item) {
        item.status = 'pending';
        item.abortController = new AbortController();
        isQueuePaused = false;
        updateItemUI(item);
        updateUI();
        if (!isUploading) {
            startUploadBtn.click();
        }
    }

    function cancelItem(item) {
        if (item.abortController) {
            try { item.abortController.abort(); } catch(e) {}
        }
        if (item.xhr) {
            try { item.xhr.abort(); } catch(e) {}
            item.xhr = null;
        }
        item.status = 'cancelled';
        updateItemUI(item);

        try {
            chrome.runtime.sendMessage({
                cmd: 'UPLOAD_FINISHED',
                parameter: { id: item.id }
            });
        } catch(e) {}

        updateUI();
    }

    function clearItem(item) {
        if (item.status === 'uploading') {
            cancelItem(item);
        }
        if (typeof item.file?.dispose === 'function') {
            item.file.dispose();
        }
        if (item.el) {
            item.el.remove();
        }
        fileQueue = fileQueue.filter(i => i.id !== item.id);
        updateUI();
    }

    function retryItem(item) {
        item.status = 'pending';
        item.progress = 0;
        item.uploadedBytes = 0;
        item.speed = '';
        item.error = null;
        item.url = null;
        item.links = [];
        item.abortController = new AbortController();
        isQueuePaused = false;

        const resultContainer = item.el?.querySelector('.result-container');
        if (resultContainer) {
            resultContainer.innerHTML = '';
            resultContainer.classList.add('d-none');
        }

        updateItemUI(item);
        updateUI();

        if (!isUploading) {
            startUploadBtn.click();
        }
    }

    async function confirmPreFlightModal(fileName, sizeBytes, service) {
        if (typeof ServiceLimits === 'undefined') {
            return { proceed: true, service };
        }

        const report = ServiceLimits.check(sizeBytes, service, uploadConfig, false);
        if (!report.hasWarnings) {
            return { proceed: true, service };
        }

        const modalEl = document.getElementById('preFlightModal');
        if (!modalEl || typeof bootstrap === 'undefined' || !bootstrap.Modal) {
            return { proceed: true, service };
        }

        const fileNameEl = document.getElementById('preFlightFileName');
        const fileSizeEl = document.getElementById('preFlightFileSize');
        const warningsContainer = document.getElementById('preFlightWarningsContainer');
        const runnerNotice = document.getElementById('preFlightRunnerNotice');
        const safeContainer = document.getElementById('preFlightSafeContainer');
        const safeText = document.getElementById('preFlightSafeText');
        const skipBtn = document.getElementById('preFlightSkipBtn');
        const proceedBtn = document.getElementById('preFlightProceedBtn');
        const cancelBtn = document.getElementById('preFlightCancelBtn');

        if (fileNameEl) fileNameEl.textContent = fileName || 'File';
        if (fileSizeEl) fileSizeEl.textContent = report.formattedSize;

        if (warningsContainer) {
            warningsContainer.innerHTML = report.problematic.map(p => `
                <div class="alert alert-warning py-1.5 px-2.5 small mb-0 border-warning" style="font-size: 0.74rem; line-height: 1.35;">
                    <div class="d-flex align-items-center gap-1.5 fw-bold text-dark mb-0.5">
                        <i class="bi bi-exclamation-triangle-fill text-warning"></i>
                        <span>${p.name} (Limit: ${p.limitStr})</span>
                    </div>
                    <div class="text-muted">${p.reason}</div>
                </div>
            `).join('');
        }

        if (runnerNotice) {
            runnerNotice.classList.toggle('d-none', !report.runnerWarning);
        }

        if (safeContainer && safeText) {
            if (report.safe.length > 0 && report.problematic.length > 0) {
                safeContainer.classList.remove('d-none');
                safeText.textContent = `Compatible: ${report.safe.map(s => s.name).join(', ')} (fits within limits).`;
            } else {
                safeContainer.classList.add('d-none');
            }
        }

        if (skipBtn) {
            skipBtn.classList.toggle('d-none', !report.canSkipIncompatible);
        }

        const modal = bootstrap.Modal.getOrCreateInstance(modalEl);

        return new Promise((resolve) => {
            let resolved = false;

            const cleanup = () => {
                modalEl.removeEventListener('hidden.bs.modal', onHidden);
                if (proceedBtn) proceedBtn.removeEventListener('click', onProceed);
                if (skipBtn) skipBtn.removeEventListener('click', onSkip);
                if (cancelBtn) cancelBtn.removeEventListener('click', onCancel);
            };

            const onProceed = () => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    modal.hide();
                    resolve({ proceed: true, service });
                }
            };

            const onSkip = () => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    modal.hide();
                    const filtered = report.safe.map(s => s.service).join(',');
                    resolve({ proceed: true, service: filtered });
                }
            };

            const onCancel = () => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    modal.hide();
                    resolve({ proceed: false, service: null });
                }
            };

            const onHidden = () => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    resolve({ proceed: false, service: null });
                }
            };

            if (proceedBtn) proceedBtn.addEventListener('click', onProceed, { once: true });
            if (skipBtn) skipBtn.addEventListener('click', onSkip, { once: true });
            if (cancelBtn) cancelBtn.addEventListener('click', onCancel, { once: true });
            modalEl.addEventListener('hidden.bs.modal', onHidden, { once: true });

            modal.show();
        });
    }

    // Execute upload for single item
    async function uploadItem(item) {
        const targetService = item.service || uploadConfig.service || serviceSelect.value || 'all';
        const preFlight = await confirmPreFlightModal(item.name || item.file?.name, item.file?.size || item.size || 0, targetService);
        if (!preFlight.proceed || !preFlight.service) {
            item.status = 'cancelled';
            item.error = 'Cancelled by user';
            updateItemUI(item);
            return;
        }

        item.service = preFlight.service;
        item.status = 'uploading';
        item.abortController = new AbortController();
        updateItemUI(item);

        // Notify service worker
        try {
            chrome.runtime.sendMessage({
                cmd: 'REGISTER_UPLOAD',
                parameter: {
                    id: item.id,
                    name: item.name,
                    service: item.service,
                    size: item.size
                }
            });
        } catch(e) {}

        let lastTime = Date.now();
        let lastLoaded = 0;

        const resultContainer = item.el.querySelector('.result-container');

        const activeUploadConfig = {
            service: item.service,
            credentials: { ...(uploadConfig.credentials || {}) },
            signal: item.abortController.signal,
            _xhrCallback: (xhr) => {
                item.xhr = xhr;
            },
            onLinkGenerated: (linkObj) => {
                if (!item.links) item.links = [];
                if (!item.links.some(l => l.serviceId === linkObj.serviceId)) {
                    item.links.push(linkObj);
                }
                if (resultContainer) {
                    renderResultLinks(item, resultContainer);
                }
            }
        };

        if (item.telegramCaption) {
            activeUploadConfig.credentials.caption = item.telegramCaption;
            activeUploadConfig.credentials.telegram = {
                ...(activeUploadConfig.credentials.telegram || {}),
                caption: item.telegramCaption
            };
        }

        try {
            const result = await FetchStreamUploader.upload(item.file, item.name, activeUploadConfig, (loadedOrEvt, totalParam) => {
                let loaded = 0, total = item.size || 1;
                if (typeof loadedOrEvt === 'object' && loadedOrEvt !== null) {
                    loaded = loadedOrEvt.loaded || 0;
                    total = (loadedOrEvt.lengthComputable && loadedOrEvt.total > 0) ? loadedOrEvt.total : (item.size || 1);
                } else {
                    loaded = Number(loadedOrEvt) || 0;
                    total = Number(totalParam) > 0 ? Number(totalParam) : (item.size || 1);
                }

                const now = Date.now();
                const diffSec = (now - lastTime) / 1000;
                if (diffSec >= 0.4) {
                    const bytesDiff = loaded - lastLoaded;
                    const spd = bytesDiff / diffSec;
                    item.speed = `${formatBytes(spd)}/s`;
                    lastTime = now;
                    lastLoaded = loaded;
                }

                item.uploadedBytes = loaded;
                item.totalBytes = total;
                item.progress = Math.min(99, Math.round((loaded / total) * 100));

                updateItemUI(item);

                try {
                    chrome.runtime.sendMessage({
                        cmd: 'UPDATE_UPLOAD_PROGRESS',
                        parameter: {
                            id: item.id,
                            progress: item.progress,
                            speed: item.speed,
                            uploadedBytes: item.uploadedBytes,
                            totalBytes: item.totalBytes,
                            state: 'uploading'
                        }
                    });
                } catch(e) {}
            });

            // Extract URL and links properly
            let finalUrl = '';
            let multiLinks = item.links || [];
            if (typeof result === 'string') {
                finalUrl = result;
            } else if (result && typeof result === 'object') {
                finalUrl = result.url || '';
                if (Array.isArray(result.links) && result.links.length > 0) {
                    multiLinks = result.links;
                }
            }

            item.status = 'success';
            item.url = finalUrl;
            item.links = multiLinks;
            item.progress = 100;
            item.speed = '';
            item.xhr = null;
            updateItemUI(item);

            // Record to permanent history
            if (typeof HistoryManager !== 'undefined') {
                HistoryManager.addRecord({
                    type: 'upload',
                    name: item.name,
                    size: item.size,
                    service: item.service,
                    url: finalUrl,
                    links: multiLinks,
                    status: 'completed'
                });
            }

            try {
                chrome.runtime.sendMessage({
                    cmd: 'UPLOAD_FINISHED',
                    parameter: {
                        id: item.id,
                        url: finalUrl
                    }
                });
            } catch(e) {}

        } catch(err) {
            if (item.status === 'paused' || item.status === 'cancelled' || err.name === 'AbortError') return;
            item.status = 'error';
            item.error = err.message || 'Upload failed';
            item.xhr = null;
            updateItemUI(item);

            try {
                chrome.runtime.sendMessage({
                    cmd: 'UPLOAD_FINISHED',
                    parameter: {
                        id: item.id,
                        error: item.error
                    }
                });
            } catch(e) {}
        }
    }

    // Listen for cross-tab pause / cancel messages from popup
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.cmd === 'PAUSE_UPLOAD_REMOTE' && msg.parameter?.id) {
            const item = fileQueue.find(i => i.id === msg.parameter.id);
            if (item) pauseItem(item);
        }
        if (msg?.cmd === 'RESUME_UPLOAD_REMOTE' && msg.parameter?.id) {
            const item = fileQueue.find(i => i.id === msg.parameter.id);
            if (item) resumeItem(item);
        }
        if (msg?.cmd === 'CANCEL_UPLOAD_REMOTE' && msg.parameter?.id) {
            const item = fileQueue.find(i => i.id === msg.parameter.id);
            if (item) cancelItem(item);
        }
        if (msg?.cmd === 'PAUSE_ALL_UPLOADS_REMOTE') {
            pauseAllBtn.click();
        }
        if (msg?.cmd === 'CANCEL_ALL_UPLOADS_REMOTE') {
            cancelAllBtn.click();
        }
    });

    // forward internal HTML links to focus existing tab or open new tab without interrupting uploads
    document.querySelectorAll('a[href$=".html"]').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const href = link.getAttribute('href');
            if (href) {
                chrome.tabs.query({ url: chrome.runtime.getURL(href) }, (tabs) => {
                    if (tabs.length > 0) {
                        chrome.tabs.update(tabs[0].id, { active: true });
                    } else {
                        chrome.tabs.create({ url: targetUrl });
                    }
                });
            }
        });
    });

    // Warn before unloading if uploads are active or queued
    window.addEventListener('beforeunload', (e) => {
        const hasActive = isUploading || fileQueue.some(i => i.status === 'uploading' || i.status === 'queued');
        if (hasActive) {
            e.preventDefault();
            e.returnValue = 'Uploads are currently in progress or queued. Leaving will cancel them.';
            return e.returnValue;
        }
    });
});

window.addEventListener('beforeunload', () => { fileQueue.forEach(item => { if (typeof item.file?.dispose === 'function') { try { item.file.dispose(); } catch(e) {} } }); });
