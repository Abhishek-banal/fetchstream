# 🐳 Example Reference Blueprint A: Self-Hosted Docker Runner

This directory provides an example reference implementation of a FetchStream Remote Runner using FastAPI and Docker. You can use this blueprint to quickly deploy a high-performance, private runner on any Linux VPS, Raspberry Pi, home server, NAS, or local machine.

## 🚀 Example Deployment (Docker)

### 1. Configure Environment (Optional)
```bash
cp backend/docker/.env.example backend/docker/.env
```
*(You can set a custom `PORT` or secret `API_KEY` inside `.env` to protect your server.)*

### 2. Start the Container

#### Method A: Using Docker Compose (Recommended)
From the repository root:
```bash
docker compose -f backend/docker/docker-compose.yml up -d --build
```
*(Or navigate to `cd backend/docker && docker compose up -d --build`)*

#### Method B: Using Plain Docker CLI
From the repository root:
```bash
docker build -t fetchstream-runner -f backend/docker/Dockerfile .
docker run -d -p 8000:8000 --name fetchstream-remote-runner fetchstream-runner
```

Your runner is now running at `http://localhost:8000`.

### 3. Verify Health
```bash
curl http://localhost:8000/health
```
You should see:
```json
{"status":"healthy","service":"FetchStream Remote Runner","version":"2.0.0"}
```

### 4. Connect to the Chrome Extension
1. Open the **FetchStream** extension popup.
2. Click the **Settings (⚙️)** gear icon.
3. Under **Server Upload (Cloud Runner)**, enter your server URL:
   * Local testing: `http://localhost:8000`
   * VPS / Remote server: `https://your-domain.com`
4. Click outside to save. That's it! Clicking **`[ ⚡ Server Upload ]`** on any stream card will now run on your private server.

---

## 🐍 Alternative: Run Directly with Python (No Docker)

If you have Python 3.10+ and native `ffmpeg` installed:

```bash
# 1. Install dependencies
pip install -r backend/docker/requirements.txt

# 2. Start the server
python backend/docker/server.py
```

---

## 🔒 Securing Your Server (API Key Protection)

To prevent unauthorized strangers from dispatching downloads through your VPS, set an `API_KEY`:

### In Docker (`docker-compose.yml` or `.env`):
```yaml
environment:
  - API_KEY=my_super_secret_token_123
```

### In the Chrome Extension:
In **Settings -> Server Upload**, paste `my_super_secret_token_123` into **Server API Key / Token (Optional)**. The extension will automatically attach `Authorization: Bearer my_super_secret_token_123` to all requests.

---

## 🌐 Enabling HTTPS (Recommended for Remote VPS)

Chrome requires HTTPS when making network requests to remote domains:

### Option A: Cloudflare Tunnel (Free & Easiest)
```bash
cloudflared tunnel --url http://localhost:8000
```
This gives you a free, public `https://something.trycloudflare.com` address with automatic SSL that works instantly in the extension.

### Option B: Caddy (Automatic HTTPS)
```caddy
your-domain.com {
    reverse_proxy localhost:8000
}
```

### Option C: Nginx Reverse Proxy
```nginx
location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

---

## 📖 Related Resources
* 🌐 **Live Web Documentation**: [https://fetchstream.in/documentation#deploy-docker](https://fetchstream.in/documentation#deploy-docker)
* 📡 **Universal REST API Contract**: [`backend/README.md`](../README.md)
* 🐍 **Downloader & Uploader Engine**: [`scripts/server_uploader.py`](../../scripts/server_uploader.py)
* ⚡ **Serverless Runner Alternative**: [`backend/serverless/README.md`](../serverless/README.md)
