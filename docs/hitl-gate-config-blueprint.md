# HITL 게이트 레벨 config — 블루프린트 (S-GATE-1, 짧은 버전)

Status: Draft for review. Epic `E-HITL-GATING` / story S-GATE-1(`f9e54965`). 정책: `hitl-gating-policy-v1` §3. Scope: backend + migration(0123). **dev 전용 가치 실험**(prod 미영향·정책 §7).

## 1. 목표 (S-GATE-1 한정)
게이트 레벨 **config 모델 + 조회 헬퍼**. org 기본값 → project 오버라이드 계층으로 `(work_type × actor) → level`을 저장/해소. 집행(Cage/H1 깨우기)=S-GATE-2, 안전 하한 강제=S-GATE-3, UI=S-GATE-4. 측정 계측은 동반.

## 2. 데이터 모델 (migration 0123 · additive)
```
hitl_gate_config
  id          uuid PK
  org_id      uuid NOT NULL
  project_id  uuid NULL          -- NULL=org 기본값 · set=project 오버라이드
  work_type   text NOT NULL      -- CHECK in ('done','merge')   (v1)
  actor_type  text NOT NULL      -- CHECK in ('agent','human')
  level       text NOT NULL      -- CHECK in ('auto','ask','block')
  created_by  uuid NULL
  created_at/updated_at
```
유니크(축당 1행): 부분 유니크 인덱스 2개 —
`(org_id, work_type, actor_type) WHERE project_id IS NULL` (org 기본값),
`(org_id, project_id, work_type, actor_type) WHERE project_id IS NOT NULL` (project 오버라이드).
→ NULL distinct 함정 회피. 신규 테이블이라 백필 없음·prod 코드 무영향(dev 전용 기능).

## 3. 조회 헬퍼
`resolve_gate_level(session, org_id, project_id, work_type, actor_type) -> 'auto'|'ask'|'block'`:
1. project 오버라이드(`project_id` 행) 있으면 그 level.
2. 없으면 org 기본값(`project_id IS NULL` 행) level.
3. 둘 다 없으면 **보수적 기본 `ask`**(정책 §3e).
⚠️ **안전 하한(§3d) 미적용** — self-approval 차단·main머지 auto금지 hard floor는 **S-GATE-3**에서 resolve 위에 clamp. S-GATE-1 resolve 는 순수 config 해소(저장값/기본값)만.

## 4. set/get 엔드포인트 (권고 — 결정 §6-4)
config 를 **읽고 쓸 주체**가 있어야 S-GATE-2 집행이 실 config 를 읽고 S-GATE-4 UI 가 붙는다:
- `GET /api/v2/projects/{project_id}/gate-config` — 해당 project 의 effective config(오버라이드+상속) 조회.
- `PUT .../gate-config` — level 설정. 권한(정책 §2·토대 재사용): **org 기본값=org admin**(`is_org_owner_or_admin`), **project 오버라이드=project owner**(`has_project_role(min='owner')`) 또는 org owner/admin.
- 미포함 대안: 모델+resolve만, set 은 S-GATE-4 와. (권고=포함 — 토대 권한 주체가 §2 그대로라 자연스럽고 S-GATE-2 가 바로 소비.)

## 5. 측정 계측 (정책 §5)
resolve 호출 시 `gate_level resolved org=… project=… work=… actor=… level=…` 구조화 로그(집행 전 coverage/분포 baseline). 실 집행 메트릭(prevented_bad_pass 등)은 S-GATE-2/측정 스토리.

## 6. PO 결정 (§9 스타일 — 마이그 전 확認)
1. **work_type v1 값** = `done`(스토리 done 전이)·`merge`(머지) 두 개 확認? (네이밍 done/merge로 고정)
2. **기본 level**(config 미설정) = `ask`(§3e 보수적) 확認.
3. **유니크 처리** = 부분 유니크 인덱스 2개(권고) vs `NULLS NOT DISTINCT`(PG15+). 권고=부분 인덱스(명시적).
4. **set/get 엔드포인트** S-GATE-1 포함(권고) vs 모델+resolve만(엔드포인트 S-GATE-4)? 권고=최소 포함(권한=토대 헬퍼 재사용).
5. **권한 매핑** 확認: org 기본값=org admin / project 오버라이드=project owner(+org owner/admin). 정책 §2 정합.

§6만 정해지면 S-GATE-1(0123 마이그+resolve+(옵션)엔드포인트+측정 로그+테스트) 머지+migrate-dev 규율로 진행.
