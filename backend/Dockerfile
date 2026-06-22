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
# E-MCP-HTTP S2: sprintable_mcp 패키지 동봉 — 동일 backend 이미지를 command override(`python -m
# sprintable_mcp`·TRANSPORT=http)로 sprintable-mcp-dev Cloud Run 서비스로도 구동(별 빌드 0). backend
# pyproject 가 mcp+uvicorn 보유라 deps 충족.
COPY sprintable_mcp/ sprintable_mcp/
COPY alembic.ini .
COPY alembic/ alembic/
COPY bootstrap.py .
# 런타임 잡 스크립트만 동봉(scripts/jobs/) — migrate-dev 잡 클론(command override)으로 in-VPC 실행:
# `python -m scripts.jobs.<name>`(/app 기준·namespace 패키지). 디렉토리 통째 COPY라 신규 잡 스크립트는
# 자동 포함(개별 COPY 누락 함정 회피·E-DG-REAL P0 backfill 사건). deploy/setup/provision .sh·RUNBOOK 등
# 비-런타임 스크립트는 scripts/ 루트에 남겨 런타임 이미지서 제외(recon-surface 최소화).
COPY scripts/jobs/ scripts/jobs/

# non-root 사용자 생성 + /app 소유권 변경 (uv .venv 포함)
RUN useradd --create-home --shell /bin/bash appuser \
    && chown -R appuser:appuser /app

ENV PATH="/app/.venv/bin:$PATH"

USER appuser

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
