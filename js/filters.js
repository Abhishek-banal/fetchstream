/**
 * FetchStream Filter Configuration Controller
 * Manages the rendering, hierarchical state mapping, and persistence
 * of granular media scanning filters.
 */

document.addEventListener('DOMContentLoaded', async () => {
    const $filtersContainer = document.getElementById('filtersContainer');
    const $saveBtn = document.getElementById('saveFiltersBtn');
    const $resetBtn = document.getElementById('resetFiltersBtn');
    
    let currentFilters = null;

    // Structural schema for UI generation
    const filterSchema = [
        {
            categoryId: 'videos',
            title: 'Video Streams & Files',
            icon: 'bi-camera-video',
            subCategories: [
                {
                    subId: 'video',
                    title: 'Video Formats',
                    formats: ['m3u8', 'm3u', 'mp4', 'webm', 'mkv', 'flv', 'mov', 'avi', 'wmv', 'ts']
                }
            ]
        },
        {
            categoryId: 'audio',
            title: 'Audio Streams & Files',
            icon: 'bi-music-note-beamed',
            subCategories: [
                {
                    subId: 'audio',
                    title: 'Audio Formats',
                    formats: ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'flac', 'wma', 'opus']
                }
            ]
        },
        {
            categoryId: 'files',
            title: 'Documents, Archives & Other Files',
            icon: 'bi-folder',
            subCategories: [
                { subId: 'images', title: 'Images', formats: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'ico', 'tiff', 'avif'] },
                { subId: 'pdf', title: 'PDF Documents', formats: ['pdf'] },
                { subId: 'docs', title: 'Text & Word Documents', formats: ['doc', 'docx', 'txt', 'rtf', 'odt', 'epub', 'pages'] },
                { subId: 'sheets', title: 'Spreadsheets', formats: ['xls', 'xlsx', 'csv', 'ods', 'numbers'] },
                { subId: 'slides', title: 'Presentations', formats: ['ppt', 'pptx', 'odp', 'key'] },
                { subId: 'archives', title: 'Archives & Compressed', formats: ['zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz'] },
                { subId: 'disks', title: 'Disk Images', formats: ['iso', 'img', 'bin', 'dmg'] }
            ]
        }
    ];

    /**
     * Retrieves stored options and initializes the local state.
     */
    async function loadSettings() {
        const res = await new Promise(resolve => chrome.storage.local.get(['options'], resolve));
        const storedOptions = res.options || OPTION;
        
        // Ensure the schema exists
        if (!storedOptions.scanFilters || !storedOptions.scanFilters.formats) {
            currentFilters = JSON.parse(JSON.stringify(OPTION.scanFilters));
        } else {
            currentFilters = JSON.parse(JSON.stringify(storedOptions.scanFilters));
        }
        
        renderUI();
    }

    /**
     * Evaluates child nodes to determine the intermediate/checked state of parent nodes.
     */
    function syncHierarchyState() {
        filterSchema.forEach(category => {
            let catCheckedCount = 0;
            let catTotalCount = 0;

            category.subCategories.forEach(subCat => {
                let subCheckedCount = 0;
                const subTotalCount = subCat.formats.length;

                subCat.formats.forEach(format => {
                    if (currentFilters.formats[format] !== false) {
                        subCheckedCount++;
                    }
                    catTotalCount++;
                });

                // Update sub-category state
                currentFilters.subCategories[subCat.subId] = (subCheckedCount > 0);
                catCheckedCount += subCheckedCount;

                // Sync DOM elements if they exist
                const subCb = document.getElementById(`sub_${subCat.subId}`);
                if (subCb) {
                    subCb.checked = (subCheckedCount > 0);
                    subCb.indeterminate = (subCheckedCount > 0 && subCheckedCount < subTotalCount);
                }
            });

            // Update top-level category state
            currentFilters.categories[category.categoryId] = (catCheckedCount > 0);

            // Sync DOM elements
            const catCb = document.getElementById(`cat_${category.categoryId}`);
            if (catCb) {
                catCb.checked = (catCheckedCount > 0);
                catCb.indeterminate = (catCheckedCount > 0 && catCheckedCount < catTotalCount);
            }
        });
    }

    /**
     * Constructs the filtering DOM based on the schema and current state.
     */
    function renderUI() {
        $filtersContainer.innerHTML = '';

        filterSchema.forEach(category => {
            const card = document.createElement('div');
            card.className = 'filter-card';

            // Top-Level Category Header
            const header = document.createElement('div');
            header.className = 'category-toggle-container d-flex align-items-center gap-3';
            
            const catCheckbox = document.createElement('input');
            catCheckbox.type = 'checkbox';
            catCheckbox.className = 'form-check-input mt-0';
            catCheckbox.id = `cat_${category.categoryId}`;
            catCheckbox.style.width = '1.2em';
            catCheckbox.style.height = '1.2em';
            
            const catLabel = document.createElement('label');
            catLabel.className = 'category-toggle flex-grow-1';
            catLabel.setAttribute('for', catCheckbox.id);
            catLabel.innerHTML = `<i class="bi ${category.icon} me-2 text-primary"></i>${category.title}`;

            header.appendChild(catCheckbox);
            header.appendChild(catLabel);
            card.appendChild(header);

            // Event: Toggle entire category
            catCheckbox.addEventListener('change', (e) => {
                const isChecked = e.target.checked;
                category.subCategories.forEach(subCat => {
                    currentFilters.subCategories[subCat.subId] = isChecked;
                    subCat.formats.forEach(fmt => {
                        currentFilters.formats[fmt] = isChecked;
                        const fmtCb = document.getElementById(`fmt_${fmt}`);
                        if (fmtCb) fmtCb.checked = isChecked;
                    });
                });
                syncHierarchyState();
            });

            // Render Sub-Categories
            category.subCategories.forEach(subCat => {
                const subSection = document.createElement('div');
                subSection.className = 'mb-4 ps-3 border-start border-2 border-light';

                const subHeader = document.createElement('div');
                subHeader.className = 'd-flex align-items-center gap-2 mb-3';
                
                const subCheckbox = document.createElement('input');
                subCheckbox.type = 'checkbox';
                subCheckbox.className = 'form-check-input mt-0';
                subCheckbox.id = `sub_${subCat.subId}`;
                
                const subLabel = document.createElement('label');
                subLabel.className = 'fw-bold text-dark mb-0 form-check-label';
                subLabel.setAttribute('for', subCheckbox.id);
                subLabel.textContent = subCat.title;
                subLabel.style.fontSize = '0.95rem';

                subHeader.appendChild(subCheckbox);
                subHeader.appendChild(subLabel);
                subSection.appendChild(subHeader);

                // Event: Toggle sub-category
                subCheckbox.addEventListener('change', (e) => {
                    const isChecked = e.target.checked;
                    subCat.formats.forEach(fmt => {
                        currentFilters.formats[fmt] = isChecked;
                        const fmtCb = document.getElementById(`fmt_${fmt}`);
                        if (fmtCb) fmtCb.checked = isChecked;
                    });
                    syncHierarchyState();
                });

                // Render Formats Grid
                const grid = document.createElement('div');
                grid.className = 'extension-grid ms-4';

                subCat.formats.forEach(format => {
                    const wrapper = document.createElement('div');
                    wrapper.className = 'form-check mb-2';

                    const fmtCheckbox = document.createElement('input');
                    fmtCheckbox.type = 'checkbox';
                    fmtCheckbox.className = 'form-check-input';
                    fmtCheckbox.id = `fmt_${format}`;
                    fmtCheckbox.checked = currentFilters.formats[format] !== false;

                    const fmtLabel = document.createElement('label');
                    fmtLabel.className = 'form-check-label';
                    fmtLabel.setAttribute('for', fmtCheckbox.id);
                    fmtLabel.textContent = `.${format}`;

                    // Event: Toggle individual format
                    fmtCheckbox.addEventListener('change', (e) => {
                        currentFilters.formats[format] = e.target.checked;
                        syncHierarchyState();
                    });

                    wrapper.appendChild(fmtCheckbox);
                    wrapper.appendChild(fmtLabel);
                    grid.appendChild(wrapper);
                });

                subSection.appendChild(grid);
                card.appendChild(subSection);
            });

            $filtersContainer.appendChild(card);
        });

        // Initialize state markers
        syncHierarchyState();
    }

    /**
     * Persist current state to extension storage.
     */
    async function saveSettings() {
        const res = await new Promise(resolve => chrome.storage.local.get(['options'], resolve));
        const storedOptions = res.options || OPTION;
        
        storedOptions.scanFilters = currentFilters;
        if (storedOptions.upload && storedOptions.upload.credentials) {
            delete storedOptions.upload.credentials;
        }

        await new Promise(resolve => chrome.storage.local.set({ options: storedOptions }, resolve));

        // Signal background scripts to re-evaluate active config
        chrome.runtime.sendMessage({ cmd: "RESET_OPTIONS" });

        // Show Toast Notification
        const toastEl = document.getElementById('saveToast');
        if (toastEl && window.bootstrap) {
            const toast = new bootstrap.Toast(toastEl);
            toast.show();
        }
    }

    $saveBtn.addEventListener('click', saveSettings);

    $resetBtn.addEventListener('click', async () => {
        if (await CustomDialog.confirm("Reset all filters to default settings?")) {
            currentFilters = JSON.parse(JSON.stringify(OPTION.scanFilters));
            renderUI();
            saveSettings();
        }
    });

    // Initialize
    await loadSettings();
});
