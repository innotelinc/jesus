---
description: Create a new release, bump version up to 1.x.10 threshold, update changelog, and manage Pull Requests
---

# Generate Release Workflow

Bump version, finalize CHANGELOG, commit, tag, push, publish to npm, and create GitHub release.

## Steps

### 1. Determine new version

Check current version in `package.json` and increment the patch number:

```bash
grep '"version"' package.json
```

Version format: `1.x.y` — increment `y` for patch, `x` for minor (threshold: y=10 triggers x+1).

### 2. Finalize CHANGELOG.md

Replace `[Unreleased]` header with the new version and date:

```markdown
## [1.x.y] — YYYY-MM-DD
```

### 3. Bump version in package.json

```bash
sed -i 's/"version": "OLD"/"version": "NEW"/' package.json
```

### 4. Stage, commit, and tag

// turbo-all

```bash
git add -A
git commit -m "feat(release): vX.Y.Z — summary of changes"
git tag -a vX.Y.Z -m "Release vX.Y.Z — summary"
```

### 5. Push to GitHub

```bash
git push origin main
git push origin vX.Y.Z
```

### 6. Publish to npm

```bash
npm publish
```

Wait for completion (prepublishOnly runs `npm run build:cli` automatically).

### 7. Create GitHub release

```bash
gh release create vX.Y.Z --title "Release vX.Y.Z" --notes-file /tmp/release_notes.md
```

### 8. Deploy to VPS (if requested)

See `/deploy-vps` workflow for Akamai VPS or use npm for local VPS:

```bash
ssh root@<VPS_IP> "npm install -g omniroute@X.Y.Z && pm2 restart omniroute"
```

## Notes

- Always run `/update-docs` BEFORE this workflow (ensures CHANGELOG and README are current)
- The `prepublishOnly` script runs `npm run build:cli` automatically during `npm publish`
- After npm publish, verify with `npm info omniroute version`
