/**
 * FetchStream Permanent History Manager
 * Keeps track of all downloads and uploads forever until explicitly cleared.
 */

const HistoryManager = {
    STORAGE_KEY: 'fetchstream_permanent_history',
    _writeQueue: Promise.resolve(),

    async getHistory() {
        return new Promise((resolve) => {
            chrome.storage.local.get([this.STORAGE_KEY], (res) => {
                const rawList = Array.isArray(res?.[this.STORAGE_KEY]) ? res[this.STORAGE_KEY] : [];
                resolve(rawList.filter(item => item && (item.name || item.url || (item.links && item.links.length))));
            });
        });
    },

    addRecord(item) {
        this._writeQueue = this._writeQueue.then(() => this._executeAddRecord(item)).catch(err => {
            console.warn("Failed to add history record:", err);
        });
        return this._writeQueue;
    },

    async _executeAddRecord(item) {
        if (!item || !item.name) return null;
        const list = await this.getHistory();
        const now = Date.now();
        const url = typeof item.url === 'string' ? item.url : (item.url?.url || item.resultUrl || '');
        const links = Array.isArray(item.links) ? item.links : (url ? [{ service: item.service || 'Link', url }] : []);
        const hasLinks = Boolean(url.trim()) || links.length > 0;
        const targetJobId = item.jobId || item.id || null;

        const duplicateIdx = list.findIndex(r => {
            if (targetJobId && (r.id === targetJobId || r.jobId === targetJobId)) {
                return true;
            }
            if (url && r.url === url && r.type === (item.type || 'upload') && Math.abs(now - (r.timestamp || 0)) < 25000) {
                return true;
            }
            return false;
        });

        if (duplicateIdx !== -1) {
            const existing = list[duplicateIdx];
            const mergedLinks = Array.isArray(existing.links) ? [...existing.links] : [];
            for (const lnk of links) {
                if (lnk && lnk.url && !mergedLinks.some(m => m.url === lnk.url)) {
                    mergedLinks.push(lnk);
                }
            }
            existing.links = mergedLinks;
            if (url && !existing.url) existing.url = url;
            if (item.size && (!existing.size || existing.size === 0)) existing.size = item.size;
            if (item.status) existing.status = item.status;
            if (targetJobId && !existing.jobId) existing.jobId = targetJobId;

            if (mergedLinks.length > 1) {
                const svcNames = Array.from(new Set(mergedLinks.map(l => l.service || 'Mirror'))).join(', ');
                existing.service = `Multi-Host (${svcNames})`;
            }

            await new Promise(resolve => chrome.storage.local.set({ [this.STORAGE_KEY]: list }, resolve));
            return existing;
        }

        const record = {
            id: targetJobId || ('hist_' + now + '_' + Math.random().toString(36).substr(2, 5)),
            jobId: targetJobId,
            timestamp: now,
            type: item.type || 'upload',
            name: item.name || 'Unknown File',
            size: item.size || 0,
            service: item.service || 'local',
            url: url,
            links: links,
            status: item.status || 'completed',
            details: item.details || ''
        };
        list.unshift(record);
        await new Promise(resolve => chrome.storage.local.set({ [this.STORAGE_KEY]: list }, resolve));
        return record;
    },

    async deleteRecord(id) {
        const list = await this.getHistory();
        const updated = list.filter(r => r.id !== id);
        return new Promise((resolve) => {
            chrome.storage.local.set({ [this.STORAGE_KEY]: updated }, resolve);
        });
    },

    async clearAll() {
        return new Promise((resolve) => {
            chrome.storage.local.set({ [this.STORAGE_KEY]: [] }, resolve);
        });
    }
};

if (typeof window !== 'undefined') {
    window.HistoryManager = HistoryManager;
}
