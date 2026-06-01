FROM python:3.12-slim

WORKDIR /app

# uv 설치
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# 의존성 설치 (레이어 캐싱)
COPY pyproject.toml .
RUN uv sync --no-dev

# 소스 복사
COPY app/ app/
COPY ee/ ee/
COPY alembic.ini .
COPY alembic/ alembic/
COPY bootstrap.py .
COPY scripts/migrate.sh scripts/migrate.sh

# non-root 사용자 생성 + /app 소유권 변경 (uv .venv 포함)
RUN useradd --create-home --shell /bin/bash appuser \
    && chown -R appuser:appuser /app

ENV PATH="/app/.venv/bin:$PATH"

USER appuser

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
