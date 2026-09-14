// Attach Vault UI logic when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
    const $openVaultBtn = document.querySelector('[selector="openVaultBtn"]');
    if (!$openVaultBtn) return;
    
    const vaultOffcanvasEl = document.querySelector('[selector="vaultOffcanvas"]');
    const vaultOffcanvas = new bootstrap.Offcanvas(vaultOffcanvasEl);
    
    const $lockedState = document.querySelector('[selector="vaultLockedState"]');
    const $unlockedState = document.querySelector('[selector="vaultUnlockedState"]');
    
    const $passwordInput = document.querySelector('[selector="vaultPasswordInput"]');
    const $unlockBtn = document.querySelector('[selector="vaultUnlockBtn"]');
    const $webAuthnBtn = document.querySelector('[selector="vaultWebAuthnBtn"]');
    const $registerPasskeyBtn = document.querySelector('[selector="vaultRegisterPasskeyBtn"]');
    const $settingsLockVaultBtn = document.querySelector('[selector="settingsLockVaultBtn"]');
    const $setupNotice = document.querySelector('[selector="vaultSetupNotice"]');
    const $resetBtn = document.querySelector('[selector="vaultResetBtn"]');
    const $resetContainer = document.querySelector('[selector="vaultResetContainer"]');
    
    const $saveBtn = document.querySelector('[selector="vaultSaveBtn"]');
    const $lockBtn = document.querySelector('[selector="vaultLockBtn"]');
    const $inputs = document.querySelectorAll('.vault-input');
    
    let isSettingUp = false;

    async function refreshVaultState() {
        if ($passwordInput) $passwordInput.value = '';
        const isSetup = await Vault.isVaultSetup();
        
        if (!isSetup) {
            isSettingUp = true;
            if ($setupNotice) $setupNotice.classList.remove('d-none');
            if ($resetContainer) $resetContainer.classList.add('d-none');
            if ($unlockBtn) $unlockBtn.innerHTML = '<i class="bi bi-key-fill me-1"></i> Set Master Passphrase';
            if ($webAuthnBtn) $webAuthnBtn.classList.add('d-none');
        } else {
            isSettingUp = false;
            if ($setupNotice) $setupNotice.classList.add('d-none');
            if ($resetContainer) $resetContainer.classList.remove('d-none');
            if ($unlockBtn) $unlockBtn.innerHTML = '<i class="bi bi-key-fill me-1"></i> Unlock Vault';
            if ($webAuthnBtn) {
                $webAuthnBtn.classList.remove('d-none');
                $webAuthnBtn.innerHTML = '<i class="bi bi-shield-check me-1"></i> Unlock with Security Key / Passkey';
            }
        }
        
        const unlockedCreds = await Vault.getUnlockedCreds();
        
        const padlock = document.getElementById('mainVaultPadlock');
        if (padlock) {
            if (unlockedCreds) {
                padlock.innerHTML = '<i class="bi bi-unlock-fill text-success"></i>';
                padlock.title = "Vault Unlocked (Click to lock)";
            } else if (isSetup) {
                padlock.innerHTML = '<i class="bi bi-lock-fill text-danger"></i>';
                padlock.title = "Vault Locked (Click to unlock)";
            } else {
                padlock.innerHTML = '<i class="bi bi-shield-plus text-warning"></i>';
                padlock.title = "Vault Not Setup (Click to setup)";
            }
            
            padlock.onclick = async () => {
                if (unlockedCreds) {
                    await Vault.lock();
                    await refreshVaultState();
                } else {
                    vaultOffcanvas.show();
                }
            };
        }

        if (unlockedCreds) {
            $openVaultBtn.className = "btn btn-sm btn-outline-success flex-grow-1 fw-bold shadow-sm";
            $openVaultBtn.innerHTML = '<i class="bi bi-pencil-square me-1"></i> Edit Credentials';
            if ($settingsLockVaultBtn) $settingsLockVaultBtn.classList.remove('d-none');
        } else {
            $openVaultBtn.className = "btn btn-sm btn-outline-warning flex-grow-1 fw-bold shadow-sm";
            $openVaultBtn.innerHTML = isSetup ? '<i class="bi bi-lock-fill me-1"></i> Unlock Security Vault' : '<i class="bi bi-shield-plus me-1"></i> Setup Security Vault';
            if ($settingsLockVaultBtn) $settingsLockVaultBtn.classList.add('d-none');
        }

        if (unlockedCreds) {
            showUnlocked(unlockedCreds);
        } else {
            showLocked();
        }
        
        // Dispatch event for other modules
        document.dispatchEvent(new CustomEvent('vaultStateChanged', { 
            detail: { isSetup, isUnlocked: !!unlockedCreds } 
        }));
    }

    // Initial state setup on popup load
    refreshVaultState();

    if ($openVaultBtn) {
        $openVaultBtn.addEventListener("click", async () => {
            await refreshVaultState();
            vaultOffcanvas.show();
        });
    }
    
    function showLocked() {
        $lockedState.classList.remove('d-none');
        $unlockedState.classList.add('d-none');
    }
    
    function showUnlocked(creds) {
        $lockedState.classList.add('d-none');
        $unlockedState.classList.remove('d-none');
        
        // Populate inputs
        $inputs.forEach(input => {
            const key = input.getAttribute('data-vault-key');
            input.value = creds[key] || '';
        });
    }
    
    $unlockBtn.addEventListener("click", async () => {
        const pwd = $passwordInput.value;
        if (!pwd) return;
        
        $unlockBtn.disabled = true;
        try {
            if (isSettingUp) {
                await Vault.setup(pwd, {});
                await refreshVaultState();
                vaultOffcanvas.hide();
                setTimeout(async () => await CustomDialog.alert("Vault setup successful with Passphrase!"), 350);
            } else {
                await Vault.unlock(pwd);
                await refreshVaultState();
                vaultOffcanvas.hide();
            }
        } catch (e) {
            vaultOffcanvas.hide();
            setTimeout(async () => {
                await CustomDialog.alert(e.message);
                vaultOffcanvas.show();
                if ($passwordInput && !$lockedState.classList.contains('d-none')) {
                    $passwordInput.focus();
                }
            }, 350);
        } finally {
            $unlockBtn.disabled = false;
            $passwordInput.value = '';
        }
    });

    if ($webAuthnBtn) {
        $webAuthnBtn.addEventListener("click", async () => {
            $webAuthnBtn.disabled = true;
            try {
                await Vault.unlockWebAuthn();
                await refreshVaultState();
                vaultOffcanvas.hide();
            } catch (e) {
                vaultOffcanvas.hide();
                setTimeout(async () => {
                    await CustomDialog.alert(e.message);
                    vaultOffcanvas.show();
                    if ($passwordInput && !$lockedState.classList.contains('d-none')) {
                        $passwordInput.focus();
                    }
                }, 350);
            } finally {
                $webAuthnBtn.disabled = false;
            }
        });
    }
    
    if ($registerPasskeyBtn) {
        $registerPasskeyBtn.addEventListener("click", async () => {
            vaultOffcanvas.hide();
            setTimeout(async () => {
                const pwd = await CustomDialog.prompt("Enter your Master Passphrase to register a Passkey:", "Register Passkey", "info", "password");
                if (pwd) {
                    try {
                        await Vault.addPasskey(pwd);
                        await CustomDialog.alert("Passkey registered successfully! You can now use it to unlock the vault.", "Success", "success");
                    } catch (e) {
                        await CustomDialog.alert(e.message, "Error", "danger");
                    }
                }
                vaultOffcanvas.show();
            }, 350);
        });
    }
    
    vaultOffcanvasEl.addEventListener('shown.bs.offcanvas', () => {
        if ($passwordInput && !$lockedState.classList.contains('d-none')) {
            $passwordInput.focus();
        }
    });

    if ($passwordInput) {
        $passwordInput.addEventListener("keypress", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                $unlockBtn.click();
            }
        });
    }

    if ($resetBtn) {
        $resetBtn.addEventListener("click", async () => {
            vaultOffcanvas.hide();
            setTimeout(async () => {
                const proceed = await CustomDialog.confirm("WARNING: This will permanently delete all encrypted credentials stored in the Vault. You will need to set up a new master passphrase and re-enter all your API keys.\n\nProceed with Vault Reset?");
                if (proceed) {
                    await Vault.reset();
                    await CustomDialog.alert("Vault has been reset.");
                    // Re-trigger the initial UI state
                    $openVaultBtn.click();
                } else {
                    vaultOffcanvas.show();
                }
            }, 350);
        });
    }
    
    if ($saveBtn) {
        $saveBtn.classList.add('d-none'); // Hide the manual save button as it's now auto-saving
    }

    const autoSaveCreds = async () => {
        const creds = {};
        $inputs.forEach(input => {
            const key = input.getAttribute('data-vault-key');
            creds[key] = input.value.trim();
        });
        
        try {
            await Vault.updateCredsIfUnlocked(creds);
        } catch (e) {
            console.error("Auto-save failed:", e);
        }
    };

    $inputs.forEach(input => {
        input.addEventListener('change', autoSaveCreds);
        input.addEventListener('blur', autoSaveCreds);
    });
    
    if ($lockBtn) {
        $lockBtn.addEventListener("click", async () => {
            await Vault.lock();
            await refreshVaultState();
        });
    }

    if ($settingsLockVaultBtn) {
        $settingsLockVaultBtn.addEventListener("click", async () => {
            await Vault.lock();
            await refreshVaultState();
        });
    }
});
