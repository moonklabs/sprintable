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
# 런타임 잡 스크립트 동봉: scripts/jobs/(`python -m scripts.jobs.<name>`·namespace 패키지·신규 잡 자동 포함)
# + scripts/migrate.sh(표준 sprintable-migrate{,-dev} 잡 command=`/app/scripts/migrate.sh`·env guard+CWD 보정+
# `exec alembic upgrade head`). ⚠️migrate.sh 는 #1666서 `COPY scripts/`→`scripts/jobs/`로 좁히며 이미지서
# 누락돼 마이그 잡 exec 실패했음(provision_migrate_job.sh 는 옛 경로 참조=계약 드리프트) — 명시 COPY 로 복원.
# deploy/setup/provision .sh·RUNBOOK 등 비-런타임은 scripts/ 루트에 남겨 제외 유지(recon-surface 최소).
COPY scripts/jobs/ scripts/jobs/
COPY scripts/migrate.sh scripts/migrate.sh
# git mode 100755 라 COPY 가 +x 보존하나, critical infra 라 명시(belt-and-suspenders·잡 직접 exec).
RUN chmod +x scripts/migrate.sh

# non-root 사용자 생성 + /app 소유권 변경 (uv .venv 포함)
RUN useradd --create-home --shell /bin/bash appuser \
    && chown -R appuser:appuser /app

ENV PATH="/app/.venv/bin:$PATH"

USER appuser

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
