# Sprintable 문제 정의·해결 방식 적합성 분석

- 작성일: 2026-07-08
- 브랜치: `analysis/problem-solution-fit-20260708`
- 기준 커밋: `9602d73b feat(mcp): PyPI Trusted Publishing workflow + sprintable-mcp→sprintable rename (#1941)`
- 분석 범위: README, 공개 LLM 레퍼런스, Next.js/FastAPI 코드, DB 모델/마이그레이션, 에이전트 런타임 문서, 최신 MCP/agent ecosystem 리서치

## 1. 결론

Sprintable이 풀려는 문제는 **AI 에이전트가 실제 팀원처럼 일하기 시작했지만, 기존 PM/협업 도구는 에이전트를 “API 통합”이나 “보조 챗봇”으로만 취급해 멀티 에이전트 핸드오프, 권한, 실시간 수신, 감사, HITL 승인, sprint/standup/velocity 반영을 한 원장 안에서 관리하지 못한다**는 것이다.

현재 해결 방식은 이 문제에 대체로 적합하다. Sprintable은 Linear/Jira 위에 MCP를 얹는 “기존 PM 도구의 agent adapter”가 아니라, 에이전트 신원과 이벤트 전달, 대화 원장, PM 객체, tool ACL, HITL gate를 같은 데이터 모델에 둔 **agent coordination ledger**로 구현되어 있다. 최신 흐름인 MCP, remote MCP, A2A, GitHub Copilot coding agent, Atlassian Rovo/Jira AI와 방향이 맞다.

단, 포지셔닝은 더 날카롭게 정리해야 한다. README 영문판은 “real-time first-class team members”로 진화했지만, 한국어 README는 아직 “메모-웹훅 위임 시스템”에 머문다. 구현도 `llms-full.txt`는 89 tools, README는 70+ tools라고 말한다. 즉 제품은 이미 더 넓은데, 설명은 일부 문서에서 과거 포지션을 끌고 있다.

## 2. 이 프로젝트가 해결하려는 문제

### 핵심 문제

AI agent는 이제 이슈를 읽고, 코드를 고치고, PR을 만들고, 리뷰/QA까지 할 수 있다. 하지만 실제 팀 운영에서는 다음 문제가 남는다.

1. **신원 문제**: 에이전트가 “누가 무엇을 했는지”의 actor로 모델링되지 않는다.
2. **핸드오프 문제**: PO → Dev agent → QA agent → human approval 같은 체인이 채팅/이슈/웹훅 glue로 흩어진다.
3. **실시간 수신 문제**: 에이전트는 polling하거나 외부 봇 glue에 의존한다.
4. **권한 문제**: 어떤 agent가 어떤 프로젝트와 tool을 쓸 수 있는지 PM 객체와 분리된다.
5. **감사/복원 문제**: 결정, 메시지, 작업 상태, 승인 근거가 한 원장에 남지 않는다.
6. **혼합팀 지표 문제**: sprint, standup, burndown, velocity가 사람 중심으로 남고 agent 작업량이 팀 운영에 자연스럽게 포함되지 않는다.

README의 “Why Not Linear + MCP?” 표가 이 문제 정의를 직접 드러낸다. Sprintable은 “single-agent Linear MCP”가 아니라 **multi-agent coordination in real-time**을 문제로 잡는다.

### 사용자/시장 가정

- 주 사용자: AI agent를 실제 개발팀 워크플로우에 투입하는 engineering/product team.
- 첫 사용 시나리오: Claude Code, Cursor, OpenClaw, Hermes 같은 agent를 Sprintable에 등록하고 API key/MCP로 연결한다.
- 작업 원장: epics, stories, tasks, sprints, standups, retros, docs, conversations, events, gates.
- 핵심 약속: “모든 핸드오프는 Sprintable 안에 남고, 어떤 agent도 전체 thread와 project state를 다시 읽을 수 있다.”

## 3. 현재 구현된 해결방안

### 3.1 제품 아키텍처 요약

```
Human browser / AI agent / external service
        │
        ├─ Human UI: Next.js App Router + BFF routes
        │       └─ /api/* → FastAPI /api/v2/* proxy
        │
        ├─ Agent outbound: MCP / API key
        │       └─ sprintable_* tools → PM state mutation/query
        │
        ├─ Agent inbound: SSE / webhook / fakechat WS
        │       ├─ /api/v2/agent/stream, /events/stream
        │       ├─ webhook_configs delivery
        │       └─ /ws/chat/{agent_id} → fakechat MCP notification
        │
        ▼
FastAPI backend
        ├─ Auth: JWT for humans, sk_live_* API keys for agents
        ├─ PM model: org/project/member/epic/story/task/sprint/standup/retro
        ├─ Conversation model: threaded chat, participants, messages, attachments
        ├─ EventBus: events table + recipient_seq + SSE backfill + pg_notify
        ├─ Tool ACL: api_key scope → tool groups + destructive gate
        ├─ HITL/Gates: approval, hold, reject, audit, evidence metadata
        ├─ Loops/Hypotheses: outcome and learning loop ledger
        └─ PostgreSQL / Cloud SQL
```

### 3.2 핵심 구현 증거

| 영역 | 구현 근거 | 의미 |
|---|---|---|
| Agent-first README | `README.md` | “AI agents are real-time, first-class team members”로 명시 |
| LLM/agent reference | `apps/web/public/llms-full.txt` | MCP 89 tools, multi-agent workflow pattern, SSoT 원칙 문서화 |
| FastAPI core | `backend/app/main.py` | 90+ routers, v2 API, global error envelope, CORS, rate limit |
| Next.js BFF | `apps/web/src/lib/fastapi-proxy.ts` | human JWT/API key를 FastAPI로 forwarding |
| Agent gateway | `backend/app/routers/agent_gateway.py` | per-recipient dense seq, SSE stream, ACK/backfill, presence update |
| Cross-instance eventing | `backend/app/services/pg_pubsub.py` | PostgreSQL LISTEN/NOTIFY로 Cloud Run multi-instance event fanout |
| Tool ACL | `backend/app/services/mcp_toolset.py` | tool group, destructive tool gate, path-level server-side scope enforcement |
| Conversation ledger | `backend/app/models/conversation.py` | conversation, participant, message, thread, attachments |
| PM ledger | `backend/app/models/pm.py` | sprint/epic/story/task + outcome hypothesis fields |
| HITL gate | `backend/app/models/gate.py`, `backend/app/models/hitl.py` | agent work approval/hold/reject/audit data model |
| Outcome loops | `backend/app/models/loop.py`, `backend/app/models/hypothesis.py` | hypothesis → loop → artifacts → decision → measurement 모델 |
| Runtime channel docs | `docs/runtime-channel-map.md` | MCP/webhook/SSE/fakechat의 방향과 사용 조건 명시 |
| External agent guide | `docs/agent-integration-guide.md` | non-Claude Code agent SSE 연결과 send_chat_message 경로 |

### 3.3 구현 상태의 특징

- **제품 범위가 넓다**: API route 269개, FastAPI router 93개, 테스트 파일 591개가 확인됐다.
- **agent orchestration이 기능이 아니라 spine이다**: agent API key, tool ACL, event stream, webhook, fakechat, routing rule, agent run, HITL gate가 모두 별도 축으로 존재한다.
- **기존 PM 기능도 충분히 있다**: board, epics, stories, sprints, standups, retros, meetings, docs, rewards, analytics.
- **권한 경계가 깊다**: API key scope, tool group allowlist, destructive gate, path-level scope enforcement, project access grants가 있다.
- **운영 고려가 있다**: Cloud Run, Cloud SQL, pg_notify direct URL, SSE cap, presence cleanup, monitoring docs가 있다.

## 4. 최신 외부 흐름과 비교

### 4.1 MCP/remote MCP 흐름

MCP는 LLM 앱이 외부 data/tool과 통신하는 표준으로 자리 잡았다. 2025-06-18 spec은 context sharing, tools, composable workflows를 명시하고, Streamable HTTP는 POST/GET와 선택적 SSE를 통해 server-to-client notification을 지원한다. 또한 Origin 검증, auth, localhost binding 같은 보안 요구도 강조한다.

Sprintable의 방향은 이 흐름과 맞다.

- MCP/API key로 tool 호출을 제공한다.
- SSE/webhook/fakechat로 agent inbound를 별도로 제공한다.
- remote hosted MCP dev preview도 README에 있다.
- tool ACL과 destructive gate가 있어 MCP spec의 “tool safety/authorization” 요구와 맞다.

보완점: Streamable HTTP endpoint의 production-readiness, Origin/DNS rebinding 방어, OAuth/enterprise-managed auth 수준의 onboarding은 계속 강화해야 한다. README에 dev preview라고 명시된 것도 타당하다.

### 4.2 Multi-agent interoperability 흐름

Google A2A는 서로 다른 vendor/platform agent가 협업하는 protocol 흐름을 만든다. Sprintable은 A2A 자체를 구현한다기보다 **여러 agent가 공유하는 작업 원장과 라우팅 채널**을 제공한다. A2A가 agent-to-agent protocol이라면 Sprintable은 agent-to-work-system coordination layer다.

이는 경쟁이 아니라 보완 관계다. 장기적으로 A2A adapter를 inbound/outbound 채널 중 하나로 붙일 수 있다.

### 4.3 PM 도구의 AI화 흐름

- Linear는 중앙 호스팅 MCP server로 issue/project/comment를 find/create/update할 수 있게 한다.
- Atlassian/Jira는 Rovo agents와 MCP server/audit/permission control을 제품 안에 넣고 있다.
- GitHub Copilot coding agent는 issue를 assign하면 background에서 작업하고 PR/session log로 추적한다.

즉 시장은 “agent가 업무 시스템에 직접 들어오는 것”을 이미 향하고 있다. Sprintable의 차별점은 다음이다.

| 축 | Linear/Jira/GitHub 흐름 | Sprintable 포지션 |
|---|---|---|
| 기본 객체 | 인간 PM/issue tracker에 AI 기능 추가 | agent/human을 같은 team member로 둔 PM 원장 |
| Agent 작업 단위 | issue, PR, comments | conversation + PM object + event + gate |
| Multi-agent handoff | 외부 automation 또는 제품별 기능 | routing rule + EventBus + thread |
| 실시간 수신 | 제품별 API/MCP/automation | SSE/webhook/fakechat/poll fallback |
| 권한/감사 | enterprise controls 중심 | API key scope, tool ACL, gate, audit trail 직접 구현 |
| BYOA | 보통 vendor/client 의존 | MCP + HTTP로 framework-agnostic 주장 |

## 5. 문제-해결 적합성 평가

### 점수: 8/10

현재 접근은 문제에 잘 맞는다. 특히 “agent를 PM 도구의 부가기능이 아니라 team member로 모델링한다”는 선택은 올바르다. 코드도 이를 따라간다. 단, 제품 메시지와 일부 구현 표면이 아직 넓고 복잡해서 초기 ICP에게 한 문장으로 꽂히는지는 약하다.

### 잘 맞는 이유

1. **문제의 핵심을 정확히 잡았다**  
   단일 agent가 Linear MCP로 issue를 수정하는 문제보다, 여러 agent와 사람이 같은 작업 상태를 공유하고 handoff하는 문제가 더 깊다.

2. **해결방식이 데이터 모델 중심이다**  
   agent message, story status, sprint, gate, audit이 한 DB에 남는다. Slack bot glue보다 복원성과 감사성이 높다.

3. **BYOA 전략이 시기적으로 맞다**  
   Claude Code, Cursor, OpenAI Responses remote MCP, Linear MCP, Atlassian MCP 흐름 때문에 특정 agent vendor에 잠기지 않는 coordination layer 수요가 커진다.

4. **실시간/비동기 agent 실행에 맞다**  
   SSE, webhook, WS fakechat, poll fallback을 모두 제공한다. agent runtime 형태가 제각각인 현실에 맞다.

5. **권한/승인 모델을 먼저 다룬다**  
   MCP tool은 위험하다. Sprintable은 tool ACL, destructive gate, HITL gate, audit trail을 구현하고 있어 enterprise concern과 맞다.

### 맞지 않거나 약한 지점

1. **포지셔닝 드리프트**  
   한국어 README는 “메모 기반 위임”이고 영어 README는 “real-time multi-agent PM platform”이다. 구현은 후자에 더 가깝다.

2. **도구 수/표현 드리프트**  
   README는 70+ tools, `llms-full.txt`는 89 tools, backend catalog는 가설/루프까지 포함한다. agent 제품에서 tool contract 숫자와 설명은 신뢰 요소라 정리해야 한다.

3. **MCP transport 진화 대응 필요**  
   docs는 stdio 중심 설명이 강하고, README는 hosted Streamable HTTP dev preview를 담고 있다. 최신 MCP는 remote/enterprise auth 쪽으로 이동 중이라 production remote MCP contract를 더 선명히 해야 한다.

4. **너무 많은 PM 기능이 핵심 메시지를 흐릴 수 있음**  
   docs, meetings, rewards, retros, loops, hypotheses까지 넓다. 초기 설득은 “multi-agent handoff ledger”에 집중하고 나머지는 proof of depth로 두는 편이 낫다.

5. **A2A와의 관계 미정**  
   A2A가 agent interoperability narrative를 가져가면 Sprintable은 “protocol competitor”가 아니라 “shared work ledger + PM state + gate system”이라고 명확히 해야 한다.

## 6. 가장 적합한 문제 정의 문장

현재 코드와 시장 흐름을 기준으로 한 더 정확한 문제 정의는 다음이다.

> AI coding/product agents can now do real work, but teams lack a shared operating system where humans and multiple agents can receive work, hand off context, update project state, pass approval gates, and leave an auditable trail in real time.

한국어:

> AI 에이전트는 이제 실제 업무를 수행하지만, 사람과 여러 에이전트가 같은 작업 원장 위에서 일을 받고, 맥락을 넘기고, 상태를 바꾸고, 승인을 통과하고, 감사 가능한 기록을 남기는 운영체제가 없다.

## 7. 가장 적합한 해결방안 문장

> Sprintable is the shared PM/event ledger for mixed human-agent teams: agents connect over MCP, receive work over SSE/webhook/chat, act through scoped tools, and every handoff is recorded in conversations, work items, gates, and audit logs.

한국어:

> Sprintable은 사람+AI 에이전트 혼합팀을 위한 PM/Event 원장이다. 에이전트는 MCP로 도구를 쓰고, SSE·웹훅·채팅으로 일을 받으며, 권한이 제한된 도구로 상태를 바꾸고, 모든 핸드오프는 대화·업무 객체·게이트·감사 로그에 남는다.

## 8. 전략 제안

### P1 — 메시지 정렬

- 영어/한국어 README를 같은 포지션으로 맞춘다.
- “memo”는 구현/UX 패턴 중 하나로 내리고, 상위 메시지는 “multi-agent coordination ledger”로 둔다.
- README의 70+ tools, llms 89 tools, backend catalog 숫자를 하나의 표현으로 정리한다. 예: “90+ scoped MCP tools”.

### P1 — ICP를 좁힌다

첫 타깃은 “AI coding agents를 실제 sprint에 투입하는 개발팀”이다. 이유:

- GitHub Copilot coding agent, Claude Code, Cursor, OpenClaw 사용자와 연결된다.
- PR/issue/QA/standup/retro는 Sprintable의 구현과 잘 맞는다.
- Linear/Jira + MCP의 부족한 점을 가장 빨리 체감한다.

### P1 — 차별점을 원장/게이트/실시간으로 고정한다

경쟁 문장은 “Linear has MCP”가 아니라 “Linear remains issue-centric; Sprintable is agent-handoff-centric”여야 한다.

핵심 차별점:

1. agent identity, role, permissions
2. real-time inbound work delivery
3. threaded context reconstruction
4. PM object mutation through scoped MCP tools
5. HITL gates and audit
6. sprint/standup/velocity for mixed teams

### P2 — Remote MCP production contract 강화

- `/mcp` Streamable HTTP production contract를 문서화한다.
- Origin validation, allowed hosts, OAuth/EMA 대응 방향을 명시한다.
- local stdio, hosted HTTP, fakechat, SSE의 관계를 한 장으로 줄인다.

### P2 — A2A adapter는 “후속 확장”으로 둔다

A2A는 지금 당장 core를 바꿀 이유는 아니다. Sprintable의 core는 protocol이 아니라 ledger다. 다만 외부 agent network에서 work item을 주고받는 adapter 후보로 문서화하면 좋다.

## 9. 최종 판단

현재 문제 해결 방식은 적합하다. 특히 다음 전제가 맞다면 강하다.

- 팀은 하나의 AI agent가 아니라 여러 agent를 쓴다.
- agent 결과물을 사람의 승인/리뷰/QA와 엮어야 한다.
- agent 작업이 ephemeral chat이 아니라 audit 가능한 PM state로 남아야 한다.
- 기존 Jira/Linear를 MCP로 조작하는 것만으로는 handoff와 실시간 routing이 부족하다.

반대로 다음 상황에서는 과한 해결책이다.

- 단일 agent가 단순히 Linear/Jira issue를 읽고 수정하면 충분한 팀.
- PM 도구 교체 의지가 없는 enterprise.
- 실시간 agent inbound나 HITL gate가 아직 필요 없는 개인/소규모 사용.

따라서 Sprintable의 적합한 카테고리는 “AI PM tool”보다 좁고 강한 **agent operations / multi-agent project coordination**이다.

## 10. 리서치 출처

- Anthropic, “Introducing the Model Context Protocol”, 2024-11-25: https://www.anthropic.com/news/model-context-protocol
- MCP Specification 2025-06-18: https://modelcontextprotocol.io/specification/2025-06-18
- MCP Transports 2025-06-18: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- MCP Enterprise-Managed Authorization, 2026-06-18: https://blog.modelcontextprotocol.io/posts/enterprise-managed-auth/
- Google Developers Blog, “Announcing the Agent2Agent Protocol”, 2025: https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/
- Linear Docs, “MCP server”: https://linear.app/docs/mcp
- GitHub Blog, “GitHub Copilot: Meet the new coding agent”, 2025-05-19: https://github.blog/news-insights/product-news/github-copilot-meet-the-new-coding-agent/
- GitHub Docs, “Starting GitHub Copilot sessions”: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/start-copilot-sessions
- Atlassian, “Rovo in Jira: AI features”: https://www.atlassian.com/software/jira/ai
- Atlassian Support, “Monitor Atlassian Rovo MCP server activity”: https://support.atlassian.com/security-and-access-policies/docs/monitor-atlassian-rovo-mcp-server-activity/
- OpenAI, “New tools and features in the Responses API”, 2025-05-21: https://openai.com/index/new-tools-and-features-in-the-responses-api/
