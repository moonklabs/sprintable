# Linear 개념 매핑 + org 레벨 인간 표면 결정 (2026-07-12)

- 작성일: 2026-07-12
- 브랜치: `analysis/problem-solution-fit-20260711` (develop `ee871995` 기준 실측)
- 선행 문서: `counterpunch-proof-of-done-2026-07-11.md`, `proof-of-done-packet-design-2026-07-12.md`
- 트리거: ① Linear 데이터 구조와 Sprintable의 대응 관계 질문, ② 실사용자 온보딩 이메일 문의(MCP 설정 단위 + [조직 only] 구조 제안)
- 산출: Linear 이슈 SPR-24(인간용 org-scoped MCP 키), SPR-25(org-level My Work 표면)

## 1. Linear ↔ Sprintable 개념 매핑 (코드 실측)

`backend/app/models/` 전체 리딩 + `initiative|roadmap|triage|milestone|workspace` grep(0건) 기준.

| Linear | Sprintable | 상태 |
|---|---|---|
| Workspace | Organization (`organizations`) | 정확 대응 |
| Team | **없음** | Org → Project 2단 구조 (Linear는 3단) |
| Project | 역할상 **Epic** (`epics` — objective/success_criteria/target_date) | 이름 아닌 역할로 대응 |
| Issue | Story (`stories`, + 하위 Task = sub-issue) | 정확 대응 |
| Cycle | Sprint (`sprints`, 기본 14일 타임박스) | 정확 대응 |
| Initiative / Milestone / Roadmap / Triage / View | **전부 부재** | 백엔드 grep 0건 |
| Label | Label + ItemLabel (epic/sprint/story polymorphic) | 대응 (Sprint 라벨은 Linear보다 넓음) |
| Relations (blocks) | ItemDependency (blocks/depends_on) | 대응 |
| Docs | Doc (Notion형 트리 + draft→pending→confirmed 결재) | 대응 |

**매핑 함정**: 이름이 같은 것끼리 대응시키면 계층이 어긋난다. 구조적으로 **Sprintable Project = Linear Team 역할**(작업 컨테이너·보안 경계), **Sprintable Epic = Linear Project 역할**(목표·기한을 가진 이슈 그룹).

**Sprintable 고유** (Linear에 없음): Gate(HITL 상태기계), Evidence(불변 자기증명), Verdict(CI/PR 관찰), StoryAssignee(복수 담당), LoopRun(가설 실험 루프 — Cycle 아님), 에이전트 신원 체계(TeamMember human/agent, routing rule, key scope).

### 작업 프로세스 3레이어

1. **Story 상태기계** (DB SSOT, 선형): `backlog → ready-for-dev → in-progress → in-review → done` (`schemas/story.py`). 비순차 점프는 project.violation_level(warn/block)로 통제.
2. **Decision Gate 오버레이** (`workflow_line`): 기본 시드 3단 — dev_relay(agent-handoff), qa_observe(advisory), po_merge_gate(merge-gate, 사람 승인) (`services/workflow_line_seed.py`).
3. **에이전트 작업 사이클** (`workflow_report`): `kickoff → dev → review → qa → merge` 스테이지, merge에서만 merge verdict gate 평가(auto_merge/ask_human/block).

한 사이클: Story 작성(AC) → dispatch(에이전트 wake) → harness에서 작업 → report-done → 실증거 있으면 gate → Inbox(GateInbox)에서 approve/reject → done. **Proof-of-Done 패킷이 강화하려는 루프가 바로 이것.**

스프린트 의식: Sprint는 시작 전 생존 가설 ≥1 필수 + human-only 시작/마감. Standup(org당 하루 1건, done/plan/blockers), Retro(collect→vote→action→closed, 결과가 다음 가설로 시딩).

## 2. 실사용자 문의 — "인간의 작업 표면이 프로젝트에 갇혀 있다"

온보딩 실사용자 이메일 문의 2건 (2026-07-12):

1. **MCP가 Agent당 1개 연결** — 프로젝트 3개를 오가는 사용자에겐 불편. 워크스페이스 단위 설정 제안.
2. **[조직 > 프로젝트]를 [조직 only]로 통합** 제안 — "화면 UI는 인간을 위한 것, 인간은 프로젝트 2개 이상 + 하루 1~4 task인데 프로젝트 분리는 비효율".

### 실측 — 관찰은 정확하다

| 확인 | 근거 |
|---|---|
| MCP 서버는 `AGENT_API_KEY` 1개로 기동 — 연결 1개 = 키 1개 | `backend/sprintable_mcp/__main__.py:39-43` |
| 키 = agent 신원 = **프로젝트 스코프** | `agent_api_keys.team_member_id` → `team_members`(project_id CASCADE) |
| 키 타입은 agent/project 2종뿐 — **인간(user/org) 스코프 키 부재** | `models/api_key.py`, `models/project_api_key.py` |

### 판단 — 두 요청은 뿌리가 하나, 처방은 갈라야 한다

두 건의 본질은 §1에서 확인한 Sprintable의 공백(워크스페이스 레벨 인간 표면 부재)을 사용자가 몸으로 발견한 것.

1. **MCP 워크스페이스 단위 → 동의하되 "인간용 키 신설"로.** Agent당 키는 유지 — 키 = 신원이 tool ACL(scope SSOT)·게이트 attribution·감사 원장의 전제이고 패킷의 "행위자 뱃지"도 이 위에 있다. 인간 멤버용 **org-scoped 키**를 신설하면 MCP 1회 등록 + tool 파라미터로 프로젝트 선택. 구조 재편 없이 키 타입 추가 + 인증 해석 확장. → **SPR-24**
2. **[조직 only] 데이터 재편 → 반대. 인간 뷰만 org 레벨 통합.** Project는 에이전트 위임·보안 경계(tool ACL·파일락·게이트·dispatch가 전부 이 위에 있고 SEC-S8 ~31커밋이 project-scope 봉쇄). Linear 패턴이 참조 답안: 데이터 경계(Team)는 유지, 인간 표면만 워크스페이스 레벨(My Issues/Inbox). Sprintable도 **org-level My Work 표면**(배정 story + 대기 게이트 크로스 프로젝트)으로 푼다. 기존 부품: StandupEntry는 이미 org-level, Inbox(DecisionsWaiting+GateInbox)도 통합 지향. → **SPR-25**

"인간은 하루 1~4 task" 논거는 패킷 논지의 방증 — 인간의 주의는 희소 자원이므로 판정 표면이 프로젝트로 쪼개지면 안 된다. 게이트 판정자가 프로젝트를 오가며 헤매면 Proof-of-Done 가치가 깎이므로, 이 트랙은 패킷 로드맵의 보조 트랙으로 정렬한다.

## 3. Linear 공백 개념 도입 기준

Initiative·Milestone·Triage·저장형 View가 Sprintable의 공백이지만, "Linear 따라잡기"가 아니라 **게이트/패킷 루프에 기여하는 순서로만** 채운다:

- Triage → 이미 GateInbox가 더 날카로운 형태로 존재 (승인 대기함)
- My Work/통합 View → SPR-25 (실사용자 수요 실증됨)
- Initiative/Milestone → star 오디언스(개발자)보다 유료 조직 레이어에 가까움 — launch 후 유료 티어 설계 시 재검토

## 4. 처리 기록

- Linear 이슈 생성: SPR-24, SPR-25 (Backlog, Medium, 상호 related, 착수는 7/17 launch 이후 — 기능 동결 준수)
- 문의자 답장 초안 작성 (관찰 인정 → agent당 키는 의도된 설계 → 인간용 워크스페이스 키 + My Work 로드맵 반영 → 데이터 경계는 agent 격리 때문에 유지)
- 문의자는 온보딩 완주 사용자 — launch 후 SPR-24/25 베타 피드백 요청 후보
