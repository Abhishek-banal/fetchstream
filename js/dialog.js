class CustomDialog {
    static init() {
        if (document.getElementById('customDialogModal')) return;

        const html = `
        <div class="modal fade" id="customDialogModal" tabindex="-1" style="z-index: 1060;" aria-hidden="true">
            <div class="modal-dialog modal-dialog-centered modal-sm">
                <div class="modal-content border-0 shadow">
                    <div class="modal-header py-2 px-3 border-bottom-0">
                        <h6 class="modal-title fs-6 fw-bold" id="customDialogTitle">Notice</h6>
                        <button type="button" class="btn-close btn-close-sm" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body p-3 pt-0">
                        <p id="customDialogMessage" class="mb-0 small" style="white-space: pre-wrap;"></p>
                        <input type="password" id="customDialogInput" class="form-control form-control-sm mt-2 d-none" autocomplete="off" spellcheck="false" placeholder="Enter password">
                    </div>
                    <div class="modal-footer py-1.5 px-3 border-top-0 d-flex justify-content-end gap-2">
                        <button type="button" class="btn btn-sm btn-outline-secondary d-none" id="customDialogCancelBtn">Cancel</button>
                        <button type="button" class="btn btn-sm btn-primary" id="customDialogOkBtn">OK</button>
                    </div>
                </div>
            </div>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', html);
    }

    static queue = [];
    static isShowing = false;

    static show(params) {
        return new Promise((resolve) => {
            this.queue.push({ params, resolve });
            this._processQueue();
        });
    }

    static _processQueue() {
        if (this.isShowing || this.queue.length === 0) return;
        this.isShowing = true;

        const { params, resolve } = this.queue.shift();
        const { title = 'Notice', message, isConfirm = false, isPrompt = false, promptType = 'password', okText = 'OK', cancelText = 'Cancel', type = 'info' } = params;
        
        this.init();
        const modalEl = document.getElementById('customDialogModal');
        const titleEl = document.getElementById('customDialogTitle');
        const msgEl = document.getElementById('customDialogMessage');
        const inputEl = document.getElementById('customDialogInput');
        const okBtn = document.getElementById('customDialogOkBtn');
        const cancelBtn = document.getElementById('customDialogCancelBtn');

        titleEl.textContent = title;
        msgEl.textContent = message;
        okBtn.textContent = okText;
        
        if (isPrompt) {
            inputEl.type = promptType;
            inputEl.value = '';
            inputEl.classList.remove('d-none');
        } else {
            inputEl.classList.add('d-none');
        }

        if (type === 'danger' || type === 'warning') {
            okBtn.className = 'btn btn-sm btn-danger';
            titleEl.className = 'modal-title fs-6 fw-bold text-danger';
        } else {
            okBtn.className = 'btn btn-sm btn-primary';
            titleEl.className = 'modal-title fs-6 fw-bold text-dark';
        }

        if (isConfirm || isPrompt) {
            cancelBtn.textContent = cancelText;
            cancelBtn.classList.remove('d-none');
        } else {
            cancelBtn.classList.add('d-none');
        }

        let finalResult = null;
        let didResolve = false;

        const onGlobalKeyDown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                onOk();
            }
        };

        const cleanup = () => {
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            document.removeEventListener('keydown', onGlobalKeyDown);
            modalEl.removeEventListener('hidden.bs.modal', onHidden);
        };

        const modal = bootstrap.Modal.getOrCreateInstance(modalEl);

        const onOk = () => {
            if (didResolve) return;
            didResolve = true;
            finalResult = isPrompt ? inputEl.value : true;
            document.removeEventListener('keydown', onGlobalKeyDown); // Remove immediately to prevent double fires
            modal.hide();
        };

        const onCancel = () => {
            if (didResolve) return;
            didResolve = true;
            finalResult = isPrompt ? null : false;
            document.removeEventListener('keydown', onGlobalKeyDown);
            modal.hide();
        };
        
        const onHidden = () => {
            if (!didResolve) {
                finalResult = isPrompt ? null : false;
            }
            cleanup();
            this.isShowing = false;
            setTimeout(() => this._processQueue(), 150);
            resolve(finalResult);
        };

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        document.addEventListener('keydown', onGlobalKeyDown);
        modalEl.addEventListener('hidden.bs.modal', onHidden);

        modal.show();
        if (isPrompt) {
            setTimeout(() => inputEl.focus(), 500);
        }
    }

    static alert(message, title = 'Notice', type = 'info') {
        return this.show({ title, message, isConfirm: false, type });
    }

    static confirm(message, title = 'Confirm', type = 'warning', okText = 'OK') {
        return this.show({ title, message, isConfirm: true, type, okText });
    }
    
    static prompt(message, title = 'Input Required', type = 'info', promptType = 'password') {
        return this.show({ title, message, isPrompt: true, promptType, type });
    }
}

if (typeof window !== 'undefined') {
    window.CustomDialog = CustomDialog;
}
