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
# scripts/ 통째 동봉 — migrate-dev 잡 클론(command override)으로 in-VPC 실행하는 운영/백필 스크립트.
# (scripts는 namespace/regular 패키지 — `python -m scripts.<name>`로 /app 기준 실행.) 개별 COPY는
# 신규 스크립트가 이미지에서 누락되는 함정이 있어(E-DG-REAL P0 backfill 사건: 파일 존재≠이미지 포함)
# 통째 COPY로 future-proof.
COPY scripts/ scripts/

# non-root 사용자 생성 + /app 소유권 변경 (uv .venv 포함)
RUN useradd --create-home --shell /bin/bash appuser \
    && chown -R appuser:appuser /app

ENV PATH="/app/.venv/bin:$PATH"

USER appuser

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
