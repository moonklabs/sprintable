# @sprintable/mcp-server

Sprintable MCP (Model Context Protocol) 서버 — Sprintable PM/Docs/Meeting/Retro surface용 90+ tools 묶음인.

## 설치 & 실행

### 환경 변수

| 변수                         | 필수 | 설명                                                          |
|------------------------------|------|---------------------------------------------------------------|
| `PM_API_URL`                 | Yes  | Sprintable PM API base URL (예: `https://your-sprintable-url.example.com`) |
| `AGENT_API_KEY`              | Yes  | 에이전트 API Key — PM API 인증용 (`sk_live_…`)               |
| `MCP_API_KEY`                | No   | SSE 엔드포인트 Bearer 인증 키 (선택)                         |
| `MCP_MODE`                   | No   | `stdio` (기본) 또는 `sse`                                     |
| `MCP_PORT`                   | No   | SSE 포트 (기본: `3100`)                                       |

```bash
# build
pnpm run build

# stdio mode (Claude Code / Codex / local harness)
PM_API_URL=https://your-sprintable-url.example.com AGENT_API_KEY=sk_live_... node dist/index.js

# SSE mode
MCP_MODE=sse MCP_PORT=3100 MCP_API_KEY=... PM_API_URL=... AGENT_API_KEY=... node dist/index.js
```

### 도구 아키텍처

모든 도구는 `PM_API_URL` + `AGENT_API_KEY`를 통해 Sprintable REST API를 경유하는. Supabase 직접 접근은 완전히 제거됐는 (Phase 2 완료).

## 주요 카테고리

- Sprint / Epic / Story / Task / Dashboard
- Memo / Notification / Standup / Agent Event
- Docs / Analytics / Meetings / Rewards
- Retro / Burndown / Sprint 운영

정확한 tool 목록은 `tools/list` 결과를 기준으로 보는 것이 맞는. README 숫자는 안내용인.

## current project 해석 규칙

MCP 도구는 아래 우선순위로 project context를 잡는.

1. **`project_id`가 있으면 최우선**
2. `project_id`가 없으면 **member/resource 기반으로 현재 프로젝트를 추론**
   - 예: `current_member_id`, `member_id`, `story_id`, `task_id`, `memo_id`, `meeting_id`
3. explicit `project_id`와 resource가 가리키는 project가 다르면
   - 예: `task_id not in explicit project_id`
4. 어느 쪽으로도 project를 확정할 수 없으면
   - `project_id required`

즉, `project_id`는 여전히 유효하지만, **읽기/조회/검색 계열의 상당수는 current member context만으로도 호출 가능**한.

## 언제 `project_id`가 필요한지

아래처럼 **명시적 project scope가 본질인 도구**는 `project_id`를 넣는 편이 맞는.

- Sprint: `list_sprints`, `activate_sprint`, `close_sprint`, `get_velocity`, `sprint_summary`
- Epic: `list_epics`, `add_epic`, `update_epic`, `delete_epic`
- Story 생성: `add_story`
- member/resource context가 전혀 없는 쓰기 작업

실무적으로는:
- **새 엔티티 생성 + 부모 리소스/member 단서가 부족하면 `project_id`를 넣는**
- **문서/목록/검색/대시보드 조회는 member/resource 단서만으로 충분한 경우가 많는**

## 언제 current member context만으로 충분한지

아래 계열은 `project_id` 없이도 많이 쓸 수 있는.

- Story 조회: `list_stories`, `list_backlog`
- Task 조회: `list_tasks`, `get_task`
- Dashboard: `my_dashboard`
- Team/Memo: `list_team_members`, `list_memos`, `list_my_memos`
- Docs / Analytics / Meetings / Retro / Events 다수 조회 도구

주의:
- `my_dashboard`는 `member_id`로 current project를 잡는.
- `list_my_tasks`는 이름 그대로 **member-scoped** 도구라서 `current_member_id` 또는 `assignee_id`가 반드시 있어야 하는.
  - 둘 다 없으면 `current_member_id or assignee_id required`

## 예제 payload

### 1) current project만으로 story 목록 조회

```json
{
  "current_member_id": "tm_123"
}
```

호출 예: `list_stories`

### 2) current project만으로 task 목록 조회

```json
{
  "current_member_id": "tm_123"
}
```

호출 예: `list_tasks`

### 3) member-scoped task 목록 조회

```json
{
  "current_member_id": "tm_123"
}
```

호출 예: `list_my_tasks`

또는

```json
{
  "project_id": "project_123",
  "assignee_id": "tm_123"
}
```

### 4) member 기준 dashboard 조회

```json
{
  "member_id": "tm_123"
}
```

호출 예: `my_dashboard`

### 5) explicit project가 필요한 sprint 조회

```json
{
  "project_id": "project_123"
}
```

호출 예: `list_sprints`

### 6) explicit project와 resource를 같이 검증하고 싶을 때

```json
{
  "project_id": "project_123",
  "task_id": "task_456"
}
```

호출 예: `get_task`

다른 project의 task를 섞어 넣으면 `task_id not in explicit project_id`로 막히는.

## 스크립트

### smoke test

```bash
PM_API_URL=... AGENT_API_KEY=... bash scripts/smoke-test.sh
```

### integration test

대표 도구를 explicit/current-project 혼합으로 검증하는 스크립트인.

```bash
PM_API_URL=... AGENT_API_KEY=... CURRENT_MEMBER_ID=tm_123 PROJECT_ID=project_123 MEMBER_ID=tm_123 bash scripts/integration-test.sh
```

기본 규칙:
- `CURRENT_MEMBER_ID`: current project 기반 read/list/search 계열 검증용
- `PROJECT_ID`: sprint/epic 같은 explicit project 계열 검증용
- `MEMBER_ID`: `my_dashboard`, `check_notifications` 같이 member field 이름이 다른 도구 검증용

## 빠른 운영 메모

- 문서/스크립트 예제는 **current project 가능 도구에는 `current_member_id` / `member_id`를 우선 사용**하는 쪽이 혼동이 적은.
- 반대로 sprint/epic처럼 현재도 strict project scope인 도구는 `project_id`를 계속 명시하는 것이 맞는.
- README보다 실제 schema가 진실이므로, 헷갈리면 `tools/list` + 각 tool input schema를 먼저 보는 것이 안전한.
