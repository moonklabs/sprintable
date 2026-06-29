"""E-MEMBER-SSOT AC3-1b AC2: agent_api_keys 앵커 정합 감사 (H2).

`member_ssot_apikey_cut=on`의 _resolve_api_key는 `members(id=api_key.member_id, type='agent',
is_active, not deleted)`를 요구한다. 0076은 agent_api_keys 전 row에 member_id=team_member_id를
dual-write 했고 0075는 type='agent' team_member만 members에 넣었으므로, **active key 중**
(a) tm.type != 'agent' 이거나 (b) members(agent) 행이 부재이면 cut-on 시 401(생명선 차단)이 된다.

이 스크립트는 cut-on 위반 active key 를 **두 축**으로 나열한다(H2 = (a) ∩ (b) 둘 다 0 이어야 cut 안전):
- **(a) 앵커 부재** — members(agent,active) 부재/NULL/wrong-type → cut-on 401(생명선 차단).
- **(b) 해소 드리프트** — 유효 앵커가 있어도 anchor 해소(members.id + agent_project_profiles ORDER BY created_at)
  가 legacy(team_members.id + ORDER BY project_id)와 다른 신원/프로젝트/org 면 cut 후 권한 드리프트.
- 0건(a∩b∩FK) → flag-on 안전. 1건+ → 처리(앵커부재: members 보정/key 무효화 · 드리프트: 정렬 정합).

env: DATABASE_URL (백엔드 동일, cloud-sql-proxy/in-VPC 경유). 읽기 전용(조회만).
실행: cd backend && DATABASE_URL=... python -m scripts.jobs.audit_apikey_member_anchor
"""
from __future__ import annotations

import asyncio
import os
import sys

from sqlalchemy import text

from app.core.database import async_session_factory

# active(미revoke·미만료) key 중 cut-on이 깨질 row: members(agent,active) 부재
AUDIT_SQL = """
SELECT ak.id            AS api_key_id,
       ak.team_member_id,
       ak.member_id,
       tm.type          AS tm_type,
       tm.is_active     AS tm_active,
       (m.id IS NOT NULL) AS member_exists,
       (m.type = 'agent' AND m.is_active AND m.deleted_at IS NULL) AS member_cut_ok
FROM agent_api_keys ak
LEFT JOIN team_members tm ON tm.id = ak.team_member_id
LEFT JOIN members m       ON m.id = ak.member_id
WHERE ak.revoked_at IS NULL
  AND (ak.expires_at IS NULL OR ak.expires_at > now())
  AND NOT (m.id IS NOT NULL AND m.type = 'agent' AND m.is_active AND m.deleted_at IS NULL)
ORDER BY ak.created_at
"""

# 0080 FK VALIDATE 가드와 동일 기준: member_id referent 부재(active 무관 전 row)
FK_VIOLATION_SQL = """
SELECT count(*) FROM agent_api_keys ak
WHERE ak.member_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM members m WHERE m.id = ak.member_id)
"""

# (b) anchor==legacy 해소 일치(H2 두 번째 축): **유효 앵커가 있어도** cut-on 이 legacy 와 다른 신원/
# 프로젝트로 해소되면 cut 후 권한 드리프트. legacy(auth.py:136)=team_members ORDER BY project_id LIMIT 1,
# anchor(auth.py:119)=agent_project_profiles ORDER BY created_at LIMIT 1 → 멀티프로젝트 agent 는 기본
# 프로젝트가 갈릴 수 있다. member_id≠team_member_id=0075 invariant 파손. org 불일치도 점검.
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
    SELECT app.project_id FROM agent_project_profiles app
    WHERE app.member_id = ak.member_id
    ORDER BY app.created_at ASC LIMIT 1
) anc ON TRUE
WHERE ak.revoked_at IS NULL AND (ak.expires_at IS NULL OR ak.expires_at > now())
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

    print(f"=== (a) cut-on 앵커 부재 위반 active key {len(rows)}건 ===")
    for r in rows:
        print(
            f"  api_key={r['api_key_id']} tm={r['team_member_id']}({r['tm_type']},active={r['tm_active']}) "
            f"member_id={r['member_id']} member_exists={r['member_exists']} cut_ok={r['member_cut_ok']}"
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

    if len(rows) == 0 and fk_bad == 0 and len(parity) == 0:
        print("[PASS] (a)앵커존재 + (b)해소일치 + FK 모두 0 — flag-on 안전(cut 절대전제 충족)")
        return 0
    print("[WARN] 위반 존재 — flag-on 前 처리 필요(앵커부재: members 보정/key 무효화 · 해소드리프트: 기본프로젝트 정렬 정합)")
    return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
