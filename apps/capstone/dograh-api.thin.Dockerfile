# Thin overlay on the published dograh-api image.
#
# WHY THIS EXISTS. The estate runs the prebuilt ghcr.io/innotelinc/dograh-api
# image, and this repo's API-side fixes (dograh/patches/0002-*) would otherwise
# require the full 15-25 minute build in docker-compose.dograh-build.yml —
# including the pipecat submodule fetch, which stalls on this network. The
# deployed image's api/ tree has been verified byte-identical to
# dograh/upstream/api (excluding this repo's patches), so overlaying the
# patched api/ tree on the published base yields exactly what the full build
# would — in seconds.
#
# Build (from the capstone repo root, after scripts/apply-dograh-patches.sh):
#
#   docker build -f dograh-api.thin.Dockerfile \
#     -t dograh-local/dograh-api:capstone dograh/upstream/
#
# Then point DOGRAH_API_IMAGE at dograh-local/dograh-api:capstone in .env and
# recreate the service. The full build override remains the fallback whenever
# the published base and upstream drift apart (check: compare
# ghcr image /app/api against upstream/api with the patches reverse-applied).

FROM ghcr.io/innotelinc/dograh-api:latest
COPY api/ /app/api/
