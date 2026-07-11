# 카운터펀치 결정 — Proof-of-Done 패킷 (2026-07-11)

- 작성일: 2026-07-11
- 브랜치: `analysis/problem-solution-fit-20260711` (develop `ee871995` 기준)
- 선행 문서: `gtm-1000-stars-2026-07.md`(방향 단일화 + star 1000 GTM), `problem-solution-fit-verification-2026-07-10.md` §9(7/11 실측)
- 근거: 코드베이스 capability 실측(런타임 카운트 + 모듈 리딩) + GTM 문서의 시장 증거 재구성

## 1. 결정 요약

**단기 목표(7/31 star 1,000)의 카운터펀치는 "Proof-of-Done 패킷"이다.**

> 에이전트가 "완료"를 선언하는 순간, Sprintable이 {수용기준 체크 · Evidence · CI/PR Verdict · diff 사실 · 파일충돌 검사 · 티켓 단위 토큰 비용}을 **게이트 승인 화면에 한 묶음으로** 제시한다. 사람은 코드 전체를 읽지 않고 수 분 안에 approve / reject를 판정한다.

함께 확정한 프레임: **제품 정체성과 데모는 "보드"가 아니라 "게이트 순간"이다.** 티켓/보드 원형은 유지하되(§5), 차별화·메시지·Show HN 데모는 전부 게이트에서 일어난다.

선정 이유 세 줄:
1. **수요가 가장 구체적이다** — 2026-06 시점 살아남은 pain이 정확히 "done 판정 + merge 안전"이다 (§2).
2. **부품이 이미 80% 존재한다** — Gate/Evidence/Verdict/FileLock/cost가 전부 코드에 있고, 없는 것은 "결합"뿐이다 (§3). 3주 창 안에서 1인이 실현 가능한 유일한 카운터펀치 후보였다.
3. **트렌드가 역풍이 아니라 순풍이다** — 자율 실행이 길어질수록 이 pain은 소멸하지 않고 커진다 (§2.5).

기각한 대안: 교차벤더 상호리뷰 강제(단독으로는 폭이 좁음 — 패킷의 7번째 요소로 흡수), 티켓 단위 비용 가시성(카운터펀치가 아니라 보조 기능 — 패킷의 6번째 요소로 흡수).

## 2. 수요 근거 — 개발자와 사업가의 needs 분리

### 2.1 개발자 (star 오디언스)

GTM 문서 §1.5/§1.7의 1차 출처 증거를 패킷 요소에 직접 매핑하면:

| 시장의 목소리 (출처) | 패킷이 주는 답 |
|---|---|
| "the chaos wasn't tmux or worktrees, it was **reconciliation and stop**... deciding when each one is 'done' and **safe to merge** is the hard part" (r/ClaudeCode 6/23) | 수용기준 체크 + CI/PR Verdict + diff 사실 — done 선언의 실체 판정 |
| "one agent quietly undoes or reintroduces [changes]" (동일 스레드) | 파일충돌 검사 — 형제 에이전트가 같은 파일을 건드렸는지 게이트에서 표시 |
| "How many credits would this burn?" (214pt 포스트 댓글 최다 반론) | 티켓 단위 토큰 비용 — 이 작업에 얼마 들었는지 패킷에 포함 |
| "coding faster thru CC but I trust Codex more on reviewing" (비대칭 신뢰) | 교차벤더 리뷰어 뱃지 — 작성자≠리뷰어 벤더임을 패킷이 증명 |
| "treat agents like junior engineers working from **separate tickets**" | 티켓 원형 유지 (§5) — 패킷은 티켓 단위로 생성됨 |

### 2.2 사업가/founder (유료 오디언스)

- **코드를 읽지 않고 통제감**: 세미기술 founder ICP 문서가 짚었던 "founder는 모든 코드를 리뷰하지 못해도 방향·영향 범위는 승인할 수 있다"가 패킷의 정의와 일치한다. E-GLANCE("감시 아닌 신뢰" 현황판)와 E-VERIFY trust-seal이 이미 이 방향의 UI 자산이다.
- **감사 가능한 수용 기록**: "누가 무엇을 근거로 approve했나"가 조직의 컴플라이언스 질문이고, 패킷은 그 근거의 원자 단위다 (§6).

## 2.5 구조적 트렌드 논거 — 자율 실행 시간의 증가

인간이 Claude로 코딩할 때 자율 실행 구간이 10분에서 1~2시간으로 길어졌고, 이 구간은 계속 늘어난다. OpenClaw, Hermes 등 harness도 다변화 중이다. 이 트렌드가 본 결정에 미치는 함의:

1. **사람의 개입은 두 지점으로 압축된다** — 자율 구간이 길수록 사람이 개입하는 순간은 "위임(티켓 작성)"과 "수용(게이트 판정)"뿐이다. 제품이 잡아야 할 표면이 바로 이 두 지점이고, 카운터펀치는 그중 병목인 **수용**에 꽂는 것이다.
2. **모델이 좋아져도 pain은 커진다** — 검토 대기 큐 = 에이전트 수 × 자율 실행 시간. 둘 다 증가 추세이므로 "긴 자율 실행의 산출물을 빠르게 판정하는 장치"의 수요는 구조적으로 늘어난다. (pre-flight wedge가 가졌던 "모델 발전으로 pain 소멸" 리스크가 여기엔 없다 — verification 문서 §5 #1의 응답.)
3. **"개입 시간이 점점 줄어드는 경험"의 제품화 경로가 이미 있다** — 기존 `OrgGatePolicy` posture(conservative → balanced → permissive)와 auto_passed 상태가 신뢰 축적에 따른 자동 통과 정책의 뼈대다. 처음엔 모든 패킷을 사람이 보고, 신뢰가 쌓이면 게이트가 스스로 통과시키는 비율이 올라간다 — 사용자가 말한 "이 시간이 더 줄어드는 경험"이 곧 이 제품의 성장 곡선이다.
4. **BYOA 다변화는 중립 레이어의 추가 근거** — harness가 다양해질수록 특정 vendor 안에 내장된 게이트는 커버리지가 깨지고, harness 위의 벤더 중립 게이트 레이어의 가치가 커진다.

## 3. 공급 근거 — capability 실측 (2026-07-11, develop `ee871995`)

패킷의 부품별 현황. **결론: 새 서브시스템이 아니라 결합 작업이다.**

| 부품 | 상태 | 위치 | 갭 |
|---|---|---|---|
| Gate 상태기계 (pending→approved/rejected/auto_passed/voided/held) + `neutral_facts`(JSONB) | **존재** | `backend/app/models/gate.py`, `services/gate_service.py`, `services/gate_enforce.py` | 승인 시점에 구조화된 증거 번들이 안 붙음 — `neutral_facts`는 경량 관찰값(diff_size 등)뿐 |
| 게이트 승인 UI (inbox + story 표면) | **존재** | `apps/web/src/components/cage/gate-inbox.tsx`, `gate-evidence.tsx`, `story-merge-gate.tsx` | 패킷 패널로 확장 필요 |
| Evidence 자기증명 객체 (불변, url/file/pr/deploy/metric/report/gate_approval) | **존재** (E-VERIFY V0) | `backend/app/models/evidence.py`, `routers/evidence.py`, `apps/web/src/components/verify/evidence-section.tsx` | story/task에 붙고 Gate와는 분리 — 결합 스키마 부재 |
| CI/PR 실데이터 수집 (GitHub GraphQL status rollup, 리뷰 라운드) | **존재** | `backend/app/services/verdict_capture.py`, `models/verdict.py` | 테스트 산출물 상세는 pass/fail rollup 수준 |
| merge verdict 게이트 (auto_merge/ask_human/block) | **존재** | `services/merge_verdict_gate.py`, `routers/workflow_report.py` | — |
| 수용기준 필드 | **부분** | `models/pm.py:105` (`Story.acceptance_criteria`, 자유 텍스트) | 구조화 체크리스트·항목별 판정 없음 |
| 파일충돌 감지 (advisory 경고 + SSE 이벤트) | **부분** | `routers/file_locks.py`, `models/file_lock.py`, MCP `sprintable_lock_files` | path 문자열 매칭뿐 — git/branch/diff 인식 없음, 게이트와 미연결 |
| 토큰/비용 추적 | **부분** | `models/agent_run.py:35-37` (`cost_usd`), `routers/command_center.py:349` (일자별 합산) | **티켓(story) 단위 롤업 부재** |
| 교차벤더 리뷰 | **부분** | `routers/workflow_recipes.py`(scrum-3step), `models/agent_routing_rule.py`(target_runtime/model), `verdict_capture.py`(gatekeeper participation) | 작성자≠리뷰어 벤더 **강제/표시 없음** |
| 패킷 결합 스키마 + 게이트 패널 + MCP 툴 | **부재** | — | 이것이 만들 것의 전부 |

설계 유의점: E-VERIFY의 Evidence는 의도적으로 "감시가 아닌 신뢰"(자기증명, not a checker)로 설계됐다. 패킷은 이 원칙을 깨지 않는다 — 에이전트의 주장(Evidence)과 시스템의 관찰(Verdict/neutral_facts/conflict/cost)을 **나란히** 보여주고 판단은 사람(또는 신뢰 정책)이 한다.

## 4. 기능 정의 (제품 관점)

에이전트가 done을 선언(`POST /workflow/report-done` 또는 MCP)하면 게이트에 패킷이 생성·부착된다:

| # | 패킷 요소 | 출처 객체 |
|---|---|---|
| 1 | 수용기준 체크리스트 (항목별 에이전트 자기평가 + 근거 링크) | `Story.acceptance_criteria` (구조화 필요) |
| 2 | Evidence 목록 (PR, deploy, 스크린샷, 리포트 — 불변 자기증명) | `Evidence` |
| 3 | CI/PR Verdict (status check rollup, 리뷰 라운드, pass/fail/미측정) | `Verdict` + `verdict_capture` |
| 4 | diff 사실 (변경 파일 수, diff 크기, 마이그레이션 포함 여부 등 중립 관찰) | `Gate.neutral_facts` (확장) |
| 5 | 파일충돌 검사 (같은 파일을 건드린 형제 에이전트/티켓 표시) | `FileLock._find_conflicts` (게이트 연결) |
| 6 | 티켓 단위 토큰 비용 (이 story의 agent_run 합산) | `agent_run.cost_usd` (롤업 신설) |
| 7 | (선택) 교차벤더 리뷰어 뱃지 — 작성 runtime ≠ 리뷰 runtime 증명 | `agent_routing_rule.target_runtime` + gatekeeper participation |

사람의 경험: 게이트 inbox에서 패킷 하나를 열고 → 체크리스트·판정·비용을 훑고 → approve/reject/hold. 판정 근거는 `decision_basis`로 원장에 남는다. 신뢰가 쌓이면 `OrgGatePolicy`가 일부를 auto_pass시킨다.

## 5. "task 관리툴 느낌 + delivery ledger"는 맞는가 — 답

**티켓 원형은 유지한다. 그러나 제품 정체성은 task 관리툴이 아니다.**

- 유지하는 이유: "treat agents like junior engineers working from separate tickets"가 실사용 패턴으로 검증됐다. 티켓은 에이전트에게 범위를 좁혀 위임하는 단위이자 패킷이 생성되는 단위다. 보드는 사람에게 익숙한 **입력 표면**으로 남는다.
- task 관리툴을 전면에 세우지 않는 이유: "agent 칸반/대시보드" 앵글은 이미 밈이 된 포화 카테고리다(GTM §1.5 — "I've seen like seventeen of these this month"). 시각화는 harness가 네이티브로 흡수했다(§1.7).
- 따라서: **보드 = 입력 표면, 패킷 = 출력 증명, 게이트 = 제품의 순간.** 스크린샷·데모·Show HN 문구·랜딩 히어로는 전부 게이트 승인 순간을 보여준다. 이는 launch-assets의 "'보드' 스크린샷보다 gate 승인/차단 순간을 보여줄 것"과 일치한다.

## 6. 사업가 needs와 수익 연결 (Bloop 교훈의 적용)

vibe-kanban은 수천 DAU에도 과금 전환 0에 수렴해 죽었다 — 유료 레이어가 "편의 기능"이었기 때문이다. Proof-of-Done은 유료 레이어를 "조직이 사야만 하는 통제 기능"으로 만드는 원자 단위다:

- **무료(OSS/솔로)**: 내 에이전트의 패킷을 내가 판정 — star·입소문 엔진
- **유료(팀/조직)**: 패킷 **정책**(어떤 gate_type은 반드시 사람이, 어떤 role은 auto-pass 금지 — `OrgGatePolicy`/`OrgGateOverride` 이미 존재), 패킷 **감사 보존**(누가 무엇을 근거로 승인했나), 교차벤더 리뷰 강제 정책, SSO/EMA

즉 GTM 문서 §4.5의 수익 모델 원칙에서 "통제 레이어"의 실체가 바로 패킷이다.

## 7. 진행 순서 (GTM 3주 창 내)

| 시기 | 할 일 |
|---|---|
| Week 1 잔여 (~7/16) | ① TTHW <5분 실측(계획 전체의 관문) ② repo description 교체 ③ llms.txt/llms-full.txt tool 수 정정 — ②③은 현재 보류 중, 승인 시 즉시 처리 가능 ④ 패킷 MVP 구현 계획 세션(별도) — 결합 스키마·게이트 패널·비용 롤업·MCP 툴 스코프 확정 |
| Week 1.5~2 | 패킷 MVP 구현 + **게이트 순간 데모 자산**(dev agent done 선언 → 패킷 열람 → reject → 수정 → approve → merge, 비용 표시 포함 — launch-assets 데모 시나리오와 동일) |
| Week 2 (7/17~) | Show HN 앵글 1로 발사 — "Tickets and merge gates for coding agents: know when agent work is actually done and safe to merge". **앵글 1 문구가 곧 이 기능이다.** 패킷 스크린샷이 히어로 이미지 |
| Week 3~4 | 후속 파동(awesome-list, dev.to, GitHub 이슈 겨냥 데모)은 GTM 문서 §3 그대로 |

주의: GTM의 "신규 기능 동결" 원칙과의 관계 — 패킷은 신규 표면 확장이 아니라 **기존 표면의 결합**이며, launch 데모의 전제 조건이므로 동결 예외로 정당화된다. 그 외 신규 기능(캔버스/채용관 확장)은 launch까지 동결 유지가 바람직하다.

## 8. 다음 액션 체크리스트 (구현 계획 세션의 인풋)

우선순위순:

1. [ ] **패킷 결합 스키마** — Gate에 패킷을 부착하는 read-model(신규 테이블 최소화: Evidence/Verdict/FileLock/agent_run을 gate_id 또는 story_id로 조인하는 composed view + `neutral_facts` 확장)
2. [ ] **게이트 패널 확장** — `gate-inbox.tsx`/`story-merge-gate.tsx`에 패킷 뷰(체크리스트·Verdict·충돌·비용) 렌더
3. [ ] **수용기준 구조화** — `acceptance_criteria` 자유 텍스트 → 항목 배열 + done 선언 시 에이전트 자기평가 수집 (MCP 툴 계약 변경 포함)
4. [ ] **티켓 단위 비용 롤업** — story별 `agent_run` 합산 API + 패킷 표시
5. [ ] **파일충돌 → 게이트 연결** — done 선언 시점 `_find_conflicts` 스냅샷을 패킷에 포함
6. [ ] **교차벤더 리뷰어 뱃지** (선택) — gatekeeper participation의 runtime이 작성자와 다른지 표시
7. [ ] 데모 자산: 패킷 reject→수정→approve 15초 클립 + 스크린샷 (launch-assets 체크리스트와 연동)
