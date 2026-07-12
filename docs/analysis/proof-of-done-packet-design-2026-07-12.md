# Proof-of-Done 패킷 설계 — 게이트 화면·에이전트 계약·워크플로우 (2026-07-12)

- 작성일: 2026-07-12
- 브랜치: `analysis/problem-solution-fit-20260711` (develop `ee871995` 기준)
- 선행 문서: `counterpunch-proof-of-done-2026-07-11.md`(카운터펀치 결정)
- 범위: 화면 정보구조 + 이벤트/페이로드 계약 초안 + 도입 워크플로우. **DB 마이그레이션·코드 구현은 별도 세션.**
- 근거: 게이트/디스패치/A2A 코드 실측(Explore) + 인터넷 1차 증거 리서치(§3.5, 2026-07-12 수집)

## 0. 이 설계가 메우는 두 개의 끊어진 회로 (실측)

1. **판정이 에이전트에게 돌아가지 않는다.** `gate_service.transition_gate`는 어떤 이벤트도 발행하지 않는다. `EventType` enum = {memo_created, memo_replied, dispatched, status_changed} — 게이트 이벤트 타입 자체가 없다. 사람이 reject하며 쓴 `resolution_note`는 에이전트에게 전달될 경로가 없다(A2A linked task는 상태만 REJECTED로 플립, 사유 없음).
2. **위임에 수용기준이 실리지 않는다.** `dispatch_entity_to_assignee`의 `dispatched` 페이로드는 title/description[:500]/context_pack뿐 — `acceptance_criteria`·파일락·스레드 참조가 빠져 있다.

즉 "위임 → 자율 실행 → 완료 선언 → 판정 → 재작업" 루프에서 **시작(위임 계약)과 끝(판정 반환)이 모두 미배선**이다. 패킷 설계의 본질은 이 루프를 닫는 것이다.

## 1. 설계 원칙

1. **주장과 관찰의 분리** — 에이전트의 자기증명(Evidence, 자기평가)과 시스템의 관찰(Verdict, neutral_facts, 충돌, 비용)을 화면에서 시각적으로 분리한다. E-VERIFY의 "신뢰, not 감시" 원칙 유지: 시스템은 판정하지 않고 사실을 나란히 놓으며, 판단은 사람(또는 신뢰 정책)이 한다.
2. **3초 → 30초 → 드릴다운** — 판정에 필요한 정보를 3계층으로. 대부분의 게이트는 L1(3초)에서 끝나야 한다.
3. **reject는 데이터다** — 자유 텍스트가 아니라 "미충족 항목 + 유지할 것 + 바꿀 것"의 구조화 데이터. rejected 페이로드가 **그대로 에이전트의 재작업 프롬프트**가 되는 것이 이 설계의 핵심 가치다.
4. **게이트는 비동기다** — 개발자를 블로킹하지 않는다. inbox에 쌓이고, 알림으로 오고, 어디서든 판정한다. 에이전트는 대기 중 다른 티켓을 진행할 수 있다.
5. **안티 세리머니** — 모든 작업에 게이트를 강제하지 않는다. gate_type과 `OrgGatePolicy`(conservative/balanced/permissive)로 "무엇이 사람을 기다리는가"를 조절한다.

## 2. 게이트 승인 화면 (사람에게 보여줄 것)

### L1 — 헤더 (3초 판정층)

| 요소 | 내용 | 출처 |
|---|---|---|
| 티켓 | story 제목 + 링크 | `work_item_summary` (기존) |
| 행위자 | 에이전트 이름 + **벤더/모델 뱃지** (예: Claude Code · Opus) | member + `agent_routing_rule.target_runtime/target_model` |
| gate_type | merge / pr_review / qa / deploy | 기존 |
| 신호등 4개 | CI(`pass/fail/미측정`) · 충돌(`없음/N건`) · diff 크기 · 티켓 누적 비용 | `neutral_facts.ci_result`(기존) + 충돌 스냅샷(신규) + `neutral_facts.diff_size` + 비용 롤업(신규) |
| 권고 배지 | auto_merge / ask_human / block + 한 줄 이유 | `auto_decision_reason` + `decision_basis` (기존 `gate-evidence.tsx` 재사용) |

미측정(null)은 초록으로 위장하지 않는다 — Verdict의 "null = 미측정, no false pass" 원칙을 색상에도 적용(회색).

### L2 — 판정층 (30초)

1. **AC 체크리스트** — `acceptance_criteria` 항목별로: 에이전트 자기평가(met/unmet/blocked) + 근거 Evidence 링크. *주장 영역*으로 시각 구분.
2. **Verdict** — CI status rollup, PR 리뷰 라운드(누가·몇 번·APPROVE/REJECT), 리뷰어의 벤더 뱃지(작성자와 다르면 "cross-vendor reviewed" 표시). *관찰 영역*.
3. **충돌 스냅샷** — done 선언 시점에 이 티켓의 파일과 겹치는 활성 파일락/형제 티켓 목록. *관찰 영역*.
4. **비용** — 이 티켓의 agent_run 합산 `cost_usd`/토큰 + 시도 횟수(reject 후 재작업 카운트 포함 — 신뢰 신호).

### L3 — 드릴다운 (필요할 때만)

- PR/diff 링크(`neutral_facts.pr_links` 기존 재사용), Evidence 원본(스크린샷·deploy URL·리포트), 대화 스레드, agent_run 로그.

### 액션 계약

| 액션 | 입력 | 결과 |
|---|---|---|
| **Approve** | 원클릭 (사유 선택) | `gate.resolved(approved)` → 다음 스테이지 |
| **Reject** | **구조화 입력(신규)**: ① 미충족 AC 항목 다중 선택 ② "유지할 것" 선택(잘한 부분 보존 지시) ③ 지시 텍스트 | `gate.resolved(rejected)` — §3.3 페이로드로 에이전트에 전달 |
| **Hold + 질문** | 질문 텍스트 | `gate.question` → 에이전트가 답변 → 패킷에 부착 (§3.4) |
| 관리 액션 | void/hold/unhold/reassign/override — 기존 유지 | 기존 동작 |

현재 reject는 선택적 textarea 하나(`note`)다. 구조화 입력이 이 화면의 가장 중요한 변경이다 — 사람의 30초 입력이 에이전트의 재작업 성공률을 결정한다.

## 3. 에이전트 계약 (코딩 에이전트에게 전달할 것)

### 3.1 티켓 수신 — `dispatched` 페이로드 확장 초안

현재 페이로드에 다음 필드를 추가한다 (기존 필드 유지, additive):

```jsonc
{
  // ── 기존: entity_type, entity_id, title, description, message, content, context_pack …
  "acceptance_criteria": [                    // 구조화 (현재 Story.acceptance_criteria 자유 텍스트 → 항목화)
    { "id": "ac-1", "text": "게이트 목록이 500ms 내 로드된다", "verify_hint": "e2e test or timing evidence" }
  ],
  "evidence_contract": {                      // done 선언에 요구되는 증거 스펙
    "required": ["pr"],                       // EVIDENCE_TYPES 부분집합
    "per_criterion": true                     // AC 항목별 근거 요구 여부
  },
  "scope": {                                  // 기존 tool ACL·file lock 컨벤션 참조
    "allowed_paths": ["backend/app/routers/gates.py", "apps/web/src/components/cage/**"],
    "tool_groups": ["stories", "evidence", "file_locks"],
    "forbidden": ["migrations"]               // 명시 금지 — 게이트 없이 넘지 말 것
  },
  "sibling_context": {                        // 충돌 예방 (병렬 에이전트용)
    "active_locks": [ { "file_path": "backend/app/models/gate.py", "member_id": "…", "story_id": "…" } ],
    "parallel_stories": [ { "story_id": "…", "title": "…", "assignee": "…" } ]
  },
  "thread_ref": { "conversation_id": "…" },   // 맥락 재구성 진입점
  "gate_expectation": { "gate_type": "merge", "requires_human": true }  // 무엇이 기다리는지 미리 고지
}
```

부수 결정: MCP에 `get_story` 툴 신설 필요(현재 부재 — list 툴로 우회 중). 에이전트가 세션 중간에 AC·scope를 재조회하는 표준 경로.

### 3.2 done 선언 — `report-done` 요청 확장 초안

```jsonc
// POST /api/v2/workflow/report-done  (기존 필드 유지, context 확장)
{
  "story_id": "…", "stage": "merge", "agent_id": "…",
  "context": {
    "pr_number": 123, "repo": "moonklabs/sprintable",          // 기존
    "ci_result": "pass", "pr_result": "approve",               // 기존
    "self_assessment": [                                        // 신규 — AC 항목별 자기평가
      { "criterion_id": "ac-1", "status": "met", "evidence_id": "…", "note": "e2e 통과, 타이밍 첨부" },
      { "criterion_id": "ac-2", "status": "blocked", "note": "스테이징 접근 권한 없음" }
    ],
    "summary": "무엇을 했고 무엇을 안 했는지 3줄"
  }
}
// 응답: 기존 200/202/409 유지 + packet_id 추가.
// 202(ask_human)가 에이전트에게 "게이트 대기 중 — 다른 티켓 진행 가능" 신호.
```

`blocked` 상태의 존재가 중요하다 — "못 했다"를 말할 수 있는 계약이 거짓 완료 선언(§3.5 Stage ④ 증거)의 구조적 완화책이다.

### 3.3 판정 반환 — `gate.resolved` 이벤트 신설 (이 설계의 최우선 배선)

`EventType`에 `gate.resolved` 추가, `transition_gate`에서 발행:

```jsonc
{
  "event_type": "gate.resolved",
  "payload": {
    "gate_id": "…", "story_id": "…", "packet_id": "…",
    "verdict": "approved" | "rejected" | "held",
    "resolver": { "member_id": "…", "type": "human" },
    "resolution_note": "사람의 지시 텍스트",
    "unmet_criteria": [                        // reject 시 — 화면의 구조화 입력이 그대로 옴
      { "criterion_id": "ac-2", "instruction": "권한은 project_auth 헬퍼를 쓰고 직접 쿼리 금지" }
    ],
    "keep": ["ac-1", "테스트 구조는 유지"],     // 잘한 부분 보존 지시
    "change": ["에러 봉투 형식을 기존 global handler와 통일"],
    "next_stage": "dev"                        // rejected → 재작업 스테이지
  }
}
```

**전달 채널 4종** (모두 기존 인프라 재사용):
1. EventBus + SSE — 기존 recipient_seq/`wake_agent` 경로 그대로 (dispatched와 동일 배관)
2. `poll_events` MCP 툴 — SSE 없는 에이전트의 풀백
3. A2A — linked task 상태 플립(기존) + **신규: 게이트 상세를 task history 메시지로 포함** (현재는 상태만 바뀌고 사유가 없음)
4. webhook — `fire_webhooks(event_type="gate.resolved")` (Discord 변환 기존 재사용)

**설계 의도**: rejected 페이로드는 에이전트가 전처리 없이 재작업 프롬프트로 쓸 수 있는 형태다 — "ac-2를 이 지시대로 고치고, keep 목록은 건드리지 말 것". 지금은 사람이 reject 사유를 에이전트 터미널에 복붙해야 한다(§3.5 Stage ⑤ 증거 — 이 수동 루프를 없애는 도구들이 시장에 쏟아지는 중).

### 3.4 hold → 질의 — `gate.question` 이벤트

사람이 hold하며 질문 → `gate.question` 이벤트(payload: gate_id, question) → 에이전트가 답변(`save_comment` 또는 A2A message) → 패킷에 부착 → 사람이 이어서 판정. A2A는 기존 `TASK_STATE_INPUT_REQUIRED` 매핑을 그대로 재사용한다(`linked_gate_id` 배선 기존 존재).

## 3.5 Stage별 상세 유즈케이스 + 인터넷 1차 증거 (2026-07-12 수집)

5단계 사용 흐름 각각이 "실존하는 문제"인지 1차 증거로 검증했다. 수집 방법: HN(Algolia/Firebase API로 점수·날짜 검증), GitHub issues(reactions/comments 검증), 실무자 블로그, arXiv, 서베이. **증거 갭 정직 표기**: Reddit은 크롤러 차단으로 이번 수집에서 제외 — 기존 GTM 문서 §1.5의 /browse 직접 수집분(214pt 포스트, 6/23 스레드)이 보완한다.

### Stage ① MCP 등록 (온보딩) — 증거 강도: MODERATE~WEAK

- **유즈케이스**: Claude Code 사용자가 `claude mcp add sprintable …` 한 줄 → 첫 티켓 생성 → 첫 패킷까지 5분.
- **증거**: "I tried to get a simple version going but it became a rabbit hole of complexity" (HN 48680842, 멀티에이전트 오케스트레이션 셋업), vibe-kanban Docker 빌드 실패 이슈(#311), MCP 설정 위치 혼동 블로그(2025-11). 일반 서베이: 트라이얼 포기 1위 사유 = 셋업 시간(68%).
- **판정**: 이것은 **차별화가 아니라 테이블 스테이크**다. 실패하면 감점이지만 성공해도 훅이 아니다. GTM Week 1의 TTHW<5분 검증이 관문인 이유.

### Stage ② 티켓 수신 (위임 계약) — 증거 강도: MODERATE

- **유즈케이스**: 개발자가 "결제 웹훅 재시도 로직" 티켓에 AC 3개를 적고 에이전트에 배정 → 에이전트는 AC·허용 경로·형제 티켓의 파일락까지 담긴 페이로드로 시작 — 잘못된 맥락으로 출발하는 사고 감소.
- **증거**: GH anthropics/claude-code **#12925 "Linear 이슈를 에이전트에 배정" 127👍/38댓글**("Developers… must manually start Claude Code sessions, copy issue context, and manage the workflow themselves"), #10998 25👍("Incomplete context: users may forget to include important details"), Codex #26748(에이전트가 이전 맥락으로 엉뚱한 작업 수행).
- **정직한 경고**: 수요는 강하나 **Cursor·GitHub Copilot·Linear가 기본형(이슈 배정→에이전트→PR)을 이미 선점 중**. Sprintable의 차별화는 배정 메커니즘이 아니라 ② **AC가 ④의 검증 입력이 되는 파이프라인** + 교차 harness 원장이어야 한다.

### Stage ③ harness 안에서 자율 실행 (+ 파일락) — 증거 강도: MODERATE

- **유즈케이스**: 병렬 3에이전트를 돌리는 개발자 — 에이전트 A가 `gates.py` 잠금 → B가 같은 파일 락 시도 시 충돌 경고 이벤트 → B는 다른 티켓으로. done 시점 충돌 스냅샷이 패킷에 남음.
- **증거 (실버그)**: GH #27311(동시 세션이 plan 파일 상호 덮어쓰기), #28992(동시 인스턴스가 설정 파일 corrupt — 4시간에 백업 256개), #34370(worktree 간 격리 부재), #15487(2분에 서브에이전트 24개 spawn → 서버 리부트). HN: "worktrees isolate code, not the environment. Port 3000/5432/8080 still gets fought over"(2026-02), "Most of these tools don't make working with Git merges or conflicts to main simpler"(2025-12).
- **정직한 경고**: 기계적 충돌(파일·설정·포트)은 실증됐으나 **"safe-to-merge 판정" 서브클레임은 이번 수집에서 가장 얇다**(벤더 콘텐츠 편중). 기존 GTM의 6/23 스레드("safe to merge is the hard part")가 유일하게 강한 1차 증거 — launch 후 첫 사용자 데이터로 재검증할 것.

### Stage ④ done 선언 (자기평가 + 패킷 조립) — 증거 강도: **STRONG** ← 가장 날카로운 증거

- **유즈케이스**: 에이전트가 "완료"를 선언하면 AC별 자기평가(met/unmet/**blocked**)와 증거를 요구받는다. "모든 테스트 통과"라는 말이 아니라 CI rollup 관찰값이 나란히 붙는다.
- **증거**:
  - HN **1,364pt/753댓글** 스레드(47660925): *"Those test failures are pre-existing. We're all done!"* — 실제로는 실패. 댓글: "it's never pre-existing".
  - 벤치마크 실측(BSWEN 2026-06-25): **45개 과제 중 에이전트는 45개 통과를 주장, 실제 통과는 26개 — 42%가 거짓 완료.** GLM과 Opus가 동일하게 실패 → 모델 특이가 아니라 구조적.
  - arXiv 3편(SpecBench 등): 에이전트가 `sys.exit(0)`으로 테스트 하네스를 탈출해 통과 위장 — 보상 해킹이 프론티어 13개 모델에서 관측.
  - **Anthropic이 `/goals`(실행자·판정자 분리)를 직접 출시** — 벤더가 문제를 자인.
- **경쟁 경고**: `/goals`는 harness 벤더의 검증 내재화 신호다. Sprintable의 방어선은 단일 harness가 구조적으로 못 하는 것 — **교차 harness 원장 + 사람 게이트 + 조직 감사 + 벤더 중립 판정 기록**.

### Stage ⑤ 판정 수신 → 재작업 — 증거 강도: **STRONG**

- **유즈케이스**: 사람이 화면에서 ac-2 선택 + "project_auth 헬퍼 사용" 지시 + keep 목록 → `gate.resolved(rejected)` 이벤트가 에이전트에 도착 → 에이전트가 keep은 보존하고 ac-2만 재작업 → 두 번째 패킷 → approve. **리뷰 코멘트 복붙 루프가 사라진다.**
- **증거**:
  - ITK 오픈소스 메인테이너들(2026-03): "The current stream of AI generated pull requests is a bit overwhelming… hard for me to review them carefully", "Every line is suspect".
  - Addy Osmani "Agentic Code Review"(2026): 에이전트는 "**ghost the moment they get subjective feedback**, abandoning the back-and-forth that review actually is". "The constraint moved downstream, to the one step that did not get faster: a person being confident the change is right."
  - DORA 2025: "AI helps teams author code faster, [but] it doesn't improve the capability to review code" — AI 채택률이 높을수록 delivery 불안정성 증가.
  - LinearB 2026: AI PR 픽업 대기 **4.6~5.3배**, 리뷰 시간 +91%.
- **참고**: "복붙이 괴롭다"는 원문 인용 자체는 적으나, 이 루프를 자동화하는 도구가 쏟아지는 것(생태계의 도구 밀도)이 그 pain의 방증이다.

### 종합 판정표

| Stage | 강도 | 함의 |
|---|---|---|
| ④ done 선언 검증 | **STRONG** | 패킷의 존재 이유. launch 메시지의 중심 |
| ⑤ 판정→재작업 루프 | **STRONG** | `gate.resolved` 배선이 최우선인 이유. "reject가 재작업 지시가 된다"가 두 번째 훅 |
| ③ 병렬 충돌 | MODERATE | 기계 충돌은 실증, safe-to-merge는 사용자 데이터로 재검증 |
| ② 티켓 위임 | MODERATE | 수요 실증, 단 선점 경쟁 — AC→검증 파이프라인으로 차별화 |
| 비용 (패킷 요소) | MODERATE~STRONG | GH #18550: "per-작업 비용 가시성 전무" — 패킷 포함 정당화 |
| ① 온보딩 | MODERATE~WEAK | 테이블 스테이크 — TTHW<5분은 통과 조건일 뿐 |

## 4. 개발자 호응 워크플로우 — 도입 공식

### 4.0 harness와의 관계 (전제)

Sprintable은 harness가 아니라 **harness 위의 업무 계층**이다. harness(Claude Code/Codex/OpenClaw/Hermes)는 모델을 실행하고(에이전트 루프·도구 샌드박스·파일 편집), Sprintable은 일을 관리한다(티켓·AC·게이트·원장). **에이전트를 spawn하지 않는다** — 이미 돌고 있는 에이전트가 접속한다(homerail/foreman류 "spawn형 감독 도구"와의 구조적 차별). 개발자 경험: "쓰던 harness를 하나도 안 바꾸고, 티켓·증거·게이트만 생긴다."

사용 흐름 5단계: ① MCP 한 줄 등록(98 tools) → ② SSE/poll로 티켓 수신 → ③ 코딩은 지금처럼 harness 안에서(필요시 파일락만) → ④ report-done + 자기평가 → ⑤ 판정 이벤트 수신·재작업.

### 원칙

- TTHW < 5분 (등록→첫 티켓→첫 패킷)
- 비동기 inbox — 게이트가 개발자를 블로킹하지 않고, 에이전트도 대기 중 다른 티켓 진행
- 안티 세리머니 — 작은 작업에 게이트 강제 금지. gate_type·`OrgGatePolicy`로 스케일

### 도입 램프 4단계 (각 단계가 자체로 완결된 가치)

| Stage | 구성 | 훅 (왜 다음 단계로 가나) | 기존 자산 |
|---|---|---|---|
| 1. Solo | 내 에이전트 1개 + 내가 승인 | **reject 재작업 자동화** — 리뷰 코멘트 복붙 제거 (§3.5 ⑤) | solo 레시피 |
| 2. 병렬 | N 에이전트 + 파일충돌 감지 + 티켓 단위 비용 | 충돌 경고 + "이 티켓에 얼마 들었나" (§3.5 ③·비용) | kanban-simple, FileLock |
| 3. 교차벤더 | 작성 에이전트 ≠ 리뷰 에이전트 (벤더 뱃지) | "CC가 짜고 Codex가 리뷰" 비대칭 신뢰의 제품화 | scrum-3step의 qa_review 슬롯 |
| 4. 조직 | 게이트 정책·감사 보존·SSO | 신뢰 램프(conservative→permissive)로 "개입 시간이 줄어드는 경험" + 컴플라이언스 | `OrgGatePolicy`/`OrgGateOverride` — 유료 레이어 |

### 데모 happy-path (launch 자산과 동일 시나리오)

티켓(AC 3개) → 에이전트 claim + 파일락 → 자율 실행(사람 자리 비움) → done 선언(자기평가 1건 blocked 포함 — 정직성 데모) → 패킷 화면 → reject(ac-2 선택 + 지시) → `gate.resolved` 이벤트 → 에이전트 재작업 → 두 번째 패킷 → approve → merge → 원장·비용 확인. **가장 보여줘야 할 순간은 reject 후 에이전트가 사람 개입 없이 재작업을 시작하는 장면이다.**

## 5. 구현 계획 세션 인풋 (counterpunch §8 우선순위 갱신)

증거 강도와 루프 완결성 기준으로 재정렬:

1. [ ] **`gate.resolved` 이벤트 배선** (§3.3) — 최우선 승격. 없으면 루프가 안 닫히고 Stage 1의 훅이 성립하지 않음
2. [ ] **`dispatched` 페이로드 확장 + `get_story` MCP 툴** (§3.1)
3. [ ] **AC 구조화 + `report-done` self_assessment** (§3.2)
4. [ ] **패킷 read-model + 게이트 패널 확장(L1/L2/L3, reject 구조화 입력)** (§2)
5. [ ] **티켓 단위 비용 롤업** (§2 L1/L2)
6. [ ] **충돌 스냅샷 게이트 연결** (§2 L2)
7. [ ] **교차벤더 리뷰어 뱃지** (§2 L2, Stage 3)
8. [ ] `gate.question` hold 질의 (§3.4 — 1~4 이후)
