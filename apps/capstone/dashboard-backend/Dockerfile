# Capstone Control Panel aggregator
# Aggregates live data from the Capstone stack (Docker containers, the .env
# inventory, host users/disk) into the JSON shapes the React dashboard expects.
#
# Needs on the compose service:
#   - /var/run/docker.sock mounted (read container state/health/stats/events)
#   - .env mounted read-only at /config/.env (secrets inventory + link base URL)
#   - host /etc/passwd + /etc/group mounted read-only for the real user list
#     (and optionally host root at /host for whole-host CPU/disk/network stats)
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8095

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8095"]