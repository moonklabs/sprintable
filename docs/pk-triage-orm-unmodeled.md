# PK 트리아지 — ORM 미모델 no-PK 테이블 (story a74bdc84)

2026-06-11 PK 드리프트 전수 감사([[project_epics_pk_drift]])의 **그룹 ②**(app.models에 ORM
모델이 없으면서 DB PRIMARY KEY가 부재한 테이블)에 대한 테이블별 처분 분류.

그룹 ①(ORM이 PK를 가정하나 DB 부재한 39개)은 `0114_restore_missing_primary_keys`로 이미
복원됨 — 본 문서 범위 밖.

> ⚠️ append-only 로그류는 설계상 무-PK가 정당할 수 있어 **일괄 PK 금지**. 테이블별 트리아지.
> drop은 임의 금지 — 폐기 기능 잔재 가능성이라 **선생님 승인 경유**([[feedback_never_propose_removal]]).

## 방법

1. **권위적 목록**: pgvector:pg16 컨테이너에 `alembic upgrade head`(0119, baseline+0114 포함)
   재구성 후 no-PK 감사 쿼리(`pg_constraint contype='p'` 부재). → 130 base 테이블 중 **37개**
   no-PK(그룹 ②). 쿼리는 [[project_epics_pk_drift]] 참조.
2. **소비처 증거**: 각 테이블명을 backend(py raw SQL/repo/router)·alembic·apps/web+packages(ts
   `.from()`)·sprintable_mcp·SaaS(supabase 마이그/overlay)에서 전수 grep.
3. 증거 기반 ⓐ/ⓑ/ⓒ 분류.

## 분류 요약

| 분류 | 의미 | 처분 | 수 |
|------|------|------|----|
| ⓐ | PK 필요(identity/CRUD·자연 unique·ORM 기대) | **후속 PK-add 마이그**(gcloud·e491d087 가족) | 18 |
| ⓑ | 의도적 무-PK append-only 로그(라이브 writer 존재) | 무-PK 유지 + **명시 문서/주석** | 6 |
| ⓒ | 살아있는 소비처 0(전 레포·SaaS 포함) — drop 후보 | **선생님 승인 후** 별도 drop 마이그 | 6 |
| (보류) | OSS 레포엔 소비처 0이나 **SaaS-only로 라이브** | SaaS 트랙(무-PK 정당성은 SaaS 측 판단) | 7 |

> 합계 37(= 18+6+6+7). 권위적 no-PK 감사 목록과 1:1.

## ⓐ — PK 필요 (후속 PK-add)

| 테이블 | 근거 | 권장 PK |
|--------|------|---------|
| **plan_features** | ⚠️ **ORM 모델 존재**(`backend/app/models/plan_feature.py:15`)·unique `code`. 0114가 놓친 그룹① drift → **처분은 e491d087(PK 복원)에 fold** | `id` (0114 패턴) |
| memo_replies | memo/HITL/dispatcher 풀 CRUD(insert/select/**delete** agent-hitl.ts:124,174,251)·`id` uuid | `id` |
| memo_assignees | memo.ts:475 + webhook-dispatch:251 (assignment rows) | `(memo_id, member_id)` 또는 `id` |
| memo_reads | memo.ts read 추적(memo_id×member 1행) | `(memo_id, member_id)` |
| memo_mentions | memo.ts:533 insert | `id` 또는 `(memo_id, member_id)` |
| memo_doc_links | memo.ts entity link(0011) | `(memo_id, doc_id)` 또는 `id` |
| messaging_bridge_org_auths | bridge util/HITL auth 조회(slack-hitl:177 등) — org×platform 1행 | `(org_id, platform)` 또는 `id` |
| messaging_bridge_reply_dispatches | discord/teams outbound dispatch(insert+select) | `id` |
| org_integrations | AI settings/MCP 조회(project-mcp:184,285…) — org×provider config | `(org_id, provider)` 또는 `id` |
| project_ai_settings | project AI settings get(project-ai-settings:72,125) — project 1행 | `project_id` |
| approved_mcp_servers | project-mcp:173 select(승인 서버 config) | `id` |
| mcp_connection_requests | project-mcp:494 query(요청 rows) | `id` |
| agent_long_term_memories | agent-execution-loop:1559,1569 + SaaS `id` uuid PK(phase2) | `id` |
| agent_session_memories | agent-session-lifecycle:590,620 등 + SaaS `id` uuid PK(phase3) | `id` |
| webhook_deliveries | webhook-delivery.service:24,54,70,84 (delivery rows·재시도 식별) | `id` |
| billing_limits / billing_limit_alerts | SaaS 라이브(29/19 refs)·한도 config·alert rows(identity 필요) | `id` (SaaS 트랙 조율) |
| subscriptions | SaaS 라이브(206 refs)·구독 엔티티 | `id` (SaaS 트랙) |

## ⓑ — 의도적 무-PK append-only 로그 (무-PK 유지 + 문서/주석)

| 테이블 | 근거 |
|--------|------|
| api_key_logs | auth-api-key.ts:100 `.insert()`만 — write-once 보안 감사 로그 |
| workflow_change_events | workflow-change-notifier.ts:83 `.insert()`만 — 변경 감사 로그 |
| inbox_outbox | outbox 패턴(append→process)·SaaS 마이그(20260426170200) |
| l2_trigger_state | 0117 — `(worker_name, COALESCE(org_id,…))` **unique 인덱스가 사실상 식별자**(upsert 타겟). 무-PK이나 unique로 정합 보장. (PK 승격 시 그 unique를 PK로) |
| workflow_events | SaaS workflow 실행 로그(append) |
| org_usage | SaaS org 사용량 메트릭 집계(append/upsert) |

> ⓑ는 무-PK가 의도임을 각 생성 마이그/SaaS 스키마에 **명시 주석** 권장(차기 감사 오인 방지).

## ⓒ — drop 후보 (전 레포·SaaS 소비처 0 — 선생님 승인 필수)

전 코드베이스(OSS + SaaS) grep에서 **살아있는 소비처 0건**. 폐기 기능 잔재로 추정되나
[[feedback_never_propose_removal]]대로 **임의 drop 금지** — 목록만 보고, 선생님 승인 후 별도
drop 마이그.

- **agent_endpoints** — agent 라우팅 잔재(0 ref)
- **analytics_events** — telemetry 로그 설계이나 baseline 스키마 정의·인덱스(created_at·org/event·project/step)만 존재하고 **라이브 writer/reader 0**(OSS·SaaS 전수 grep). 적재처가 없어 ⓑ(라이브 로그) 아닌 drop 후보로 확정.
- **epic_docs** — epic-doc 연결(story_docs와 쌍·0 ref, doc entity link는 memo_doc_links로 대체된 흔적)
- **story_docs** — story-doc 연결(0 ref)
- **workflow_rules** — workflow 룰 엔진 잔재(0 ref·SaaS도 0)
- **workflow_timers** — workflow 타이머 잔재(0 ref·SaaS도 0)

## (보류) SaaS-only 라이브 — OSS 레포 0이나 SaaS서 동작

OSS(이 레포) 소비처는 0이나 **SaaS overlay/엔진서 라이브**(supabase 직타). dead 아님 —
무-PK 정당성/처분은 SaaS 트랙 판단. PK 필요 시 SaaS 마이그로.

- llm_pricing_config(SaaS 11·OSS는 test mock만) · plan_offerings(9) · plan_tiers(61) ·
  subscription_checkout_sessions(35) · workflow_contracts(90) · workflow_executions(60) ·
  workflow_instances(60)

## 범위 밖(후속)

- ⓐ 분류분 **실제 PK-add 마이그**: gcloud 적용 의존·중복/NULL preflight 선행([[project_epics_pk_drift]]
  0114 패턴)·공유 prod DB 인프라 lane → 별도(e491d087 가족).
- ⓒ **drop**: 선생님 승인 경유 별도 마이그.
- SaaS-only 테이블 PK/처분: SaaS 트랙.
