# ⚡ Custom Webhook Cloud Runner (Cloudflare Pages + CI/CD Pipelines)

Deploy a 100% free, zero-maintenance cloud runner using **Cloudflare Pages** (edge API functions) and **CI/CD pipelines** (free cloud compute runners with native FFmpeg).

This setup allows you to download high-bitrate media streams and upload directly to cloud hosts with **zero local bandwidth consumed** and **zero VPS hosting costs**.

---

## 📁 Blueprint Files

This directory contains the ready-to-deploy blueprints for your private serverless runner:

* [**`workflows/server-relay.yml`**](./workflows/server-relay.yml): The CI/CD pipeline workflow that provisions an Ubuntu VM with FFmpeg and Python 3.11, downloads stream chunks in parallel, processes AES-128 keys, and streams to destination cloud hosts.
* [**`functions/api/`**](./functions/api/): The Cloudflare Pages edge functions implementing the standard FetchStream REST API:
  * [`server-relay.js`](./functions/api/server-relay.js): Handles `POST /api/server-relay` and dispatches jobs to CI/CD pipelines via `repository_dispatch`.
  * [`server-status.js`](./functions/api/server-status.js): Handles `GET /api/server-status` for real-time progress polling.
  * [`server-callback.js`](./functions/api/server-callback.js): Internal webhook endpoint for progress updates from the runner.
  * [`stream-proxy.js`](./functions/api/stream-proxy.js): Edge fallback proxy when origin CDNs restrict datacenter IP ranges.

---

## 🛠️ Architecture Overview

```text
[ FetchStream Chrome Extension ]
              │
              │  1. Dispatch Job (POST /api/server-relay)
              ▼
[ Cloudflare Pages Function (Edge Worker) ]
              │
              │  2. Triggers Workflow via G..Hub API (repository_dispatch)
              ▼
[ Private CI/CD pipelines Runner (Ubuntu VM) ]
              │  • Native FFmpeg stream parsing & AES-128 processing
              │  • Multi-threaded chunk downloading (2 to 24 threads)
              │  • Direct cloud upload (GoFile, Buzzheavier, Pixeldrain, Catbox, S3, Telegram)
              │  • Real-time progress callbacks to /api/server-callback
              ▼
[ Destination Cloud Storage Provider ]
```

---

## 📋 Step-by-Step Deployment Guide

Because CI/CD pipelines requires workflows to reside in `.github/workflows/` at the repository root to execute, you can deploy this runner in your own private repository in 3 easy steps:

### Step 1: Create Your Private Runner Repository
1. On GitHub, create a new repository (e.g. `fetchstream-runner`) and set visibility to **Private**.
2. Copy the blueprint files into your new repository root:
   * Copy `backend/serverless/workflows/server-relay.yml` $\to$ `.github/workflows/server-relay.yml`
   * Copy `backend/serverless/functions/api/` $\to$ `functions/api/`
   * Copy `scripts/server_uploader.py` $\to$ `scripts/server_uploader.py`
3. Commit and push these files to the `main` branch of your repository.
4. In your runner repository, go to **Settings ➔ Actions ➔ General ➔ Workflow permissions**:
   * Select **"Read and write permissions"**.
   * Check **"Allow CI/CD pipelines to create and approve pull requests"**.
   * Click **Save**.

---

### Step 2: Create a GitHub Personal Access Token (PAT)
Cloudflare Pages needs permission to dispatch jobs to your private GitHub repository:
1. Navigate to your GitHub [Personal Access Tokens (classic)](https://github.com/settings/tokens).
2. Click **Generate new token (classic)**.
3. Note name: `FetchStream Runner Token`.
4. Check the following scopes:
   * `repo` (Full control of private repositories / workflow dispatch)
   * `workflow` (Update GitHub Action workflows)
5. Click **Generate token** and copy the resulting string (`ghp_...`).

---

### Step 3: Deploy to Cloudflare Pages 
1. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com/) (create a  account if you don't already have one).
2. Go to **Workers & Pages ➔ Create Application ➔ Pages ➔ Connect to Git**.
3. Select your private `fetchstream-runner` repository.
4. Set the build configuration:
   * **Project name**: `my-fetchstream-runner` (or any custom name)
   * **Production branch**: `main`
   * **Framework preset**: `None`
   * **Build command**: *(leave empty)*
   * **Build output directory**: `public` (or any folder containing a basic `index.html`)
5. Click **Environment variables (advanced)** and add:
   * `GITHUB_TOKEN`: Your copied GitHub token (classic PAT starting with `ghp_...`)
   * `GITHUB_REPO`: `your-username/your-runner-repo-name` (Format: `owner/repo-name`, e.g. `alex/fetchstream-runner` — **do not** include `https://github.com/`)
   * `API_KEY`: *(Optional but strongly recommended)* A secret token (e.g. `my_secret_token_123`) to password-protect your runner from unauthorized access.
6. Click **Save and Deploy**. Cloudflare will provision your edge endpoints in seconds and assign you a  HTTPS domain (e.g., `https://my-fetchstream-runner.pages.dev`).

#### Optional: Enable Real-Time Percentage Callbacks (Cloudflare KV)
By default, the edge worker polls the CI/CD pipelines run API. To enable high-resolution progress updates (0%–100%), stage badges (`DOWNLOADING`, `UPLOADING`), and transfer speeds:
1. In the Cloudflare Dashboard, navigate to **Storage & Databases ➔ KV**.
2. Click **Create namespace**, enter the name `fetchstream_relay_kv`, and click **Add**.
3. Return to your Pages project: go to **Settings ➔ Functions ➔ KV namespace bindings**.
4. Click **Add binding**:
   * **Variable name**: `RELAY_KV` *(must match exactly)*
   * **KV namespace**: Select `fetchstream_relay_kv`
5. Click **Save**. Cloudflare will now store real-time runner callbacks automatically.

---

### Step 4: Connect to the FetchStream Extension
1. Open the **FetchStream** extension popup in your browser.
2. Click the **Settings (⚙️)** gear icon.
3. In the **Server-Side Upload (Cloud Runner)** section, paste your Pages URL:
   ```text
   Remote Server URL: https://my-fetchstream-runner.pages.dev
   ```
4. If you configured an `API_KEY` in Step 3, enter the exact same secret token into **Server API Key / Token (Optional)**.
5. Click outside the panel to save.

You're done! Whenever you click **`[ ⚡ Server Upload ]`** on any detected stream or file, your private CI/CD runner will download and upload the asset in the cloud, reporting live percentage progress directly inside the extension popup.

---

## 🔒 Security & Privacy Practices

1. **Private Repository**: Always keep your runner repository private to prevent unauthorized users from viewing your run logs or artifacts.
2. **Session Cookies & Authorization Tokens**: Authenticated video streams require session cookies (`Cookie`) and bearer tokens (`Authorization`) to download segments without HTTP 403 Forbidden errors. The extension securely forwards these captured headers to your configured runner URL. Because your runner is private, these credentials remain strictly confidential between your browser and your private cloud runner.
3. **API Key Protection**: Setting an `API_KEY` environment variable in Cloudflare Pages ensures that every incoming request to `/api/server-relay`, `/api/server-status`, and `/api/stream-proxy` is validated at the edge in <10ms. Requests without the correct token are rejected immediately with HTTP `401 Unauthorized`, safeguarding your GitHub runner minutes and Cloudflare bandwidth against unauthorized discovery or abuse.
4. **Lawful Archival Only**: Use your runner exclusively for content you are authorized to access and archive.

---

## 📖 Related Resources
* [Full REST API Specification](https://fetchstream.in/documentation#api-protocol)
* [Self-Hosted Docker Runner Blueprint](../docker/)
* [Online FAQ](https://fetchstream.in#faq)


