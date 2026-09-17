# Capstone TTS shim — CPU only, no CUDA base image anywhere in this file.
FROM python:3.12-slim

WORKDIR /app

# Piper is optional and installs best-effort: the Kokoro path needs none of it,
# and a pip failure here must not cost you a working shim. Build with
# --build-arg WITH_PIPER=0 to skip it entirely (smaller image, faster build).
ARG WITH_PIPER=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
 && if [ "$WITH_PIPER" = "1" ]; then \
      pip install --no-cache-dir "piper-tts" \
      || echo "tts-shim: piper-tts unavailable — building Kokoro-only"; \
    fi

COPY app.py .

# Cache lives on a volume; the directory has to exist for the app's startup
# eviction pass even when the volume is not mounted (e.g. a bare `docker run`).
RUN mkdir -p /var/cache/tts-shim

# Container listens on 8880, the port Kokoro-FastAPI uses upstream — the compose
# mapping puts this on a different *host* port so the two can coexist.
EXPOSE 8880

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8880", "--log-level", "info"]
