"""E-MEMBER-SSOT AC3-1b AC2: agent_api_keys 앵커 정합 감사 (H2).

`member_ssot_apikey_cut=on`의 _resolve_api_key는 `members(id=api_key.member_id, type='agent',
is_active, not deleted)`를 요구한다. 0076은 agent_api_keys 전 row에 member_id=team_member_id를
dual-write 했고 0075는 type='agent' team_member만 members에 넣었으므로, **active key 중**
(a) tm.type != 'agent' 이거나 (b) members(agent) 행이 부재이면 cut-on 시 401(생명선 차단)이 된다.

이 스크립트는 cut **regression** 을 두 축으로 나열한다(H2 = (a) ∩ (b) ∩ FK 모두 0 이어야 cut 안전):
- **(a) cut regression** — legacy 는 200(active team_members 존재)인데 anchor 는 401(members(agent,active)
  부재) = flip 으로 실제 깨지는 working 키. legacy 도 이미 401 인 dead 키(inactive tm)는 flip 무관이므로
  regression 에서 제외하고 INFO(revoke 후보)로만 집계 — '깨지는 키'와 '이미 죽은 키'를 분리.
- **(b) 해소 드리프트** — 유효 앵커가 있어도 anchor 해소가 legacy 와 다른 신원/프로젝트/org 면 cut 후 권한
  드리프트. anchor 기본프로젝트 = resolver 와 동일 union(agent_project_profiles ∪ project_access granted)
  ORDER BY project_id LIMIT 1 = legacy team_members(0110 뷰) set 과 동치. 정상이면 proj 축 0, 깨지면
  grant-only 누락/union 복제 회귀/0075 파손 감지.
- 0건(a∩b∩FK) → flag-on 안전(dead 키 INFO 는 비차단). 1건+ → 처리(regression: 0075 정합/members 보정 · 드리프트: 정렬 정합).

env: DATABASE_URL (백엔드 동일, cloud-sql-proxy/in-VPC 경유). 읽기 전용(조회만).
실행: cd backend && DATABASE_URL=... python -m scripts.jobs.audit_apikey_member_anchor
"""
from __future__ import annotations

import asyncio
import os
import sys

from sqlalchemy import text

from app.core.database import async_session_factory

# (a) cut REGRESSION: legacy 가 해소되는데(active team_members 존재) anchor 는 401(members(agent,active) 부재)
# = flip 으로 **실제 깨지는 working 키**. legacy 도 이미 401 인 dead 키(inactive tm)는 flip 무관이라 제외(INFO).
# 0075(member_id=team_member_id)면 legacy/anchor 가 동일 members row 라 정합 — regression 은 사실상 0075 파손
# (id_mismatch)일 때만 발생. members=테이블(1:1)·legacy 판정은 EXISTS 로 → team_members projection VIEW dup 회피.
AUDIT_SQL = """
SELECT ak.id            AS api_key_id,
       ak.team_member_id,
       ak.member_id,
       (m.id IS NOT NULL) AS member_exists,
       (m.id IS NOT NULL AND m.type = 'agent' AND m.is_active AND m.deleted_at IS NULL) AS member_cut_ok
FROM agent_api_keys ak
LEFT JOIN members m ON m.id = ak.member_id
WHERE ak.revoked_at IS NULL
  AND (ak.expires_at IS NULL OR ak.expires_at > now())
  AND NOT (m.id IS NOT NULL AND m.type = 'agent' AND m.is_active AND m.deleted_at IS NULL)
  AND EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = ak.team_member_id AND tm.is_active)
ORDER BY ak.created_at
"""

# INFO(게이트 아님): anchor·legacy 둘 다 실패하는 dead 키(inactive tm) — flip 무관(이미 401)·revoke 정리 후보.
# count(DISTINCT) 로 team_members VIEW dup inflation 제거.
DEAD_KEYS_SQL = """
SELECT count(DISTINCT ak.id) FROM agent_api_keys ak
LEFT JOIN members m ON m.id = ak.member_id
WHERE ak.revoked_at IS NULL
  AND (ak.expires_at IS NULL OR ak.expires_at > now())
  AND NOT (m.id IS NOT NULL AND m.type = 'agent' AND m.is_active AND m.deleted_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = ak.team_member_id AND tm.is_active)
"""

# 0080 FK VALIDATE 가드와 동일 기준: member_id referent 부재(active 무관 전 row)
FK_VIOLATION_SQL = """
SELECT count(*) FROM agent_api_keys ak
WHERE ak.member_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM members m WHERE m.id = ak.member_id)
"""

# (b) anchor==legacy 해소 일치(H2 두 번째 축): **유효 앵커가 있어도** cut-on 이 legacy 와 다른 신원/
# 프로젝트로 해소되면 cut 후 권한 드리프트. legacy=team_members(0110 뷰) ORDER BY project_id LIMIT 1,
# anchor=resolver 와 동일 union(agent_project_profiles ∪ project_access granted) ORDER BY project_id LIMIT 1.
# team_members 뷰 agent set = 그 union 이므로 정상이면 proj_mismatch 0 — 어긋나면 union 복제 회귀/0075
# 파손/grant-only 누락 감지. member_id≠team_member_id=0075 invariant 파손. org 불일치도 점검.
PARITY_SQL = """
SELECT ak.id AS api_key_id, ak.team_member_id, ak.member_id,
       leg.project_id AS legacy_proj, anc.project_id AS anchor_proj,
       leg.org_id AS legacy_org, m.org_id AS anchor_org,
       (ak.member_id IS DISTINCT FROM ak.team_member_id) AS id_mismatch,
       (anc.project_id IS DISTINCT FROM leg.project_id)  AS proj_mismatch,
       (m.org_id IS DISTINCT FROM leg.org_id)            AS org_mismatch
FROM agent_api_keys ak
JOIN members m ON m.id = ak.member_id
             AND m.type = 'agent' AND m.is_active AND m.deleted_at IS NULL
LEFT JOIN LATERAL (
    SELECT tm.project_id, tm.org_id FROM team_members tm
    WHERE tm.id = ak.team_member_id AND tm.is_active
    ORDER BY tm.project_id LIMIT 1
) leg ON TRUE
LEFT JOIN LATERAL (
    -- resolver(auth.py)와 동일 set: agent_project_profiles ∪ project_access(granted). legacy(team_members
    -- 뷰=동일 union)와 비교 → union 이 뷰 set 과 어긋나면(복제 회귀) proj_mismatch 로 적출(self-check).
    SELECT u.project_id FROM (
        SELECT project_id FROM agent_project_profiles WHERE member_id = ak.member_id
        UNION
        SELECT project_id FROM project_access WHERE member_id = ak.member_id AND permission = 'granted'
    ) u
    ORDER BY u.project_id ASC LIMIT 1
) anc ON TRUE
WHERE ak.revoked_at IS NULL AND (ak.expires_at IS NULL OR ak.expires_at > now())
  -- legacy 가 실제 해소되는 키만(dead 키의 legacy NULL 을 anchor 와 비교해 가짜 드리프트로 잡지 않도록).
  AND EXISTS (SELECT 1 FROM team_members tm WHERE tm.id = ak.team_member_id AND tm.is_active)
  AND ( ak.member_id IS DISTINCT FROM ak.team_member_id
     OR anc.project_id IS DISTINCT FROM leg.project_id
     OR m.org_id IS DISTINCT FROM leg.org_id )
ORDER BY ak.created_at
"""


async def main() -> int:
    if not os.environ.get("DATABASE_URL"):
        print("[FAIL] DATABASE_URL 필요", file=sys.stderr)
        return 2
    async with async_session_factory() as s:
        rows = (await s.execute(text(AUDIT_SQL))).mappings().all()
        fk_bad = (await s.execute(text(FK_VIOLATION_SQL))).scalar_one()
        parity = (await s.execute(text(PARITY_SQL))).mappings().all()
        dead = (await s.execute(text(DEAD_KEYS_SQL))).scalar_one()

    print(f"=== (a) cut REGRESSION (legacy 200·anchor 401) active key {len(rows)}건 ===")
    for r in rows:
        print(
            f"  api_key={r['api_key_id']} tm={r['team_member_id']} member_id={r['member_id']} "
            f"member_exists={r['member_exists']} cut_ok={r['member_cut_ok']}"
        )
    print(f"=== 0080 FK VALIDATE 위반(members 부재 referent, 전 row) {fk_bad}건 ===")
    print(f"=== (b) anchor≠legacy 해소 드리프트 active key {len(parity)}건 ===")
    for r in parity:
        diverge = ",".join(
            d for d, on in (("id", r["id_mismatch"]), ("proj", r["proj_mismatch"]), ("org", r["org_mismatch"])) if on
        )
        print(
            f"  api_key={r['api_key_id']} tm={r['team_member_id']} member_id={r['member_id']} diverge=[{diverge}] "
            f"legacy_proj={r['legacy_proj']} anchor_proj={r['anchor_proj']} legacy_org={r['legacy_org']} anchor_org={r['anchor_org']}"
        )
    print(f"--- INFO: dead 키(legacy·anchor 둘 다 이미 401·flip 무관·revoke 후보) {dead}건 ---")

    if len(rows) == 0 and fk_bad == 0 and len(parity) == 0:
        print(f"[PASS] (a)regression + (b)드리프트 + FK 모두 0 — flag-on 안전(cut 절대전제 충족). dead 키 {dead}건은 flip 무관(별도 revoke 후보)")
        return 0
    print("[WARN] 위반 존재 — flag-on 前 처리 필요(regression: 0075 정합/members 보정 · 해소드리프트: 기본프로젝트 정렬 정합)")
    return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
