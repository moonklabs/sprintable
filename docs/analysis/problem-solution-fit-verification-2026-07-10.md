# Sprintable 문제-해결 적합성 재검증 (2026-07-10)

- 작성일: 2026-07-10
- 브랜치: `analysis/problem-solution-fit-20260708`
- 검증 대상: `problem-solution-fit-2026-07-08.md`(적합성 8/10), `semi-technical-founder-preflight-icp-2026-07-08.md`(pre-flight wedge 결정)
- 방법: 4개 독립 분석 — ① 코드베이스 사실 검증(런타임 카운트 포함), ② origin/main·develop 드리프트 추적, ③ 2026-07 시장 리서치, ④ 적대적 비평
- 주의: 이 분석 브랜치의 HEAD(`9602d73b`)는 origin/main보다 약 100커밋 뒤처져 있음. 2026-07-09 promote로 main이 크게 이동했다.

## 1. 결론 (수정 판정)

**문제 인식은 시장이 검증해줬다. 그러나 해결 방식의 적합성은 7/8 문서의 8/10에서 하향해야 한다.**

- **방향 정합성: 8/10 유지** — "agent를 팀원으로 모델링 + HITL gate + 감사 원장"과 "실행 전 승인(pre-flight)" 둘 다 2026년 상반기 업계 메가트렌드와 일치한다. A2A를 core로 구현한 것도 (7/8 문서의 P2 판단과 달리) 시장 속도에 맞는 선택이었다.
- **실행 적합성: 4/10** — 세 가지 구조적 부적합이 확인됐다.
  1. **포지션 4개 동시 존재**: 4월 전략(한국 OSS PM, Plane 대항) / 7-8 문서①(multi-agent coordination ledger) / 7-8 문서②(semi-technical founder pre-flight gate) / 실제 main 코드(다직군 agent workforce 채용 + A2A). 문서와 코드가 서로 다른 제품을 향해 가고 있다.
  2. **검증 없는 표면 확장**: 고객 인터뷰 0건 상태에서 MCP tool 95개, route 419개, "~300직군 카탈로그 트랙"으로 표면이 계속 커진다. 최근 main 커밋의 CRITICAL 보안 hotfix 2건(cross-org IDOR, caller-ownership)은 이 표면이 1인 운영에서 이미 부채임을 보여준다.
  3. **wedge 개념 미구현 + 반대 방향 인프라**: pre-flight packet/context inbox/visual direction은 코드에 전무하고, 기존 gate/HITL은 post-work 승인(merge/pr_review/qa/deploy)이라 pre-execution gate와 상태기계 방향이 반대다.

## 2. 사실 검증 결과 (7/8 문서 대비)

| 7/8 문서 주장 | 실측 (동일 커밋 `9602d73b`) | 판정 |
|---|---|---|
| FastAPI router ~93개 | router 파일 93개, include_router 96회 | 참 |
| API route ~269개 | 런타임 로드 실측 419 operations / 321 unique paths | **거짓(과소집계)** |
| 테스트 파일 ~591개 | 596개 (backend 407 + web 178 + packages 11) | 참 (±1%) |
| MCP tool: README "70+", llms-full.txt "89" | `_TOOL_DEFS` 런타임 실측 **95개** | **둘 다 stale** — 세 숫자가 다 다름 |
| README.ko = "메모 기반 위임" 포지션 잔존 | README.ko.md 1~10행 확인 — 영문판과 완전히 다른 제품 설명 | 참 (드리프트 실재) |
| 핵심 모듈 8개(agent_gateway, pg_pubsub, gate, hitl, loop, hypothesis, conversation, pm) | 전부 존재 | 참 |
| "A2A는 P2 후속 확장으로 둔다" | **무효화** — E-A2A-완성 에픽 17커밋이 이미 main에 병합됨 (AgentCard, SendMessage/StreamingMessage SSE, WORKING→COMPLETED 상태기계, linked_gate HITL 연동, 0158/0159 마이그레이션) | **문서가 코드 현실보다 뒤처짐** |

기타: TS `packages/mcp-server`는 퇴역 커밋 이후에도 dist 산출물이 리포에 남아 있음(청소 대상). 실제 MCP 서버는 `backend/sprintable_mcp`(Python)로 이전 완료.

## 3. main 이동 내역 (7/9 promote 이후) — 문서에 없는 제4의 방향

`origin/main..origin/develop`은 이제 A2A HITL 세부 4커밋뿐이다. 즉 아래는 전부 **main에 이미 편입된, 회사가 커밋한 제품 방향**이다.

- **A2A 프로토콜 스펙 준수 서버**: `backend/app/routers/a2a.py` + `schemas/a2a.py` — JSON-RPC 엔드포인트, AgentCard, GetTask/ListTasks, TASK_STATE_INPUT_REQUIRED/AUTH_REQUIRED ↔ HITL Gate 매핑(`task_metadata.linked_gate_id`), deadline sweeper. PoC가 아니라 실 프로덕션 버그 재현 기반으로 반복 개선 중.
- **채용관(Recruiter) + role_templates**: 제품-소유 글로벌 채용 카탈로그. division/emoji/skills(A2A AgentSkill shape 재사용) 스키마, 22직무 로스터 + 마케팅 2종(Growth Hacker, Performance Marketer) 시드, 마이그레이션 주석에 **"~300직군 카탈로그 트랙"** 명시. `/agents` 4탭 IA(통계/관리/채용/접근권한).
- 해석: 코드는 "개발팀용 sprint 코디네이션"을 넘어 **"다직군 AI 에이전트 인력을 채용해 배치하는 워크포스 플랫폼"**으로 이동 중이다. 이 방향은 7/8 두 분석 문서 어디에도 등장하지 않는다.

## 4. 시장 최신화 (2026-07-08 이후 유의미한 변화 Top 5)

1. **"agent를 팀원으로 assign"은 업계 표준 기능이 됐다.** Linear Agent(2026-03 public beta), Jira Rovo Agents GA(2026-05), Asana AI Teammates, Notion Custom Agents(2026-02). "우리만 agent를 team member로 취급한다"는 문장은 더 이상 차별화가 아니다. 남는 차별점은 **BYOA(임의 vendor agent) + 실시간 handoff + gate + 감사 원장의 조합**.
2. **Spec-driven development(pre-flight planning)가 메가트렌드로 확정.** AWS Kiro 정식 출시(2026-05), GitHub Spec Kit 참조모델화, OpenSpec 52K stars, Google Antigravity 2.0 Manager Surface. wedge 가설은 강하게 검증됐으나, 모두 자체 IDE/런타임에 gate를 내장하므로 Sprintable의 차별화는 **vendor-agnostic한 PM-원장 레벨 gate**여야 한다.
3. **A2A가 클라우드 3사 기본값** (150+ 조직, v1.0, 5개 SDK). Sprintable의 A2A core 구현은 시장 속도와 정합 — 이 지점에서는 문서가 아니라 코드가 옳았다.
4. **MCP 2026-07-28 스펙(RC)**: stateless화, Mcp-Method 헤더 라우팅, 캐싱 메타데이터, EMA(enterprise auth) stable 승격. Sprintable remote MCP가 "dev preview" + stdio 중심 문서로 남으면 뒤처진 신호로 읽힌다.
5. **agent ops/vertical agent PM 카테고리에 자금 집중** (2026 YTD 딜의 48.3%). 완전 동일 포지션 경쟁자는 아직 미확인(Coworked이 최근접)이나, 유사 wedge 진입자 등장 확률이 상승 중.

## 5. 적대적 비평 핵심 (심각도순)

| # | 발견 | 심각도 |
|---|---|---|
| 1 | **wedge의 load-bearing 가정 미검증**: "agent가 잘못된 방향으로 2~3일치 작업을 폐기"라는 pain이 모델/harness 발전(plan mode, spec-first, checkpoint)으로 자연 소멸할 수 있다. 폐기의 근본 원인이 "모델 능력 부족"이면 소멸하고, "founder의 암묵 의도가 코드에 없어서"면 구조적으로 남는다 — 인터뷰로 반드시 분리 검증해야 한다. | CRITICAL |
| 2 | **표면적과 운영 제약의 충돌**: 419 route/95 tool 표면이 CRITICAL 보안 버그(cross-org IDOR 등)를 지속 생성하고 1인이 hotfix로 막는 중. "일이 줄어야 함" 목표와 정면 위배. 좁힘(narrowing)이 표면 순삭제를 동반하지 않으면 마케팅 문구일 뿐이다. | CRITICAL |
| 3 | **두 문서 모두 고객 인터뷰 0건**: 8/10 점수도 ICP 결정도 검증되지 않은 armchair 분석. 6개월 후 가장 후회할 결정은 "인터뷰 10건 전에 코드 방향을 확정한 것". | HIGH |
| 4 | **MRR 1억 bottom-up 산수 부재**: 세미기술 1인 founder 세그먼트에서 월 $30 × 2,000+ 유료 고객이 실재하는지 계산 없음. | HIGH |
| 5 | **놓친 대안 프레이밍**: (a) AGPL+상용 이중 라이선스를 이미 갖고 있으면서 OSS를 GTM 유입 모션으로 안 다룸, (b) 독립 플랫폼 대신 기존 도구(Linear/GitHub) 위 얇은 pre-flight 레이어, (c) vertical 특화, (d) "이 자산을 접고 더 가볍게"라는 옵션 자체의 부재. | MEDIUM~HIGH |

## 6. 이 분석이 살아남으려면 반드시 답해야 할 질문 3개

1. "2~3일 폐기" pain은 모델이 좋아져도 남는 구조적 문제인가? → 인터뷰 10건으로 폐기의 근본 원인(모델 능력 vs founder 의도의 암묵성)을 분리 검증하라.
2. 95개 tool / 419 route 중 선택한 포지션에 필요한 최소 집합은 무엇이고, 나머지를 실제로 deprecate할 각오가 있는가?
3. 선택한 세그먼트에서 MRR 1억 = 몇 명 × 월 얼마인가? 그 규모가 그 시장에 실재하는가?

## 7. 실행 제안 (우선순위)

### P0 — 포지션 단일화 결정
문서 3개 + 코드 1개, 총 4개 방향이 동시에 존재한다. 이 중 하나를 명시적으로 선택하고 나머지를 폐기 문서화해야 한다. 후보:
- **(A) Agent workforce 플랫폼** (현재 main 코드의 방향): recruiter + A2A + 다직군 카탈로그. 표면이 가장 넓고 1인 운영 리스크 최대. 단, 코드 관성과 일치.
- **(B) Pre-flight gate wedge** (7/8 ICP 문서): 시장 트렌드(SDD) 검증됨. 단, 핵심 개념이 미구현이고 기존 gate는 반대 방향(post-work). 신규 상태기계 필요. pain 소멸 리스크는 인터뷰로 선검증 필수.
- **(C) Multi-agent coordination ledger** (7/8 적합성 문서): BYOA + handoff + gate + audit. A2A/MCP 구현과 정합성 최고. 단, "agent=팀원"이 표준화된 시장에서 메시지 재정립 필요.
- 어느 쪽이든 **인터뷰 선행 + 표면 순삭제 계획**이 전제 조건이다.

### P1 — 즉시 정리 가능한 드리프트 (선택과 무관하게 유효)
- README.ko.md를 영문판 포지션과 정렬 (메모-웹훅 설명 폐기)
- tool 수 표기 단일화: README 70+ / llms-full.txt 89 / 실측 95 → 하나로
- 7/8 적합성 문서의 A2A P2 판단·route 269 수치 정정 (본 문서로 대체)
- "preflight" 네임스페이스 충돌 인지: 기존 `POST /agent-deployments/preflight`(배포 검증)와 ICP 문서의 "Pre-flight Packet"은 다른 개념
- `packages/mcp-server` stale dist 제거

### P2 — remote MCP contract를 2026-07-28 스펙에 정렬
stateless, Mcp-Method 헤더, 캐싱 메타데이터, EMA 대응 방향 문서화. "dev preview" 상태 탈출 계획.

## 8. 최종 판단

이 프로젝트가 풀려는 문제(사람+AI 에이전트 혼합팀의 작업 수신·핸드오프·승인·감사)는 2026년 상반기 시장이 실재함을 확인해줬다. 구현 기술 스택(MCP + A2A + SSE + HITL gate + 원장)도 표준 방향과 정합한다. **그러나 "현재 적합한 문제해결 방식인가"에 대한 답은 조건부다**: 문제를 4가지 다른 방식으로 동시에 풀려 하고 있고, 그 어느 것도 고객 검증을 거치지 않았으며, 표면적 증가 속도가 1인 운영 한계를 이미 넘어섰다. 적합성을 회복하는 경로는 기능 추가가 아니라 **① 포지션 1개 선택, ② 인터뷰 10건 선행, ③ 표면 순삭제**의 순서다.

## 9. 2026-07-11 재측정 (develop `ee871995` 기준)

브랜치를 최신 develop 위로 재생성(`analysis/problem-solution-fit-20260711`)하면서 §2의 실측을 동일 방법(런타임 로드)으로 재실행했다. 7/08 이후 develop에 84커밋이 추가됐다 (보안 ~31, 캔버스/현황판 ~20).

### 9.1 수치 재측정

| 항목 | 7/10 실측 (`9602d73b`) | 7/11 실측 (`ee871995`) | 변화 |
|---|---|---|---|
| MCP tool (`_TOOL_DEFS`) | 95 | **98** | +3 |
| API operations (런타임) | 419 | **447** | +28 |
| unique paths | 321 | **343** | +22 |
| router 파일 | 93 | **98** | +5 |
| 테스트 파일 | 596 | **672** | +76 |
| GitHub star / fork | 10 / 0 | **10 / 0** | 변화 없음 |

표면 확장은 멈추지 않았다(3일간 operations +28). 단, 방향은 §3의 "제4의 방향(워크포스)" 확장이 아니라 아래 9.3의 보안 봉쇄 + 캔버스가 주다.

### 9.2 P1 드리프트 정리 현황

| §7 P1 항목 | 상태 |
|---|---|
| README.ko 영문판 정렬 | **완료** — 영/한 모두 "delivery ledger for coding agent teams" 동일 포지션. 메모-웹훅 설명 폐기됨. GTM 문서 §2의 단일화 방향이 실제 코드에 반영된 것 |
| tool 수 표기 단일화 | **부분 완료 후 재드리프트** — README는 "95 tools"로 통일됐으나 실측은 98. `llms-full.txt`/`llms.txt`는 여전히 "89 tools". 수동 표기는 계속 어긋난다 → CI에서 `_TOOL_DEFS` 개수와 문서 표기를 대조하는 가드 또는 "95+" 식 하한 표기 권고 |
| `packages/mcp-server` stale dist 제거 | **완료** — 디렉토리 자체가 삭제됨 |
| repo description 교체 | **미완** — 여전히 "AI-powered sprint management (MCP + SQLite + single-user)". 새 포지션과 정면 충돌하는 유일한 공개 표면 |

### 9.3 7/08 이후 코드 이동이 본 문서 판정에 미치는 영향

1. **§5 비판 #2(표면-보안 부채)가 실증되고, 동시에 구조적 대응이 시작됐다.** SEC-S8 스프린트로 cross-org IDOR·project-scope 미검증 CRITICAL 다수가 봉쇄됐고, 마지막 커밋(`ee871995`)은 project-scope AST 스캐너를 CI ratchet baseline으로 강제한다. "1인 hotfix 대응"에서 "회귀 가드 자동화"로 전환된 것은 비판에 대한 유효한 응답이다.
2. **E-CANVAS(visual_artifact 모델·버전·앵커 코멘트·양방향 편집·export)가 병합됐다.** ICP 문서의 "low-fi visual direction" 개념과 처음으로 코드 접점이 생겼다. 단 pre-flight(실행 전) gate 상태기계는 여전히 미구현 — gate는 post-work 방향 그대로다.
3. **E-GLANCE 현황판**("감시 아닌 신뢰" 프레임)은 founder 통제감이라는 ICP 문서의 문제의식과 접점이 있으나, 세미기술 founder ICP 자체는 GTM 문서에서 후순위로 조정됐다.
4. **GTM 문서의 "신규 기능 개발 동결" 원칙과 실제 커밋이 충돌 중이다** — 3일간 커밋의 과반이 보안(불가피)이지만 캔버스/현황판 신규 기능도 ~20커밋 병행됐다. Week 1 목표(TTHW<5분 검증, launch 자산)에 리소스가 갔다는 증거는 커밋 로그에 없다.

## 부록 — 분석 방법

- code-verifier (sonnet): 런타임 로드 기반 실측 (`app.routes` 카운트, `_TOOL_DEFS` len), grep 검증, gate/hitl 상태기계 리딩
- develop-tracker (sonnet): origin/main·develop 읽기 전용 git 분석, promote 이력 추적
- market-researcher (sonnet): 2026-07-10 기준 웹 리서치 (MCP/A2A/PM도구/coding agent/SDD/경쟁사)
- analysis-critic (opus): 두 기존 문서에 대한 독립 적대적 비평
