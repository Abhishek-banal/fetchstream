FROM python:3.11-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PORT=8000

# Install native FFmpeg, curl, and build tools
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        curl \
        ca-certificates \
        gcc \
        libffi-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY backend/docker/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy runner script and server application
COPY backend/docker/server.py .
COPY scripts/ /app/scripts/

EXPOSE 8000

CMD ["python", "server.py"]
