# E-INFRA S1 — Prod DB 분리 커트오버 런북

> dev/prod가 같은 Cloud SQL 인스턴스(`sprintable-dev`, db-f1-micro)를 공유하던 상태를
> 새 prod 인스턴스(`sprintable-prod`)로 분리한다. **코드는 준비완료, 커트오버 GO는 PO 신호.**

## 현 상태 (2026-06-04 실측)

- Cloud SQL 인스턴스: **`sprintable-dev` 단 1개** (db-f1-micro, POSTGRES_15, 10GB, 10.110.0.3)
- `DATABASE_URL_PROD` == `DATABASE_URL_DEV` (byte-identical, 둘 다 `sprintable-dev` 소켓 가리킴) → **dev==prod 확정**
- Cloud Run 잡: `sprintable-migrate`, `sprintable-migrate-dev` (prod 잡 없음)
- 시크릿: `ALEMBIC_DATABASE_URL_PROD` 없음

## 역할

- **PO(gcloud):** 새 prod 인스턴스 생성 + prod 시크릿 실값 주입 (1~3)
- **디디(코드):** deploy script / migrate job / 검증 (이 PR). 4~6 실행은 GO 신호 후.

## 순서

### 1. 새 prod 인스턴스 생성 (PO)
```bash
bash backend/scripts/provision_cloud_sql.sh prod   # sprintable-prod, db-g1-small(1.7GB), 20GB, max_connections=100
gcloud sql connect sprintable-prod ... -c "SHOW max_connections;"   # AC: 실측 기록 (=100 확인)
```
> 비용 다운사이즈(선생님 결정): db-custom-2-7680 → db-g1-small.
> max_connections=100 고정 (g1-small OOM-safe; 150+ 위험). PITR 제외, 일 백업+7일 보존 유지.
> prod 백엔드 풀(현 10인스턴스×30=300)과 max_connections=100의 산수 정합은 **S2 풀 right-size**에서 처리.

### 2. prod 시크릿 실값 주입 (PO) — **평문/로컬파일 금지, Secret Manager 직접**
- `DATABASE_URL_PROD` → `postgresql+asyncpg://sprintable:PASS@/sprintable?host=/cloudsql/sprintable-494803:asia-northeast3:sprintable-prod`
- `ALEMBIC_DATABASE_URL_PROD` → `postgresql+psycopg2://sprintable:PASS@<PROD_PRIVATE_IP>:5432/sprintable`
- `DATABASE_URL_DEV` / `ALEMBIC_DATABASE_URL_DEV` 는 **불변** (AC)

### 3. 분리 확인 (PO)
```bash
diff <(gcloud secrets versions access latest --secret=DATABASE_URL_DEV) \
     <(gcloud secrets versions access latest --secret=DATABASE_URL_PROD)
# → 더 이상 동일하지 않아야 함 (host가 sprintable-prod 여야 함)
```

### 4. prod 스키마 마이그레이트 — alembic head, **seed 0** (디디, GO 후)
```bash
bash backend/scripts/provision_migrate_job.sh prod
gcloud run jobs execute sprintable-migrate-prod --region=asia-northeast3 --project=sprintable-494803 --wait
```
> `migrate.sh` 는 `alembic upgrade heads`(story bda4beac 이후 복수형) 만 실행 — seed 없음.
> 선생님 fresh-signup이 org를 새로 생성하므로 seed 데이터 불필요.

### 5. prod 백엔드 배포 (디디, GO 후)
```bash
COMMIT_SHA=<sha> bash backend/scripts/deploy_backend.sh prod
```
> `--add-cloudsql-instances` → `sprintable-prod`, `DATABASE_URL` → `DATABASE_URL_PROD` 시크릿 (env별 분기).

### 6. 검증
```bash
# 코드 분기 검증 (GCP 불필요, 이미 CI 통과):
cd backend && .venv/bin/python -m pytest tests/test_deploy_env.py -q
# 배포 후 헬스 + 실 토큰 호출로 prod가 새 DB를 보는지 확인 (feedback: 배포 실토큰 검증).
```

## AC 매핑

| AC | 충족 위치 |
|----|-----------|
| 새 prod 인스턴스 tier-up + `SHOW max_connections` 실측 | 1 (PO) |
| 기존 인스턴스 → dev 전용, `DATABASE_URL_DEV` 불변 | 2 (PO) |
| 새 `DATABASE_URL_PROD` 시크릿 | 2 (PO) |
| deploy_backend.sh env별 인스턴스 분기 + 양 경로 검증 | deploy_backend.sh + test_deploy_env.py |
| 새 prod DB 스키마 = alembic head, seed 없음 | provision_migrate_job.sh + migrate.sh (4) |
