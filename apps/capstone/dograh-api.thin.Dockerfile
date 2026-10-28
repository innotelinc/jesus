# Thin overlay on the published dograh-api image.
#
# WHY THIS EXISTS. The estate runs the prebuilt ghcr.io/innotelinc/dograh-api
# image, and this repo's API-side fixes (commits in dograh/upstream) would
# otherwise require the full 15-25 minute build in
# docker-compose.dograh-build.yml — including the pipecat submodule fetch,
# which stalls on this network. The deployed image's api/ tree has been
# verified byte-identical to the published upstream tree, so overlaying the
# fork's api/ tree on the published base yields exactly what the full build
# would — in seconds.
#
# Build (from the capstone repo root, with dograh/upstream cloned — the clone is
# the fork's tree, so it already carries the fixes):
#
#   docker build -f dograh-api.thin.Dockerfile \
#     -t dograh-local/dograh-api:capstone dograh/upstream/
#
# Then point DOGRAH_API_IMAGE at dograh-local/dograh-api:capstone in .env and
# recreate the service. The full build override remains the fallback whenever
# the published base and the tree here drift apart (check: compare ghcr image
# /app/api against dograh/upstream/api).

FROM ghcr.io/innotelinc/dograh-api:latest
COPY api/ /app/api/
