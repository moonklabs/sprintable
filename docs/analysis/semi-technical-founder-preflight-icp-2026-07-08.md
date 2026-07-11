# Sprintable 초기 ICP 및 Pre-flight Wedge 결정 메모

작성일: 2026-07-08  
브랜치: `analysis/problem-solution-fit-20260708`  
모드: Office Hours / Product Strategy

## 1. 결정

Sprintable의 첫 ICP는 **세미기술 1인 창업자(semi-technical founder)** 로 잡는다.

초기 제품 포지션은 “AI-native PM tool”이 아니라 다음으로 좁힌다.

> **AI agent로 제품을 만드는 세미기술 founder가, 큰 기능을 실행하기 전에 맥락·계획·시각적 방향·unknowns를 승인하고 작업을 통제하는 pre-flight 원장.**

영문 포지션:

> **Sprintable is a pre-flight control plane for semi-technical founders using AI agents to build real products.**

짧은 메시지:

> **Don’t let agents build the wrong product.**

## 2. 기존 가설에서 바뀐 점

초기 가설은 다음에 가까웠다.

> AI 에이전트가 실제 팀원처럼 일하지만, 기존 PM 도구는 멀티 에이전트 핸드오프, 권한, 실시간 수신, 감사, HITL 승인, sprint/standup/velocity 반영을 한 원장 안에서 관리하지 못한다.

이 문장은 장기 비전으로는 유효하지만, 초기 구매 이유로는 넓다. 더 날카로운 초기 문제는 다음이다.

> **AI agent는 founder의 실행력을 늘려주지만, 큰 제품 작업을 잘못 이해한 채 빠르게 진행하면 2~3일치 자율주행 결과물이 폐기된다.**

따라서 Sprintable은 PM 도구를 대체하기보다, agent 실행 전의 **방향 합의·승인·unknowns 제거**에 집중해야 한다.

## 3. 첫 고객: 세미기술 founder

### 정의

- Claude Code, Codex, Cursor, OpenHands, Hermes류 agent를 직접 사용한다.
- 코드를 전부 깊게 보지는 못하지만 제품 구조와 기술 흐름은 어느 정도 이해한다.
- SaaS/product를 직접 만들고 있거나 MVP를 빠르게 확장 중이다.
- 큰 기능을 agent에게 자연어로 위임한다.
- 하지만 산출물이 기존 제품 방향과 어긋나 rollback/폐기/재기획을 경험한다.
- 문서, TODO, 채팅, agent logs, GitHub issue, 결정사항이 흩어져 통제감이 낮아진다.

### 왜 기술 founder가 첫 시장이 아닌가

기술 founder는 문제를 잘 이해하지만, 한 번 실패한 뒤 스스로 다음 방식으로 적응한다.

- 작업을 작게 쪼갬
- PR 단위를 줄임
- 테스트/리뷰 루프를 강화함
- git/CI/스크립트로 agent를 통제함

즉 강한 design partner는 될 수 있지만, 돈을 내는 pain killer 시장으로는 좁거나 도구화 욕구가 약할 수 있다.

### 왜 비기술 founder가 첫 시장이 아닌가

비기술 founder는 시장 크기는 커 보이지만 초기 제품 고객으로는 위험하다.

- agent plan/code impact를 평가하기 어렵다.
- Sprintable이 control plane을 넘어 사실상 AI CTO/PM 역할까지 해야 한다.
- 제품 범위가 “도구”에서 “managed service”로 커질 수 있다.

따라서 순서는 다음이 적합하다.

1. **세미기술 founder** — 첫 ICP
2. 기술 founder / power user — design partner
3. 비기술 founder — 템플릿·managed experience가 생긴 뒤 확장

## 4. 초기 use case

가장 강한 초기 use case는 다음이다.

> **Brownfield 제품에 대규모 신규 기능을 추가하기 전, agent가 잘못된 방향으로 구현하지 못하게 막는 pre-flight gate.**

이 use case가 강한 이유:

- 기존 코드/UX/데이터/권한 맥락을 잘못 이해하면 결과가 크게 틀어진다.
- 잘못된 신규 기능은 단순 코드 폐기가 아니라 제품 방향 폐기다.
- founder는 모든 코드를 리뷰하지 못해도 방향·UX·영향 범위는 승인할 수 있다.
- agent가 가장 위험한 순간은 “기존 시스템 위에 큰 기능을 자율 설계할 때”다.

## 5. 핵심 제품 단위: Pre-flight Packet

Founder가 큰 작업을 지시하면 Sprintable은 agent가 바로 구현하지 못하게 하고 먼저 **Pre-flight Packet**을 만든다.

필수 구성:

1. **Founder intent 해석**
   - agent가 이해한 목표
   - 해결하려는 사용자 문제
   - 성공 기준

2. **Existing system map**
   - 영향을 받는 기존 화면
   - API / DB / auth / workflow
   - 기존 UX와 충돌 가능성이 있는 지점

3. **3~4개 low-fidelity visual direction**
   - 실제 구현 시안일 필요는 없다.
   - 실행 전 방향 합의를 위한 report image, wireframe, flow image면 충분하다.

4. **Change impact report**
   - 바뀔 가능성이 높은 모듈/파일/데이터 모델/권한
   - migration 또는 API contract 영향

5. **Known unknowns**
   - 지금 명시적으로 확인해야 하는 질문

6. **Suspected unknown unknowns**
   - agent가 놓칠 수 있는 리스크 후보
   - 예: 기존 UX 충돌, 권한 누락, 데이터 무결성, 성능, migration, edge case

7. **Decision gates**
   - founder가 승인해야 하는 선택지
   - 승인된 방향 / 금지된 방향 / 보류된 결정

8. **Execution contract**
   - agent가 해도 되는 일
   - 하지 말아야 하는 일
   - 중간 승인 없이 넘어가면 안 되는 지점

## 6. MVP 범위

초기 MVP는 세 가지에 집중한다.

### 6.1 Context Inbox

흩어진 입력을 모은다.

- founder instruction
- 기존 문서
- TODO
- GitHub issue / PR 요약
- agent 대화 로그
- 제품 아이디어 / 결정 메모

중요: “문서 관리”가 아니라 **실행 가능한 agent 작업 맥락으로 변환하기 위한 inbox**여야 한다.

### 6.2 Pre-flight Packet Generator

수집된 맥락을 실행 전 승인 가능한 형태로 바꾼다.

- 목표 재해석
- 작업 분해
- 기존 시스템 영향 분석
- low-fi visual direction 생성
- unknowns 도출
- decision points 생성

### 6.3 Founder Approval Gate

승인 전에는 agent execution으로 넘어가지 않는다.

- approve / request changes / reject
- 승인된 방향 기록
- 금지된 방향 기록
- 실행 중 새 decision point 발생 시 pause
- 결정/학습/변경사항 ledger화

## 7. 하지 말아야 할 것

초기에는 다음을 메인 메시지로 삼지 않는다.

- 범용 PM tool
- Jira/Linear 대체
- 팀 전체 sprint velocity 관리
- 모든 agent 작업 추적
- 완전한 비기술 founder용 AI CTO
- 모든 작업에 무거운 시각 보고서 강제

특히 “흩어진 문서와 할일을 모아준다”는 메시지는 Notion, Linear, Asana, ClickUp과 겹친다. 핵심 메시지는 다음이어야 한다.

> **Scattered context in, approved agent execution out.**

## 8. 시장 적합성 판단

### 긍정 신호

- Agent가 실제 작업을 수행하는 흐름은 이미 주류화되고 있다.
- MCP는 도구/맥락 연결 표준으로 자리 잡고 있으며, Sprintable의 agent tool/permission/ledger 구조와 방향이 맞다.
- GitHub Copilot coding agent처럼 issue를 받아 background에서 작업하고 PR을 만드는 흐름은 “agent에게 실제 업무를 맡기는” 방향을 강화한다.
- Linear/Jira는 AI 기능과 MCP 연결을 제공하지만, founder가 agent 실행 전 방향·unknowns·시각적 결과를 승인하는 pre-flight 제품은 아직 명확한 카테고리가 아니다.

### 부정/위험 신호

- 이 pain은 아직 대중적이지 않고 early adopter pain일 가능성이 높다.
- 개발자는 자체 workflow 개선으로 해결할 수 있다.
- 비기술 founder에게 바로 가면 제품이 너무 넓어진다.
- “PM 도구”로 포지셔닝하면 기존 도구와 정면충돌하고 차별점이 흐려진다.

### 결론

세미기술 founder를 첫 ICP로 잡고, brownfield large-feature pre-flight를 wedge로 삼으면 **시장에 내놓을 만한 제품 가설**이다.

단, 성공 조건은 PM 기능의 완성도가 아니라 다음 한 문장에 대한 반응이다.

> “AI agent에게 큰 기능을 맡겼다가 며칠 날린 적 있나요? Sprintable은 실행 전에 plan, visual direction, code impact, unknowns를 승인받게 해서 그 rollback을 막습니다.”

## 9. 검증 계획

### 9.1 인터뷰 대상

- Claude Code/Codex/Cursor를 실제로 써본 세미기술 founder 10명
- AI coding agent로 SaaS/MVP를 만드는 1인 창업자
- agent에게 큰 기능을 맡겼다가 rollback한 경험이 있는 사람

### 9.2 핵심 질문

1. 최근 30일 안에 agent가 잘못된 방향으로 작업해서 버린 결과물이 있는가?
2. 그 폐기 비용은 며칠/몇 달러/몇 PR/몇 feature였는가?
3. 그 문제를 지금 어떻게 막고 있는가?
4. 실행 전에 어떤 정보를 봤다면 막을 수 있었는가?
5. low-fi visual direction 3~4개가 도움이 되는가?
6. unknowns/decision gates가 있으면 승인 판단이 쉬워지는가?
7. 이 문제를 해결하기 위해 월 얼마를 낼 수 있는가?

### 9.3 Smoke test 문구

- “Stop agents from shipping the wrong feature into your existing product.”
- “Pre-flight approval for AI agents working in brownfield codebases.”
- “Don’t let agents build the wrong product.”
- “Turn scattered founder context into approved agent execution plans.”

### 9.4 성공 기준

초기 신호:

- 10명 중 5명 이상이 유사 rollback 경험을 말한다.
- 10명 중 3명 이상이 “지금 써보고 싶다”고 말한다.
- 2명 이상이 실제 agent 작업 지시문/문서/레포를 연결해 테스트하려 한다.
- 적어도 1명은 유료 pilot 의향을 보인다.

실패 신호:

- 대부분이 “그냥 작업을 작게 쪼개면 된다”고 말한다.
- 폐기 비용이 작고 반복성이 없다.
- visual pre-flight보다 prompt template/checklist만으로 충분하다고 말한다.
- founder가 승인해야 할 decision points를 구체적으로 말하지 못한다.

## 10. 외부 흐름과의 정합성

- Anthropic은 MCP를 AI 시스템과 외부 데이터/도구를 연결하는 표준으로 소개하며, fragmented integrations 문제를 해결하려는 방향을 제시한다.
- MCP 2025-06-18 specification은 tools/resources/prompts, progress/cancellation/logging, 사용자 동의·권한·tool safety를 강조한다.
- GitHub Copilot coding agent는 issue를 위임받아 background에서 작업하고 PR을 생성하는 흐름을 제품화했다. 이는 agent에게 실제 업무를 맡기는 시장 흐름을 뒷받침한다.
- Linear MCP는 AI 도구가 Linear issue/project/comment를 조회·생성·수정하게 한다. 이는 PM 도구가 agent interface를 붙이는 흐름이다.
- Atlassian Jira AI/Rovo는 Jira 안의 업무 맥락과 AI agent를 연결한다. 이는 기존 PM 도구들이 AI-native workflow로 확장 중임을 보여준다.

Sprintable의 차별점은 이들과 정면 경쟁하는 것이 아니라, **세미기술 founder가 agent 실행 전에 방향·시각 결과·unknowns·권한을 승인하는 pre-flight layer**에 집중하는 것이다.

## 11. 다음 제품 원칙

1. PM 객체보다 **execution prevention**이 먼저다.
2. 문서 저장보다 **approved execution contract**가 먼저다.
3. agent 생산성보다 **wrong-direction rollback 방지**가 먼저다.
4. 모든 작업 추적보다 **큰 brownfield feature gate**가 먼저다.
5. 기술 founder용 power tool보다 **세미기술 founder의 통제감 회복**이 먼저다.

## 12. 한 줄 결론

Sprintable은 첫 시장을 **세미기술 founder**로 좁히고, 첫 제품을 **brownfield large-feature pre-flight gate**로 좁힐 때 가장 시장에 내놓기 적합하다.

## 참고 출처

- Anthropic, “Introducing the Model Context Protocol” — https://www.anthropic.com/news/model-context-protocol
- Model Context Protocol Specification 2025-06-18 — https://modelcontextprotocol.io/specification/2025-06-18
- GitHub Blog, “GitHub Copilot: Meet the new coding agent” — https://github.blog/news-insights/product-news/github-copilot-meet-the-new-coding-agent/
- Linear Docs, “MCP server” — https://linear.app/docs/mcp
- Atlassian, “Rovo in Jira: AI features” — https://www.atlassian.com/software/jira/ai
