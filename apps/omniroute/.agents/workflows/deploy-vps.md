---
description: Deploy the latest OmniRoute code to the Akamai VPS (69.164.221.35) via npm
---

# Deploy to VPS Workflow

Deploy OmniRoute to the production VPS using Node.js + PM2 (no Docker).

**VPS:** `69.164.221.35` (Akamai, Ubuntu 24.04, 1GB RAM + 2.5GB swap)
**App path:** `/opt/omniroute-app`
**Process manager:** PM2 (`omniroute`)
**Port:** `20128`

## Steps

### 1. Push to GitHub

Ensure all changes are committed and pushed:

```bash
git push origin main
```

### 2. SSH into VPS, pull latest code, rebuild, and restart

// turbo-all

```bash
ssh root@69.164.221.35 "
  cd /opt/omniroute-app &&
  git fetch origin &&
  git reset --hard origin/main &&
  export NODE_OPTIONS='--max-old-space-size=1536' &&
  npm install --no-audit --no-fund &&
  npm run build &&
  pm2 restart omniroute &&
  pm2 save &&
  echo '✅ Deploy complete!'
"
```

### 3. Verify the deployment

```bash
ssh root@69.164.221.35 "pm2 list && curl -s -o /dev/null -w 'HTTP %{http_code}' http://localhost:20128/"
```

Expected: PM2 shows `online`, HTTP returns `307` (redirect to login).

## Notes

- The VPS has only 1GB RAM. `NODE_OPTIONS='--max-old-space-size=1536'` uses swap for the build.
- PM2 is configured with `pm2 startup` to auto-restart on reboot.
- The `.env` file is at `/opt/omniroute-app/.env` (copied from the old Docker setup at `/opt/omniroute/.env`).
- Nginx proxies `omniroute.online` → `localhost:20128`.
