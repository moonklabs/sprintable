# OSS Single-User Smoke Runbook

**목적**: OSS-SPLIT Phase B.2의 AC-6 — `OSS_MODE=true` + SQLite adapter로 4경로 CRUD 검증.

## 전제조건

- Node.js ≥ 22.5 (`node:sqlite` built-in module)
- localhost에서 Next.js dev server 실행 가능
- `sprintable.db` (SQLite 파일)는 스크립트 최초 실행 시 자동 생성됨

## 환경 변수

`.env.example`을 복사하여 시작하는 것을 권장한다:

```bash
cp .env.example .env.local
# 필요 시 값 수정 후 dev server 기동
```

수동 설정 시:

```bash
export APP_BASE_URL=http://localhost:3108
export OSS_MODE=true
export NEXT_PUBLIC_OSS_MODE=true
export SQLITE_PATH=./.data/sprintable.db
export AGENT_API_KEY_SECRET=change-me-in-development
```

## 실행

### 1. dev server 기동

```bash
cd apps/web
pnpm dev
```

### 2. smoke 스크립트

```bash
# Agent API key 경로 + /settings 차단 자동 검증
AGENT_API_KEY=sk_live_xxx \
ORG_ID=<org_uuid> \
PROJECT_ID=<project_uuid> \
bash scripts/oss-smoke.sh
```

### 3. Web UI (수동)

1. http://localhost:3108 로그인
2. 프로젝트/에픽/스토리/태스크/메모/문서 CRUD 각 1회 이상
3. 500 에러 없음 확인

### 4. MCP stdio (수동)

Claude Code 또는 호환 MCP 클라이언트에서 sprintable MCP 서버 등록 후:

- `list_projects` → 정상 응답
- `create_memo` → 정상 응답
- `list_stories` → 정상 응답

환경 변수가 MCP stdio 프로세스에도 전파되어야 함 (`OSS_MODE=true`).

## 경로별 Factory 경유 여부

| 도메인 | Factory 경유 | 비고 |
|---|---|---|
| Epic | ✅ (B.1) | `/api/epics/*` |
| Story | ✅ (B.1) | `/api/stories/*` |
| Task | ✅ (B.2 샘플) | `/api/tasks/*` |
| Memo | ⏳ follow-up | `MemoService` 도메인 로직(webhook dispatch, assignee join) 재설계 필요 |
| Doc | ⏳ follow-up | 트리 구조 서비스 |
| Project | ⏳ follow-up | route에서 직접 supabase (org_members join 복잡) |
| Sprint | ⏳ follow-up | status transitions 로직 있음 |
| Notification | ⏳ follow-up | 서비스 없음, route 인라인 |
| TeamMember | ⏳ follow-up | 서비스 없음, route 인라인 |
| Subscription | ✅ Factory 경유 | `settings/layout.tsx` OSS 분기 → NullSubscriptionRepository |

Repository/Factory는 모두 존재하므로 후속 스토리에서 점진적으로 route 전환 가능.

## 기대 결과

- ✅ Path 3 (Agent API) — Epic/Story/Task/Memo 생성/조회 전부 200
- ✅ Path 4 (Auth) — Agent key `/settings` 403, human session 200
- ✅ Path 1 (Web UI) — 기본 CRUD 동작 (Task는 factory 경유)
- ✅ Path 1 (/settings) — OSS 분기로 Supabase 호출 없이 200 반환
- ⚠️ Path 2 (MCP stdio) — MCP 내부 로직이 아직 factory 미전환이라 일부 제한적

## 트러블슈팅

- `node:sqlite not found` → Node 22.5+ 필요
- `SQLITE_BUSY` → 다른 프로세스가 DB 점유. dev server 재시작
- `/settings` 500 → OSS_MODE가 누락된 경우. `OSS_MODE=true` + `NEXT_PUBLIC_OSS_MODE=true` 확인
- `/settings` 결제 UI 표시됨 → `NEXT_PUBLIC_OSS_MODE=true` 설정 확인 (클라이언트 env)
