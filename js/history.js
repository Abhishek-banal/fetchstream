/**
 * FetchStream Permanent History Page Controller
 * Manages permanent history viewing, filtering, searching, and entry management.
 */

document.addEventListener('DOMContentLoaded', async () => {
    const listEl = document.getElementById('historyList');
    const emptyEl = document.getElementById('emptyState');
    const searchInput = document.getElementById('searchInput');
    const clearAllBtn = document.getElementById('clearAllBtn');
    
    const filterAll = document.getElementById('filterAll');
    const filterDownloads = document.getElementById('filterDownloads');
    const filterUploads = document.getElementById('filterUploads');
    
    const countAll = document.getElementById('countAll');
    const countDownloads = document.getElementById('countDownloads');
    const countUploads = document.getElementById('countUploads');

    let currentFilter = 'all';
    let searchQuery = '';
    let allRecords = [];

    async function loadHistory() {
        allRecords = await HistoryManager.getHistory();
        render();
    }

    function formatBytes(bytes, decimals = 2) {
        if (!+bytes) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
    }

    function formatDate(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        return d.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        }) + ' ' + d.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function render() {
        const total = allRecords.length;
        const dlCount = allRecords.filter(r => r.type === 'download').length;
        const ulCount = allRecords.filter(r => r.type === 'upload').length;

        countAll.textContent = total;
        countDownloads.textContent = dlCount;
        countUploads.textContent = ulCount;

        const filtered = allRecords.filter(r => {
            if (currentFilter !== 'all' && r.type !== currentFilter) return false;
            if (searchQuery) {
                const q = searchQuery.toLowerCase();
                const name = (r.name || '').toLowerCase();
                const service = (r.service || '').toLowerCase();
                const url = (r.url || '').toLowerCase();
                return name.includes(q) || service.includes(q) || url.includes(q);
            }
            return true;
        });

        listEl.innerHTML = '';

        if (filtered.length === 0) {
            emptyEl.classList.remove('d-none');
            return;
        }

        emptyEl.classList.add('d-none');

        for (const item of filtered) {
            const card = document.createElement('div');
            card.className = 'history-card';
            card.id = item.id;

            const isUpload = item.type === 'upload';
            const typeBadge = isUpload
                ? '<span class="badge badge-upload"><i class="bi bi-cloud-arrow-up-fill me-1"></i>UPLOAD</span>'
                : '<span class="badge badge-download"><i class="bi bi-cloud-arrow-down-fill me-1"></i>DOWNLOAD</span>';

            const isLink = item.url && item.url.startsWith('http');
            const hasMultiLinks = item.links && Array.isArray(item.links) && item.links.length > 0;

            let hasLinks = false;
            if (hasMultiLinks || item.url) {
                hasLinks = true;
            }

            card.innerHTML = `
                <div class="d-flex justify-content-between align-items-start gap-2 mb-1">
                    <div class="d-flex align-items-center gap-2 overflow-hidden">
                        ${typeBadge}
                        <h6 class="mb-0 fw-bold text-dark text-truncate hist-item-name"></h6>
                    </div>
                    <div class="d-flex align-items-center gap-2 flex-shrink-0">
                        <span class="badge bg-light text-secondary border font-monospace hist-item-service" style="font-size: 0.7rem;"></span>
                        <button class="btn btn-sm btn-outline-danger p-0 px-1 border-0 delete-item-btn" title="Delete from history" data-id="${item.id}">
                            <i class="bi bi-trash"></i>
                        </button>
                    </div>
                </div>
                <div class="d-flex align-items-center gap-3 text-muted small" style="font-size: 0.75rem;">
                    <span><i class="bi bi-hdd me-1"></i>${formatBytes(item.size)}</span>
                    <span>•</span>
                    <span><i class="bi bi-calendar3 me-1"></i>${formatDate(item.timestamp)}</span>
                    ${item.status === 'error' ? '<span class="text-danger fw-bold">• Failed</span>' : '<span class="text-success fw-bold">• Completed</span>'}
                </div>
                <div class="hist-links-container"></div>
            `;
            
            card.querySelector('.hist-item-name').textContent = item.name || 'File';
            card.querySelector('.hist-item-name').title = item.name || '';
            card.querySelector('.hist-item-service').textContent = item.service || 'local';
            
            const linksContainer = card.querySelector('.hist-links-container');
            if (hasMultiLinks) {
                const linksDiv = document.createElement('div');
                linksDiv.className = "mt-2 pt-2 border-top";
                linksDiv.innerHTML = `<span class="small fw-semibold text-muted d-block mb-1">Generated Links (${item.links.length} Services):</span><div class="d-flex flex-column gap-1 hist-multi-links"></div>`;
                const multiLinksDiv = linksDiv.querySelector('.hist-multi-links');
                item.links.forEach(l => {
                    const row = document.createElement('div');
                    row.className = "multi-link-item d-flex justify-content-between align-items-center gap-2";
                    row.innerHTML = `
                        <div class="overflow-hidden text-truncate">
                            <strong class="text-dark srv-name"></strong>:
                            <a target="_blank" class="text-decoration-none text-primary ms-1 srv-link"></a>
                        </div>
                        <button class="btn btn-xs btn-outline-secondary copy-link-btn flex-shrink-0" style="font-size: 0.72rem; padding: 2px 6px;">
                            <i class="bi bi-clipboard"></i> Copy
                        </button>
                    `;
                    row.querySelector('.srv-name').textContent = l.service;
                    const aEl = row.querySelector('.srv-link');
                    aEl.href = l.url;
                    aEl.textContent = l.url;
                    aEl.title = l.url;
                    const btnEl = row.querySelector('.copy-link-btn');
                    btnEl.setAttribute('data-url', l.url);
                    multiLinksDiv.appendChild(row);
                });
                linksContainer.appendChild(linksDiv);
            } else if (item.url) {
                const row = document.createElement('div');
                row.className = "mt-2 pt-2 border-top d-flex justify-content-between align-items-center gap-2";
                row.innerHTML = `
                    <span class="text-truncate small text-muted font-monospace srv-single-url" style="font-size: 0.78rem;"></span>
                    <div class="d-flex gap-1 flex-shrink-0 single-actions"></div>
                `;
                const spanUrl = row.querySelector('.srv-single-url');
                spanUrl.textContent = item.url;
                spanUrl.title = item.url;
                const actionsDiv = row.querySelector('.single-actions');
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
                linksContainer.appendChild(row);
            }

            // Setup buttons
            const delBtn = card.querySelector('.delete-item-btn');
            delBtn.onclick = async () => {
                await HistoryManager.deleteRecord(item.id);
                allRecords = allRecords.filter(r => r.id !== item.id);
                render();
            };

            const copySingle = card.querySelector('.copy-single-btn');
            if (copySingle) {
                copySingle.onclick = () => {
                    navigator.clipboard.writeText(copySingle.getAttribute('data-url')).then(() => {
                        copySingle.innerHTML = '<i class="bi bi-check2"></i> Copied';
                        setTimeout(() => copySingle.innerHTML = '<i class="bi bi-clipboard"></i> Copy', 1500);
                    });
                };
            }

            const multiCopies = card.querySelectorAll('.copy-link-btn');
            multiCopies.forEach(btn => {
                btn.onclick = () => {
                    navigator.clipboard.writeText(btn.getAttribute('data-url')).then(() => {
                        btn.innerHTML = '<i class="bi bi-check2"></i> Copied';
                        setTimeout(() => btn.innerHTML = '<i class="bi bi-clipboard"></i> Copy', 1500);
                    });
                };
            });

            listEl.appendChild(card);
        }
    }

    // Filter clicks (re-loads from storage to ensure latest data when switching options)
    filterAll.onclick = async () => {
        currentFilter = 'all';
        [filterAll, filterDownloads, filterUploads].forEach(b => b.classList.remove('active'));
        filterAll.classList.add('active');
        await loadHistory();
    };
    filterDownloads.onclick = async () => {
        currentFilter = 'download';
        [filterAll, filterDownloads, filterUploads].forEach(b => b.classList.remove('active'));
        filterDownloads.classList.add('active');
        await loadHistory();
    };
    filterUploads.onclick = async () => {
        currentFilter = 'upload';
        [filterAll, filterDownloads, filterUploads].forEach(b => b.classList.remove('active'));
        filterUploads.classList.add('active');
        await loadHistory();
    };

    // Search
    searchInput.oninput = () => {
        searchQuery = searchInput.value.trim();
        render();
    };

    // Clear All
    clearAllBtn.onclick = async () => {
        if (allRecords.length === 0) return;
        if (await CustomDialog.confirm("Are you sure you want to clear all history? This cannot be undone.")) {
            await HistoryManager.clearAll();
            allRecords = [];
            render();
        }
    };

    // forward internal HTML links to focus existing tab or open safely
    document.querySelectorAll('a[href$=".html"]').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const href = link.getAttribute('href');
            if (href) {
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

    // Auto-refresh history when tab is clicked, refocused, or switched to
    window.addEventListener('focus', () => loadHistory());
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) loadHistory();
    });
    document.addEventListener('click', (e) => {
        // Light refresh if clicked within navbar or header
        if (e.target.closest('.manager-header') || e.target.closest('#headerNav')) {
            loadHistory();
        }
    });

    // Live update when history storage changes or messages arrive
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.fetchstream_permanent_history) {
            loadHistory();
        }
    });
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.cmd === 'HISTORY_UPDATED' || msg?.cmd === 'RECORD_HISTORY') {
            loadHistory();
        }
    });

    // Initial load
    await loadHistory();
});
