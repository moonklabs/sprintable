# Sprintable Adapter for Cursor (Cloud Agents)

Cursor용 Sprintable Gateway dial-out 어댑터 (**마지막·유일 카테고리 C** — HTTP sidecar).

**B(stdio 자식 프로세스)와 다름:** 자식 프로세스 없음. Cursor **Cloud Agents API** HTTP 호출.
B의 프로세스 lifetime 대신 **run 상태 관리**가 핵심.

## ⚠️ 클라우드 에이전트 한정

**로컬 Cursor 에디터 세션은 외부 주입 경로가 없는.**
이 어댑터는 Cursor **Cloud(Background) Agents API**로만 동작 — GitHub 레포에서 작업하는 클라우드 에이전트.
로컬 에디터에 메시지를 주입하지 않는.

## 요구사항

- **Cursor 클라우드 API 키** (`CURSOR_API_KEY`) — Cursor 대시보드에서 발급
- Cursor 클라우드 에이전트는 **GitHub 레포 기반** — `CURSOR_REPO_URL`로 작업 레포 지정 (권장)
- Python 3.10+ + `httpx`

## 설치 및 실행

```bash
# 1. git pull
git pull origin develop

# 2. 환경 변수 설정
export AGENT_API_KEY=sk_live_...            # Sprintable agent API key (필수)
export SPRINTABLE_API_URL=https://...       # Backend URL (미설정 시 dev 기본값)
export CURSOR_API_KEY=...                    # Cursor 클라우드 API 키 (필수)
export CURSOR_REPO_URL=https://github.com/org/repo  # 작업 레포 (권장)
# export CURSOR_API_BASE=https://api.cursor.com      # (기본값)

# 3. 사이드카 실행
python connectors/cursor-sprintable/sidecar.py
```

## 동작 원리

```
sidecar.py 시작
  → CursorCloudClient.start() (httpx, 자식 프로세스 없음)
  → SprintableSSEClient.run(inject) (공통 SDK)
  → 이벤트마다 inject(ctx):
    → cursor.run_turn(conversation_id, content):
      → 첫 메시지: POST /v1/agents {prompt:{text}, repos?} → {agent.id, run.id}
      → 이후:      POST /v1/agents/{id}/runs {prompt:{text}} → {run.id}  (409시 완료 대기 후 재시도)
      → GET /v1/agents/{id}/runs/{runId}/stream (Cursor SSE) → assistant/result 텍스트
    → ctx.reply(response) → POST /api/v2/conversations/{id}/messages
    → ack: SDK 처리
```

## run 상태 관리 (카테고리 C 핵심)

B의 프로세스 lifetime 대신:
- **conversation_id → cursor agent_id 매핑** — stateful 에이전트 유지 (멀티턴 컨텍스트)
- **1-active-run 가드**: run당 1개만 active (409 `agent_busy`)
  - SDK가 `onMessage`를 순차 await → 한 turn의 stream 완료 전 다음 SSE 이벤트 미처리 = 자연 직렬화
  - 추가로 followup 409 시 `_wait_idle`(active run terminal 폴링) 후 재시도
- run status: `CREATING`/`RUNNING`(active) → `FINISHED`/`ERROR`/`CANCELLED`/`EXPIRED`(terminal)

## 실측 API (docs.cursor.com/cloud-agent, api.cursor.com, /v1)

| 용도 | 메서드 | 경로 |
|------|--------|------|
| Launch (첫 turn) | POST | `/v1/agents` `{prompt:{text}, repos?}` → `{agent:{id}, run:{id}}` |
| Follow-up (이후 turn) | POST | `/v1/agents/{id}/runs` `{prompt:{text}}` → `{run:{id,status}}` |
| 응답 스트림 | GET | `/v1/agents/{id}/runs/{runId}/stream` → SSE `assistant{text}`, `result{text}`, `done` |
| run 상태 | GET | `/v1/agents/{id}/runs` |

- 인증: `Authorization: Bearer ${CURSOR_API_KEY}`
- 409 `agent_busy`: run당 1개만 active — 본 어댑터가 완료 대기 후 재시도로 처리
