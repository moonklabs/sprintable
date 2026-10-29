# Story 4805 — the VM's frontend image of a commit whose frontend inputs did not change (deploy/vm/bin/frontend-vm-image.sh).
# BASE is the image an earlier full build made from the SAME inputs (same input id, frontend_input_id.py), by digest. This puts on top of it what apps/web/Dockerfile puts
# in its last layers — the commit and the build time that /api/health reports — and nothing else, so the image still says which commit it is.
# Keep these lines the same as the last lines of the runner stage of apps/web/Dockerfile (a test compares them).
ARG BASE
FROM ${BASE}
USER root
ARG APP_COMMIT_SHA=unknown
RUN date -u +%Y-%m-%dT%H:%M:%SZ > /app/.build_time && echo "build ${APP_COMMIT_SHA}"
ENV APP_COMMIT_SHA=${APP_COMMIT_SHA}
USER nextjs
