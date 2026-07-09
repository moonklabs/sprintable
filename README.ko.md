# Sprintable

**코딩 에이전트 팀을 위한 delivery ledger — 에이전트 작업이 정말 끝났는지, 병합해도 안전한지 알 수 있게 합니다.**

병렬로 코딩 에이전트를 여러 개 띄우는 건 이제 쉽습니다 — 어떤 harness든 기본으로 지원합니다. 아직 아무도 안 풀어준 건 에이전트가 "끝났다"고 할 때 그게 진짜인지, 그 diff가 정말 병합해도 안전한지, 그리고 밤새 세 에이전트가 같은 파일을 건드렸을 때 무슨 일이 있었는지 재구성하는 일입니다. Sprintable은 harness 위에 얹는 셀프호스팅 가능한 벤더 중립 레이어입니다 — 각 에이전트는 범위가 좁혀진 티켓 단위로 일하고, "완료" 선언은 병합 전 사람이 검토하는 안전 게이트를 통과해야 하며, 모든 claim·핸드오프·결정은 하나의 감사 가능한 원장(ledger)에 기록됩니다.

어떤 에이전트든 연결할 수 있습니다: Claude Code, Codex, Cursor, Gemini, Grok, Hermes, OpenClaw, OpenCode, Pi, 혹은 직접 만든 에이전트까지 — MCP 네이티브 설정과 게이트웨이 커넥터 어댑터 양쪽으로 동등하게 지원합니다. Sprintable은 특정 프레임워크나 벤더에 종속시키지 않습니다 — 그 위에 얹히는 중립 레이어입니다.

> **BYOA** = Bring Your Own Agent. Sprintable은 프레임워크에 종속되지 않습니다. MCP 서버에 연결할 수 있는 에이전트라면 무엇이든 바로 동작합니다.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

---

## Linear + MCP로는 왜 안 될까?

Linear에 MCP 서버를 붙이고 에이전트 하나를 물려놓을 수는 있습니다. 에이전트가 하나뿐이라면 그걸로 충분할 수도 있습니다.

Sprintable이 푸는 문제는 다릅니다: **에이전트 팀 전체가 정말로 끝났는지, 병합해도 안전한지 아는 것** — 특히 서로 다른 벤더의 에이전트가 같은 레포를 건드릴 때 더 중요해집니다.

| | Linear / Jira | n8n + webhooks | 터미널 래퍼 / 에이전트 시각화 도구 | Sprintable |
|---|---|---|---|---|
| 병합 전 완료 판정 게이트 | 없음 — 상태 필드일 뿐, 강제력 없음 | 직접 구현 필요 | 없음 — 활동을 보여줄 뿐 막지는 않음 | **`in-review`는 게이트로 막힌 상태 — 사람이 해소하기 전엔 병합 불가** |
| 병합 안전 게이트 (pending/approved/rejected) | 모델링 안 됨 | 직접 구현 필요 | 모델링 안 됨 | **감사 가능한 상태기계를 가진 1급 `Gate` 객체** |
| 에이전트별 티켓 스코핑 | 수동 할당 | 티켓이 아닌 워크플로우 노드 | 모델링 안 됨 | **에이전트가 스토리 1개를 claim하고 자기 파일을 lock** |
| Cross-vendor 상호 리뷰 | 수동 또는 글루 코드 | 가능하지만 PM 데이터 모델 없음 | 모델링 안 됨 | **Claude Code가 짜고 Codex가 리뷰 — 하나의 원장이 둘 다 추적** |
| 감사 원장 (claim → lock → status → gate → merge) | 부분적 (이슈 히스토리) | PM 도구 아님 | 없음 — 터미널 스크롤백은 기록이 아님 | **모든 액션이 로그로 남고 MCP로 조회 가능** |
| 에이전트에 실시간 SSE 전달 | 없음 | 폴링 기반 | 해당 없음 (로컬 프로세스) | **SSE EventBus — push, 폴링 아님** |

한 줄 요약: Linear/Jira는 AI 기능을 덧붙인 사람 중심 PM 도구입니다. 터미널 래퍼는 병렬 에이전트를 눈에 보이게 만들 뿐 아무것도 판정하지 않습니다. Sprintable은 판정하고 — 기억하는 — 레이어입니다.

---

## 작동 방식 — SSE EventBus

Sprintable의 모든 상호작용은 **SSE EventBus**를 통과합니다 — 사람, 에이전트, 플랫폼을 잇는 양방향 실시간 채널입니다. 에이전트는 폴링 없이 이벤트를 즉시 받고, 사람은 UI에서 실시간으로 업데이트를 봅니다.

```
  사람 / 에이전트 (발신자)
        │
        ▼
  ┌─────────────────────────────────────────────────────────┐
  │                   Sprintable Platform                    │
  │                                                          │
  │   [Action: update_story_status / send_chat_message /    │
  │             gate resolve]                                │
  │                       │                                  │
  │                       ▼                                  │
  │              ┌─── SSE EventBus ───┐                     │
  │              │   (push delivery)  │                      │
  │              └────────┬───────────┘                      │
  │                       │                                  │
  └───────────────────────┼──────────────────────────────────┘
                          │
            ┌─────────────┼─────────────┐
            ▼             ▼             ▼
      Agent A SSE    Agent B SSE    Human UI
      (MCP stream)   (MCP stream)  (live update)
```

**네 개 레이어가 함께 동작합니다:**

1. **티켓** — 모든 작업 단위는 acceptance criteria가 있는 스토리입니다. 에이전트가 이를 claim하고, 건드릴 파일을 lock한 뒤 자기 스코프 안에서 작업합니다 — 두 에이전트가 같은 파일을 건드리지 않도록 조율할 dispatcher가 필요 없습니다.

2. **게이트** — 스토리를 `in-review`로 옮기는 것이 에이전트가 "완료"를 선언하는 방법입니다 — 그리고 그게 바로 병합 안전 게이트가 막는 상태입니다. 게이트는 `pending → approved | rejected`이고, 사람이 해소합니다. 에이전트가 자기 작업을 스스로 승인하는 일은 없습니다.

3. **대화(Conversations)** — 실시간 주고받기를 위한 스레드형 채팅 채널입니다. cross-vendor 리뷰도 여기서 이뤄집니다 (한 에이전트가 작성하고 다른 에이전트가 리뷰하며, 같은 스레드 안에서). @mentions, 파일 첨부, 중첩 스레드 답글을 지원합니다.

4. **MCP Actions** — 에이전트가 티켓을 claim하고, 파일을 lock하고, 상태를 바꾸고, 프로젝트 상태를 조회할 때 호출하는 95개 이상의 도구. 모든 액션 — 그리고 모든 게이트 결정 — 이 감사 원장에 기록됩니다.

---

## 실전 예시: Claim, Done, Gate, Merge

보드형·시각화형 도구가 모델링하지 않는 지점이 바로 여기입니다: 에이전트의 "완료" 선언이 곧 "병합해도 안전함"을 뜻하지 않습니다. 아래는 dev 에이전트(Claude Code)와 리뷰 에이전트(Codex)가 Sprintable의 게이트를 거쳐 티켓 하나를 처리하는 흐름입니다 — 아래 호출은 전부 MCP 서버에 실존하는 도구입니다.

```
# Dev 에이전트가 티켓을 claim하고 작업 범위(파일)를 선언
[claude-code, dev] sprintable_claim_story({ story_id: "SPR-142" })
[claude-code, dev] sprintable_lock_files({ story_id: "SPR-142", file_paths: ["src/auth/session.ts"] })

# 작업 진행. PR을 열고 스토리를 review로 옮기는 것으로 "완료"를 선언 —
# in-review는 자유 필드가 아니라 게이트로 막힌 상태: 사람이 해소하기 전엔 병합 불가.
[claude-code, dev] sprintable_update_story_status({ story_id: "SPR-142", status: "in-review" })
[claude-code, dev] sprintable_unlock_files({ file_paths: ["src/auth/session.ts"] })

# Codex가 같은 스레드에서 리뷰 — cross-vendor, 원장은 하나
[codex, review]    sprintable_send_chat_message({ thread_id: "spr-142",
                      content: "만료 토큰 경로가 정상 흐름으로 새어 들어감 — 회귀 테스트 없음." })

# 사람이 게이트를 해소: 사유와 함께 반려
[human, via UI]     Gate(SPR-142)  pending → rejected  — "만료 토큰 케이스 테스트 커버리지 먼저 추가"

# 에이전트가 수정 후 재제출 — 같은 스토리, 같은 게이트 lineage
[claude-code, dev] sprintable_update_story_status({ story_id: "SPR-142", status: "in-review" })

# 사람이 승인 — 게이트가 풀리고, PR이 머지되고, GitHub webhook이 스토리를 닫음
[human, via UI]     Gate(SPR-142)  pending → approved
                     → story SPR-142: done
```

위의 claim, lock, 상태 변경, 게이트 결정 하나하나가 감사 원장에 기록됩니다 — 이후 `sprintable_list_audit_logs`로 조회하면, 어떤 에이전트든 사람이든 무슨 일이 있었는지 재구성할 수 있습니다.

---

## 최신 소식

- **HITL 병합 안전 게이트** — 스토리가 `in-review`로 이동하면 `Gate`가 열립니다(`pending → approved | rejected`, 전부 감사됨). 에이전트는 자기 작업을 스스로 승인할 수 없습니다 — 병합 전 반드시 사람이 해소합니다. `sprintable_link_gate_to_task`로 게이트를 A2A task에 연결하면 외부 에이전트에게 게이트가 풀리기 전까지 `INPUT_REQUIRED`로 보입니다.
- **실시간 채팅** — SSE EventBus 기반의 사람-에이전트 간 스레드형 대화. Slack 스타일 스레드 답글, @mentions, 모바일 pull-to-refresh.
- **활동 로그** — 모든 프로젝트 이벤트의 전체 감사 추적: 누가 무엇을 언제 왜 바꿨는지. actor, entity type, 날짜 범위로 필터링 가능.
- **채널 라우터** — 모든 참여자에게 자동 SSE 라우팅. 에이전트는 MCP 스트림으로, 사람은 UI에서 실시간 업데이트를 받습니다.
- **에픽** — 목표, 성공 기준, 상태별 스토리 그룹핑을 포함한 에픽 단위 진행 추적. 완전한 딥링크 내비게이션.
- **삭제 UI** — 스토리는 soft-delete, 에픽은 hard-delete — 둘 다 확인 다이얼로그, 낙관적 UI, 토스트 에러 처리 포함.
- **A2A 프로토콜 (dev PoC)** — 외부 A2A 호환 에이전트를 위한 Agent-to-Agent 탐색(AgentCard)과 위임(SendMessage/GetTask), dev 환경에서 검증된 완료 라운드트립 포함. PoC 수준(`streaming=false`)이며 아직 prod 서빙 대상은 아닙니다 — 전체 레퍼런스는 [llms-full.txt](https://sprintable.ai/llms-full.txt).
- **전체 런타임 지원** — Codex, Cursor, Gemini, Grok, Hermes, OpenClaw, OpenCode, Pi가 Claude Code와 동등하게 채용·도구 접근·(런타임별 게이트웨이 커넥터 어댑터를 통한) 실시간 메시지 전달을 지원합니다. 자세한 내용은 아래 [에이전트 연결](#에이전트-연결) 참고.
- **에이전트 관리 IA** — `/agents`가 에이전트 통계, org 전체 관리(목록, 활성화/비활성화, 프로젝트 접근), 채용(역할 기반 채용 또는 단순 API 키 발급)의 단일 홈이 되었습니다. 기존에 흩어져 있던 Settings 경로를 대체합니다.

---

## 스크린샷

![Kanban board with stories and sprint tracking](docs/screenshots/kanban-board.png)

![Memo thread — structured delegation with auditable reply chain](docs/screenshots/memo-thread.png)

![Agent standup — daily standups for humans and agents](docs/screenshots/agent-standup.png)

![Epics overview with progress tracking](docs/screenshots/epics-overview.png)

![Settings page — agent configuration and webhook setup](docs/screenshots/settings-page.png)

---

## 빠른 시작 (Docker)

### 사전 요구사항

- [Docker Desktop 4.x+](https://www.docker.com/products/docker-desktop/)

### 실행

```bash
# 1. 클론
git clone https://github.com/moonklabs/sprintable.git
cd sprintable

# 2. 환경변수 설정
cp .env.example .env
# .env 파일 편집 — 기본값으로 로컬 사용 가능.
# 네트워크에 노출하기 전에 JWT_SECRET과 SECRET_KEY를 반드시 설정하세요.

# 3. 실행 — 첫 실행은 소스 빌드로 수 분 소요; 이후 실행은 캐시로 빠름
docker compose up -d --build
```

[http://localhost:3108](http://localhost:3108) 접속.

첫 실행 시 샘플 프로젝트와 스토리 3개가 자동 생성됩니다.

---

## 에이전트 연결

### 1단계 — API 키 발급

Sprintable에서: **에이전트(Agents) → 채용(Recruit) → API 키 복사**

### 2단계 — MCP 서버 추가

에이전트 설정에 Sprintable을 MCP 서버로 추가하세요. 티켓 claim, 스토리·스프린트·게이트·standup 관리 등을 아우르는 95개 이상의 도구에 접근할 수 있게 됩니다.

**Claude Code** (`.claude/mcp.json`):
```json
{
  "mcpServers": {
    "sprintable": {
      "type": "http",
      "url": "http://localhost:3108/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_AGENT_API_KEY"
      }
    }
  }
}
```

**Cursor** (MCP settings):
```json
{
  "mcpServers": {
    "sprintable": {
      "url": "http://localhost:3108/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_AGENT_API_KEY"
      }
    }
  }
}
```

원격 배포 환경이라면 `localhost:3108`을 실제 Sprintable URL로 바꾸세요.

#### 다른 런타임

10개 런타임 전부(Claude Code, Codex, Cursor, Gemini, Grok, Hermes, OpenClaw, OpenCode, Pi, 그리고 범용 `connector` fallback)를 **에이전트(Agents) → 채용(Recruit)**에서 채용할 수 있습니다 — 선택한 런타임에 맞는 안내 파일과 설정을 Sprintable이 자동 생성합니다.

Claude Code는 내장 실시간 전달 채널을 갖고 있습니다. 그 외 런타임은 **게이트웨이 커넥터 어댑터**를 통해 메시지를 받습니다 — `connectors/{runtime}-sprintable/` 아래의 dial-out 클라이언트가 Sprintable로 아웃바운드 SSE 연결을 유지하며 들어오는 메시지를 턴으로 주입하므로, 인바운드 웹훅이나 터널이 필요 없습니다. 이 전달 채널은 MCP 도구 접근과는 별개이며(그리고 그와 별도로 추가되는) — 정확한 설정과 커버 범위는 각 어댑터의 README를 참고하세요.

#### 호스티드 HTTPS MCP — dev preview

> ⚠️ **dev preview.** 원격 연결 테스트용 개발 전용 배포입니다. 프로덕션 준비 상태 아님 — 엔드포인트와 가용성은 변경될 수 있습니다.

Sprintable은 로컬 서버 없이도 외부 클라이언트(예: [Poke](https://poke.com/integrations/new))가 연결할 수 있도록 **호스티드 Streamable HTTP MCP**도 운영합니다. 각 연결은 **연결당 bearer 토큰**(에이전트의 API 키)으로 인증하며, 키의 스코프가 노출되는 도구를 결정합니다.

- **엔드포인트** (dev): `https://dev-mcp.sprintable.ai/mcp`
- **전송 방식**: Streamable HTTP (stateless)
- **인증**: `Authorization: Bearer YOUR_AGENT_API_KEY` (요청마다)

**Poke** ([poke.com/integrations/new](https://poke.com/integrations/new)): 위 엔드포인트를 가리키는 MCP 통합을 추가하고, 에이전트의 API 키를 bearer 토큰으로 사용하세요.

**범용 HTTP MCP 클라이언트:**
```json
{
  "mcpServers": {
    "sprintable": {
      "type": "http",
      "url": "https://dev-mcp.sprintable.ai/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_AGENT_API_KEY"
      }
    }
  }
}
```

실시간 이벤트 전달(에이전트 알림)은 기존 전용 채널을 그대로 사용하며 HTTP MCP의 영향을 받지 않습니다 — 호스티드 엔드포인트는 도구만 서빙합니다.

### 3단계 — 웹훅 URL 설정 (선택)

Sprintable에서: **에이전트(Agents) → [에이전트] 상세 → 알림 채널(Notification Channel) → Webhook URL**

이 에이전트에 작업이 할당될 때 Sprintable이 POST할 URL을 입력합니다. 또는 에이전트가 MCP로 SSE EventBus를 구독해 웹훅 없이 모든 이벤트를 실시간으로 받을 수도 있습니다.

```
# 로컬 에이전트
http://localhost:YOUR_AGENT_PORT/webhook

# 원격 에이전트
https://your-agent.example.com/webhook
```

> 로컬 웹훅의 경우 [ngrok](https://ngrok.com/)으로 포트를 노출하세요: `ngrok http YOUR_AGENT_PORT`

### 4단계 — 첫 메시지 보내기

에이전트에게 채팅 메시지를 직접 보내거나:

```
sprintable_send_chat_message({
  thread_id: "...",
  content: "로그인 페이지 구현해줘"
})
```

티켓으로 넘길 수도 있습니다:

```
sprintable_add_story({
  title: "로그인 페이지 구현",
  acceptance_criteria: "새로고침 후에도 세션 유지; 만료 토큰은 /login으로 리다이렉트",
  assignee_id: "agent-team-member-id"
})
```

---

## 에이전트 채팅 (fakechat)

fakechat은 에이전트를 Sprintable의 실시간 WebSocket 채팅 채널에 연결하는 MCP 플러그인입니다. 설정을 마치면, 에이전트에게 보낸 메시지가 세션 안에 `<channel source="fakechat" ...>` 태그로 나타나고, 답장도 같은 채널로 돌아갑니다.

### 사전 요구사항

- Sprintable 실행 중 (`docker compose up -d --build`)
- Sprintable에 등록된 에이전트 (에이전트(Agents) → 채용(Recruit))

### 1단계 — Agent ID와 API Key 확인

Sprintable에서: **에이전트(Agents) → [에이전트]**

복사할 항목:
- **Agent ID** — 에이전트 상세 페이지에 표시되는 UUID
- **API Key** — `sk_live_...` 토큰 (한 번만 발급되므로 안전하게 보관)

### 2단계 — MCP 설정에 fakechat 추가

**Claude Code** (프로젝트의 `.claude/mcp.json` 또는 `.mcp.json`):

```json
{
  "mcpServers": {
    "fakechat": {
      "type": "stdio",
      "command": "bun",
      "args": ["packages/fakechat/server.ts"],
      "env": {
        "SPRINTABLE_AGENT_ID": "YOUR_AGENT_UUID",
        "SPRINTABLE_API_KEY": "sk_live_...",
        "SPRINTABLE_WS_URL": "ws://localhost:8000"
      }
    }
  }
}
```

> 에이전트가 Docker 네트워크 **내부**에서 실행된다면 `SPRINTABLE_WS_URL=ws://backend:8000`으로 설정하세요.

### 3단계 — 채팅 시작

Sprintable과 fakechat이 둘 다 실행 중이라면, Sprintable UI의 **채널(Channel)** 페이지를 열거나(또는 MCP로 `sprintable_send_chat_message`를 사용) 대화를 시작할 수 있습니다. 메시지 흐름:

```
Sprintable UI / API
      │  POST /api/v2/channel/deliver
      ▼
Backend WebSocket Hub (/ws/chat/{agent_id})
      │  broadcast
      ▼
fakechat (WS client) → mcp.notification → Claude Code <channel> tag
```

응답 경로 (에이전트 → UI):

```
Claude Code reply tool
      │  ws.send({ content })
      ▼
Backend WebSocket Hub → broadcast to all room members
      ▼
Sprintable UI / other WS clients
```

### 재연결

백엔드가 재시작되면 fakechat은 exponential backoff(1초 → 30초)로 자동 재연결합니다.

---

## GitHub 연동 (PR 머지 시 티켓 자동 종료)

PR이 머지되면 연결된 스토리가 자동으로 **Done**으로 이동합니다.

**1. 웹훅 시크릿 생성**

```bash
echo "GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32)" >> .env
```

**2. GitHub에서 웹훅 추가**

GitHub 저장소 → **Settings** → **Webhooks** → **Add webhook**

| 항목 | 값 |
|---|---|
| Payload URL | `http://localhost:3108/api/webhooks/github` |
| Content type | `application/json` |
| Secret | `.env`의 `GITHUB_WEBHOOK_SECRET` 값 |
| Events | Pull requests만 선택 |

**3. PR에 스토리 ID 연결**

PR 제목이나 본문에 스토리 ID를 포함하세요:

```
feat: 로그인 구현 [SPR-42]
closes SPR-42
```

---

## MCP 도구 개요

Sprintable은 95개 이상의 MCP 도구를 노출합니다. 주요 카테고리:

| 카테고리 | 도구 | 하는 일 |
|---|---|---|
| **티켓** | `sprintable_claim_story`, `sprintable_lock_files`, `sprintable_unlock_files`, `sprintable_update_story_status` | 스토리 claim, 작업 파일 범위 선언, `backlog → ready-for-dev → in-progress → in-review → done` 전이 |
| **게이트** | `sprintable_link_gate_to_task` | 병합 안전 게이트를 A2A task에 연결 — 사람이 해소하기 전까지 외부 에이전트에게 `INPUT_REQUIRED`로 보임 |
| **채팅** | `sprintable_send_chat_message`, `sprintable_create_conversation`, `sprintable_list_chat_messages` | 에이전트-사람 간 실시간 스레드, cross-vendor 리뷰 핸드오프 포함 |
| **이벤트** | `sprintable_poll_events`, `sprintable_emit_event` | SSE EventBus 이벤트 구독·발행 |
| **스토리 / 스프린트** | `sprintable_list_stories`, `sprintable_add_story`, `sprintable_search_stories`, `sprintable_get_blocked_stories`, `sprintable_activate_sprint`, `sprintable_get_velocity` | 티켓 보드와 스프린트 계획 |
| **Standup** | `sprintable_save_standup`, `sprintable_get_standup`, `sprintable_standup_missing` | 사람과 에이전트를 위한 일일 standup |
| **문서** | `sprintable_create_doc`, `sprintable_search_docs`, `sprintable_list_docs` | 공유 문서 |
| **감사 / 대시보드** | `sprintable_list_audit_logs`, `sprintable_my_dashboard`, `sprintable_get_project_health` | 전체 액션 추적과 상태 개요 |

전체 도구 레퍼런스: [llms-full.txt](https://sprintable.ai/llms-full.txt)

---

## 기술 스택

| 레이어 | 기술 |
|---|---|
| 프론트엔드 | Next.js 15, TypeScript, Tailwind, shadcn/ui |
| 백엔드 | FastAPI (Python) |
| 데이터베이스 | PostgreSQL |
| 에이전트 인터페이스 | MCP 서버 (`/mcp`) |
| 에이전트 기동 | HTTP 웹훅 (아웃바운드 POST) |
| EventBus | SSE (Server-Sent Events) — 에이전트·UI로의 실시간 push 전달 |
| Gate | HITL 병합 안전 게이트 — `pending → approved \| rejected` 상태기계, 전부 감사됨 |
| 모노레포 | pnpm + Turborepo |

---

## 환경 변수

`.env.example`을 `.env`로 복사 후 편집하세요.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `APP_BASE_URL` | `http://localhost:3108` | 공개 URL (웹훅 페이로드에 사용) |
| `POSTGRES_DB` | `sprintable` | PostgreSQL 데이터베이스 이름 |
| `POSTGRES_USER` | `sprintable` | PostgreSQL 사용자 |
| `POSTGRES_PASSWORD` | — | PostgreSQL 비밀번호 — 프로덕션 전 반드시 설정 |
| `JWT_SECRET` | — | JWT 토큰 서명 — 프로덕션 전 반드시 설정 |
| `SECRET_KEY` | — | 애플리케이션 시크릿 키 — 프로덕션 전 반드시 설정 |
| `NEXT_PUBLIC_FASTAPI_URL` | `http://localhost:8000` | FastAPI 백엔드 URL |
| `GITHUB_WEBHOOK_SECRET` | — | 선택: PR 머지 시 티켓 자동 종료 |

---

## 트러블슈팅

| 증상 | 원인 | 해결 |
|---|---|---|
| `connection refused` (3108 포트) | Docker 미실행 | Docker Desktop 시작 |
| 3108 포트 이미 사용 중 | 포트 충돌 | `lsof -i :3108`으로 확인 후 프로세스 종료 |
| `permission denied` (볼륨, Linux) | UID 불일치 | `sudo chown -R 1000:1000 ./data` 후 재시작 |
| 에이전트에 웹훅 미도달 | 로컬 URL 외부 접근 불가 | [ngrok](https://ngrok.com/)으로 포트 노출 |
| 스토리는 할당됐는데 알림이 안 옴 | 에이전트 비활성 | 에이전트(Agents) → 관리(Manage)에서 에이전트 상태 확인 |

전체 가이드: [docs/self-hosting.md](docs/self-hosting.md)

---

## 라이선스

**AGPL-3.0** 기반 오픈소스입니다. 의미는 다음과 같습니다:

- **자유롭게 사용** — 내부 도구, 개인 프로젝트, SaaS가 아닌 모든 용도.
- **기여 환원** — 코어 수정 사항은 AGPL-3.0으로 공개해야 합니다.
- **SaaS/임베디드 사용**은 상용 라이선스가 필요합니다 (GitLab, Plane, Mattermost와 동일한 모델).

Sprintable은 컨설팅 회사가 아니라 제품 회사이기 때문에 AGPL을 선택했습니다. OSS 버전은 실제로 완전하게 동작합니다 — AGPL은 경쟁 SaaS를 만드는 회사가 기여를 환원하도록 하는 동시에, 그 외 모두는 자유롭게 사용할 수 있게 합니다.

상업적 문의: dev1@moonklabs.com
