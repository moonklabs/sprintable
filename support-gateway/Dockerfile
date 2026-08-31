# story #3259 — 독립 이미지. backend/Dockerfile과 레이어 0 공유(별도 FROM·별도 COPY 소스) —
# 이 이미지가 backend 소스트리를 전혀 보지 못하는 것 자체가 "0 fleet 자격"의 빌드타임 증거.
FROM mirror.gcr.io/library/python:3.12-slim

WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

COPY pyproject.toml uv.lock .
RUN uv sync --no-dev --frozen

COPY app/ app/
COPY alembic.ini .
COPY alembic/ alembic/
COPY scripts/migrate.sh scripts/migrate.sh

ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
