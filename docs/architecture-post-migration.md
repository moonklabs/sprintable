# Sprintable — GCP 전환 후 최종 아키텍처

**기준일**: 2026-05-02  
**전환 완료**: D-S1~D-S9, C-S10 v2, C-S11

---

## 1. 아키텍처 다이어그램 (텍스트)

```
[사용자 브라우저]
       │  HTTPS
       ▼
[app.sprintable.ai] ──── Cloud Run Domain Mapping
       │                     (asia-northeast3)
       ▼
┌─────────────────────────────────────────────────────────┐
│  Cloud Run: sprintable-frontend-prod                    │
│  (Next.js 15, standalone, asia-northeast3)              │
│                                                         │
│  ┌──────────────────┐  ┌──────────────────────────────┐ │
│  │  Next.js Pages   │  │  API Routes (/api/*)         │ │
│  │  SSR / RSC       │  │  → proxyToFastapi()          │ │
│  └──────────────────┘  └──────────────────────────────┘ │
└──────────────────────────┬──────────────────────────────┘
                           │  /api/v2/*  (Cloud Run internal)
                           ▼
┌─────────────────────────────────────────────────────────┐
│  Cloud Run: sprintable-backend-prod                     │
│  (FastAPI + SQLAlchemy async, asia-northeast3)          │
│                                                         │
│  인증: JWT (HS256, 15분) + API key (sk_live_* → DB조회)  │
│  150+ 엔드포인트: /api/v2/*                              │
└──────────────────────────┬──────────────────────────────┘
                           │  asyncpg
                           ▼
┌─────────────────────────────────────────────────────────┐
│  Cloud SQL (PostgreSQL 15)                              │
│  sprintable-db-prod (asia-northeast3)                   │
│  85 테이블 / 226 인덱스 / ~20MB                          │
└─────────────────────────────────────────────────────────┘

[MCP 클라이언트 (에이전트)]
       │  Authorization: Bearer sk_live_xxx
       ▼
[Next.js /api/*] → FastAPI /api/v2/* → Cloud SQL

[Slack/Teams/Discord 웹훅]
       │
       ▼
[Cloud Run frontend /api/bridge/*] → FastAPI → Cloud SQL
```

---

## 2. 인프라 구성

| 구성 요소 | 서비스 | 상세 |
|-----------|--------|------|
| 프론트엔드 | Cloud Run: sprintable-frontend-prod | Next.js 15, asia-northeast3, min=1 |
| 백엔드 | Cloud Run: sprintable-backend-prod | FastAPI, asia-northeast3, min=1 |
| DB | Cloud SQL PostgreSQL 15 | sprintable-db-prod, asia-northeast3 |
| 이미지 레지스트리 | Artifact Registry | asia-northeast3-docker.pkg.dev/sprintable-494803/sprintable |
| 시크릿 | Secret Manager | JWT_SECRET, DATABASE_URL_PROD, AGENT_API_KEY_SECRET 등 |
| 모니터링 | Cloud Monitoring | 대시보드 + 알럿 (setup_monitoring.sh) |
| DNS | Cloud Run Domain Mapping | app.sprintable.ai → frontend-prod |

---

## 3. 인증 흐름

```
OAuth (사용자):
  POST /api/auth/login → FastAPI → Cloud SQL (users) → JWT 발급
  sp_at 쿠키 (15분) + sp_rt 쿠키 (30일)

API key (에이전트/MCP):
  Authorization: Bearer sk_live_xxx
  → Next.js getAuthContext()
  → fastapiCall GET /api/v2/me (rawApiKey as Bearer)
  → FastAPI _resolve_api_key() → Cloud SQL agent_api_keys → team_members
  → AuthContext(user_id, org_id, project_id, scope)
```

---

## 4. 운영 런북

### 4.1 배포

```bash
# 백엔드 배포
COMMIT_SHA=$(git rev-parse HEAD) \
bash backend/scripts/deploy_backend.sh prod

# 프론트엔드 배포
COMMIT_SHA=$(git rev-parse HEAD) \
bash backend/scripts/deploy_frontend.sh prod

# smoke test
bash backend/scripts/verify_gcp_migration.sh
```

### 4.2 롤백

```bash
# 특정 revision으로 롤백
gcloud run services update-traffic sprintable-backend-prod \
  --to-revisions=REVISION_ID=100 \
  --region=asia-northeast3 --project=sprintable-494803

gcloud run services update-traffic sprintable-frontend-prod \
  --to-revisions=REVISION_ID=100 \
  --region=asia-northeast3 --project=sprintable-494803
```

### 4.3 스케일링

```bash
# 최소/최대 인스턴스 조정
gcloud run services update sprintable-backend-prod \
  --min-instances=2 --max-instances=10 \
  --region=asia-northeast3 --project=sprintable-494803
```

### 4.4 장애 대응

| 증상 | 원인 후보 | 조치 |
|------|-----------|------|
| 로그인 실패 (401) | JWT_SECRET 불일치 | Secret Manager 확인, 서비스 재시작 |
| API key 401 | sk_live_ hash 불일치 | FastAPI auth.py _resolve_api_key 확인 |
| DB 연결 실패 | Cloud SQL 과부하 | Cloud SQL insights 확인, 연결 풀 조정 |
| Cold start 지연 | min-instances=0 | min-instances=1 설정 |
| 웹훅 미발송 | teamMemberRepo None | memo-assignment-dispatch.ts 확인 |

### 4.5 로그 조회

```bash
# 백엔드 에러 로그
gcloud logging read \
  'resource.type="cloud_run_revision" resource.labels.service_name="sprintable-backend-prod" severity>=ERROR' \
  --limit=50 --project=sprintable-494803

# 프론트엔드 로그
gcloud logging read \
  'resource.type="cloud_run_revision" resource.labels.service_name="sprintable-frontend-prod"' \
  --limit=50 --project=sprintable-494803
```

---

## 5. 비용 비교

### 전환 전 (Amplify + Supabase)

| 항목 | 예상 월비용 |
|------|------------|
| AWS Amplify Hosting | ~$50 |
| Supabase Pro | $25 |
| **합계** | **~$75/월** |

### 전환 후 (Cloud Run + Cloud SQL)

| 항목 | 예상 월비용 (트래픽 낮음) |
|------|--------------------------|
| Cloud Run frontend (min=1) | ~$15 |
| Cloud Run backend (min=1) | ~$15 |
| Cloud SQL db-f1-micro | ~$10 |
| Artifact Registry | ~$1 |
| Cloud Monitoring | ~$0 (무료 티어) |
| **합계** | **~$41/월** |

> 트래픽 증가 시 Cloud Run auto-scaling으로 비용 증가. Cloud SQL은 fixed.

---

## 6. 해제 예정 서비스

| 서비스 | 해제 예정일 | 상태 |
|--------|------------|------|
| AWS Amplify (landing) | 2026-05-08 이후 | 대기 중 |
| Supabase Pro (일시중지) | 2026-05-08 이후 | 대기 중 |
| Supabase (영구 삭제) | 2026-06-08 이후 | 대기 중 |

절차: `backend/scripts/decommission_amplify_supabase.sh`
