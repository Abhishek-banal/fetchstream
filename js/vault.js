/**
 * FetchStream Security Vault
 * Implements WebAuthn PRF and PBKDF2-HMAC-SHA256 fallback
 * for AES-256-GCM credential encryption.
 */

class Vault {
    static async deriveKeyFromPassword(password, salt) {
        const enc = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey(
            "raw",
            enc.encode(password),
            { name: "PBKDF2" },
            false,
            ["deriveKey"]
        );
        
        return await crypto.subtle.deriveKey(
            {
                name: "PBKDF2",
                salt: salt,
                iterations: 600000,
                hash: "SHA-256"
            },
            keyMaterial,
            { name: "AES-GCM", length: 256 },
            true, // extractable
            ["encrypt", "decrypt"]
        );
    }

    static async encrypt(plainTextObject, key) {
        const enc = new TextEncoder();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encodedData = enc.encode(JSON.stringify(plainTextObject));
        
        const ciphertext = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: iv },
            key,
            encodedData
        );
        
        return {
            ciphertext: Array.from(new Uint8Array(ciphertext)),
            iv: Array.from(iv)
        };
    }

    static async decrypt(ciphertextArray, ivArray, key) {
        const dec = new TextDecoder();
        try {
            const decrypted = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: new Uint8Array(ivArray) },
                key,
                new Uint8Array(ciphertextArray)
            );
            return JSON.parse(dec.decode(decrypted));
        } catch (e) {
            throw new Error("Invalid password/biometric or corrupted vault.");
        }
    }

    // WebAuthn PRF (Biometric / your OS)
    static async registerWebAuthn() {
        if (!window.PublicKeyCredential) {
            throw new Error("WebAuthn is not supported in this browser.");
        }
        
        const challenge = crypto.getRandomValues(new Uint8Array(32));
        const userId = crypto.getRandomValues(new Uint8Array(16));
        
        const createCredentialOptions = {
            publicKey: {
                challenge: challenge,
                rp: { name: "FetchStream Vault" },
                user: {
                    id: userId,
                    name: "user@fetchstream",
                    displayName: "FetchStream User"
                },
                pubKeyCredParams: [
                    { type: "public-key", alg: -7 },
                    { type: "public-key", alg: -257 }
                ],
                authenticatorSelection: {
                    userVerification: "required"
                },
                timeout: 60000,
                extensions: {
                    prf: {
                        eval: {
                            first: crypto.getRandomValues(new Uint8Array(32)) // salt for PRF
                        }
                    }
                }
            }
        };

        let credential;
        try {
            credential = await navigator.credentials.create(createCredentialOptions);
        } catch (e) {
            console.error(e);
            throw new Error("Security Key / Passkey setup was blocked by your OS for this extension.\n\nReason: Chromium extensions (chrome-extension://) are often denied access to hardware authenticators by your OS due to missing domain bindings.\n\nPlease use the Master Passphrase method instead.");
        }
        
        const prfResults = credential.getClientExtensionResults().prf;
        
        if (!prfResults || !prfResults.enabled) {
            throw new Error("Your authenticator does not support the PRF extension required for encryption.");
        }
        
        // Store credential ID and salt for future use
        const credId = Array.from(new Uint8Array(credential.rawId));
        const prfSalt = Array.from(createCredentialOptions.publicKey.extensions.prf.eval.first);
        
        await chrome.storage.local.set({ 
            fs_webauthn_id: credId,
            fs_webauthn_salt: prfSalt
        });
        
        // Return the PRF derived bytes to use as AES key material
        const prfKeyMaterial = prfResults.results.first;
        return prfKeyMaterial;
    }

    static async authenticateWebAuthn() {
        const { fs_webauthn_id, fs_webauthn_salt } = await chrome.storage.local.get(['fs_webauthn_id', 'fs_webauthn_salt']);
        if (!fs_webauthn_id) {
            throw new Error("Biometric vault not set up. Please use passphrase.");
        }

        const challenge = crypto.getRandomValues(new Uint8Array(32));
        const getCredentialOptions = {
            publicKey: {
                challenge: challenge,
                allowCredentials: [{
                    id: new Uint8Array(fs_webauthn_id),
                    type: "public-key"
                }],
                userVerification: "required",
                extensions: {
                    prf: {
                        eval: {
                            first: new Uint8Array(fs_webauthn_salt)
                        }
                    }
                }
            }
        };

        let assertion;
        try {
            assertion = await navigator.credentials.get(getCredentialOptions);
        } catch (e) {
            console.error(e);
            throw new Error("Security Key / Passkey unlock was blocked by your OS for this extension.\n\nReason: Chromium extensions (chrome-extension://) are often denied access to hardware authenticators by your OS.\n\nPlease reset your vault or use the Passphrase method if available.");
        }
        
        const prfResults = assertion.getClientExtensionResults().prf;
        
        if (!prfResults || !prfResults.results) {
            throw new Error("Biometric authentication failed to retrieve PRF key.");
        }
        
        return prfResults.results.first;
    }

    static async deriveKeyFromPrf(prfBytes, vaultSalt) {
        // prfBytes is already a high-entropy key, but we mix it with vaultSalt for consistency
        const keyMaterial = await crypto.subtle.importKey(
            "raw",
            new Uint8Array(prfBytes),
            { name: "PBKDF2" },
            false,
            ["deriveKey"]
        );
        
        return await crypto.subtle.deriveKey(
            {
                name: "PBKDF2",
                salt: vaultSalt,
                iterations: 100000,
                hash: "SHA-256"
            },
            keyMaterial,
            { name: "AES-GCM", length: 256 },
            true,
            ["encrypt", "decrypt"]
        );
    }

    static async setup(password, credentialsToStore = {}) {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const key = await this.deriveKeyFromPassword(password, salt);
        
        const payload = {
            validation: "FETCHSTREAM_VAULT_OK",
            creds: credentialsToStore
        };
        
        const encrypted = await this.encrypt(payload, key);
        
        await chrome.storage.local.set({
            fs_vault: {
                salt: Array.from(salt),
                iv: encrypted.iv,
                ciphertext: encrypted.ciphertext,
                useWebAuthn: false // Default to password
            }
        });
        
        const exportedKey = await crypto.subtle.exportKey("jwk", key);
        await chrome.storage.session.set({ 
            fs_vault_unlocked: credentialsToStore,
            fs_vault_key: exportedKey 
        });
        chrome.action.setBadgeText({ text: '' });
    }

    static async addPasskey(password) {
        const { fs_vault } = await chrome.storage.local.get('fs_vault');
        if (!fs_vault) throw new Error("Vault not set up.");
        
        // Verify password
        const vaultSalt = new Uint8Array(fs_vault.salt);
        const testKey = await this.deriveKeyFromPassword(password, vaultSalt);
        try {
            await this.decrypt(fs_vault.ciphertext, fs_vault.iv, testKey);
        } catch(e) {
            throw new Error("Incorrect Master Passphrase.");
        }
        
        const prfBytes = await this.registerWebAuthn();
        const wrapperSalt = crypto.getRandomValues(new Uint8Array(16));
        const wrapperKey = await this.deriveKeyFromPrf(prfBytes, wrapperSalt);
        
        const encrypted = await this.encrypt({ password: password }, wrapperKey);
        
        await chrome.storage.local.set({
            fs_webauthn_wrapper: {
                salt: Array.from(wrapperSalt),
                iv: encrypted.iv,
                ciphertext: encrypted.ciphertext
            }
        });
    }

    static async unlock(password) {
        const { fs_vault } = await chrome.storage.local.get('fs_vault');
        if (!fs_vault) throw new Error("Vault not set up.");
        
        const salt = new Uint8Array(fs_vault.salt);
        const key = await this.deriveKeyFromPassword(password, salt);
        
        const payload = await this.decrypt(fs_vault.ciphertext, fs_vault.iv, key);
        
        if (payload.validation !== "FETCHSTREAM_VAULT_OK") {
            throw new Error("Validation failed.");
        }
        
        const exportedKey = await crypto.subtle.exportKey("jwk", key);
        await chrome.storage.session.set({ 
            fs_vault_unlocked: payload.creds || {},
            fs_vault_key: exportedKey
        });
        chrome.action.setBadgeText({ text: '' });
        return payload.creds;
    }

    static async unlockWebAuthn() {
        const { fs_webauthn_wrapper } = await chrome.storage.local.get('fs_webauthn_wrapper');
        if (!fs_webauthn_wrapper) throw new Error("No Passkey registered for this vault. Please unlock with your Master Passphrase and add a Passkey first.");
        
        const prfBytes = await this.authenticateWebAuthn();
        const salt = new Uint8Array(fs_webauthn_wrapper.salt);
        const key = await this.deriveKeyFromPrf(prfBytes, salt);
        
        try {
            const payload = await this.decrypt(fs_webauthn_wrapper.ciphertext, fs_webauthn_wrapper.iv, key);
            if (!payload || !payload.password) throw new Error("Invalid wrapper payload.");
            return await this.unlock(payload.password);
        } catch (e) {
            throw new Error("Failed to decrypt passkey wrapper. Your Passkey might be incorrect or corrupted.");
        }
    }

    static async lock() {
        await chrome.storage.session.remove(['fs_vault_unlocked', 'fs_vault_key']);
        chrome.action.setBadgeText({ text: '🔒' });
        chrome.action.setBadgeBackgroundColor({ color: '#eab308' });
    }

    static async getUnlockedCreds() {
        const { fs_vault_unlocked } = await chrome.storage.session.get('fs_vault_unlocked');
        return fs_vault_unlocked || null;
    }
    
    static async isVaultSetup() {
        const { fs_vault } = await chrome.storage.local.get('fs_vault');
        return !!fs_vault;
    }
    
    static async reset() {
        await chrome.storage.local.remove(['fs_vault', 'fs_webauthn_id', 'fs_webauthn_salt']);
        await chrome.storage.session.remove(['fs_vault_unlocked', 'fs_vault_key']);
        chrome.action.setBadgeText({ text: '' });
    }
    
    static async updateCredsIfUnlocked(newCreds) {
        const { fs_vault_key } = await chrome.storage.session.get('fs_vault_key');
        if (!fs_vault_key) throw new Error("Vault is locked. Cannot update credentials.");
        
        const key = await crypto.subtle.importKey(
            "jwk",
            fs_vault_key,
            { name: "AES-GCM", length: 256 },
            true, // keep it extractable for future updates if needed
            ["encrypt", "decrypt"]
        );
        
        const payload = {
            validation: "FETCHSTREAM_VAULT_OK",
            creds: newCreds
        };
        
        const encrypted = await this.encrypt(payload, key);
        const { fs_vault } = await chrome.storage.local.get('fs_vault');
        
        await chrome.storage.local.set({
            fs_vault: {
                salt: fs_vault ? fs_vault.salt : Array.from(crypto.getRandomValues(new Uint8Array(16))),
                iv: encrypted.iv,
                ciphertext: encrypted.ciphertext,
                useWebAuthn: fs_vault ? fs_vault.useWebAuthn : false
            }
        });
        
        await chrome.storage.session.set({ fs_vault_unlocked: newCreds });
    }
}

if (typeof window !== 'undefined') {
    window.Vault = Vault;
}
