# HITL 게이트 집행(enforcement) — 블루프린트 (S-GATE-2, 짧은 버전)

Status: Draft for review. Epic `E-HITL-GATING` / S-GATE-2. 정책 `hitl-gating-policy-v1` §3. S-GATE-1(config·resolve·0123) 위. **dev 전용**·마이그 없음(기존 HitlRequest 재사용).

## 1. 목표
`resolve_gate_level`(S-GATE-1)을 **실 액션 경로**(story →done·merge)에 물려 집행: `auto`=통과 · `block`=차단(거부+사유) · `ask`=**HITL 큐로 park**(휴면 HitlRequest/Cage/H1 자산 활용·사람 승인 대기). 안전 하한(§3d) clamp는 S-GATE-3.

## 2. 현행 자산 (감사)
| 자산 | 위치 | 상태 |
|---|---|---|
| done-gate 훅 `_preflight_merge_gate` | `stories.py:150` (주입점 `:339`·`:550`·`workflow_report.py:161`) | H1 trust 게이트(flag `merge_gate_active`·allowlist)·decision AUTO_MERGE/ASK_HUMAN/BLOCK·advisory 모드 |
| Cage verdict_capture·gate_service·gate_resolver | `services/` | verdict(pass/fail)·gate row·disposition(allow/ask/deny) — **기록은 되나 ask→사람 큐 미배선** |
| **HitlRequest** 모델/라우터 | `models/hitl.py`·`routers/hitl.py` | create/list/resolve **인프라 존재·액션 enforcement 미배선**(이게 ask 갭) |
| actor_type | `_resolve_actor_info`(member.type) | PATCH 시점 해소되나 게이트에 **미전달** |

## 3. 설계 — config 레벨이 1차 게이트
**resolve_gate_level(config)이 집행 결정의 1차 소스.** 기존 H1 trust 게이트(`merge_gate_active`)는 별개 flag 자산 — v1은 **공존**(config 게이트가 우선·H1은 'auto' 신뢰 근거로 후속 S-GATE-3+에서 접목). S-GATE-2는 config 게이트만 신규 집행.

집행 지점 = 기존 `_preflight_merge_gate` 훅 **확장**(주입점 3곳 그대로 재사용·새 enforce 함수):
```
enforce_gate(session, org_id, project_id, work_item, work_type, actor_type):
  level = resolve_gate_level(org, project, work_type, actor_type)
  level=='auto'  → return (통과)
  level=='block' → raise 409 GATE_BLOCKED(work_type·actor·사유)
  level=='ask'   → HitlRequest(pending) 생성 + 409/202 GATE_ASK(request_id) → 차단(승인 전 done 불가)
```
- work_type 매핑: story →done = `done` · merge 게이트(report_done merge stage·H1) = `merge`.
- actor_type: `_resolve_actor_info(member.type)` 호출부에서 추출해 전달.
- **enablement flag**(merge_gate_active 동형·dev allowlist) `gate_config_enforce_active(org)` — 점진 활성·무회귀.

## 4. ask 재개(resumption) — 결정 §6-2
level=ask → HitlRequest(status=pending, request_type='gate_approval', metadata={work_item_id, work_type, actor_id}) 생성·done 차단. 사람이 `PATCH /hitl/requests/{id}`로 approve →
- **(A·권고) 재시도 통과**: 승인 레코드(HitlRequest approved) 존재 시 동일 work_item의 →done 재시도가 통과(enforce_gate가 유효 승인 발견 시 auto-pass). 단순·idempotent·서버 자동 advance 불요.
- (B) 서버 자동 advance: 승인 hook이 gate_service.transition로 done 자동 전이(기존 _advance_story_on_merge_approve 재사용). 복잡·자동성↑.
→ 권고 A(v1 단순·관측 명확). reject → HitlRequest rejected·done 영구 차단(재요청까지).

## 5. 측정 (정책 §5)
enforce 시 구조화 로그 `gate_enforced … level=… outcome=auto|blocked|ask_queued`. ask 해소 시간(HitlRequest created→responded)·rubber_stamp(기존 ≤30s 마킹 재사용)·prevented_bad_pass(ask/block로 막은 done) baseline.

## 6. PO 결정 (§ 사인오프)
1. **기존 H1 trust 게이트(`merge_gate_active`)와의 관계**: config 게이트가 **1차·공존**(H1은 후속 접목) 권고 — OK? 아니면 config가 H1을 대체(merge_gate_active 경로 제거)?
2. **ask 재개** = (A) 승인 후 재시도 통과(권고) vs (B) 서버 자동 advance?
3. **block/ask HTTP**: block=409·ask=409(request_id 동봉)로 차단 일관 vs ask=202(pending 수락)? 권고=ask도 409(차단이 본질·done 안 됨).
4. **enablement** = dev allowlist flag(`gate_config_enforce_active`)로 점진 활성 확認.
5. **self-approval**: S-GATE-3 hard floor라 v1은 미적용 확認(요청자=승인자 차단은 S-GATE-3)?

§6 떨어지면 S-GATE-2(enforce_gate 서비스 + 주입점 3 배선 + HitlRequest ask 큐 + 측정 로그 + 테스트) 일반 dev 파이프라인으로 진행(마이그 없음). 집행은 flag-gated라 무회귀.
