"""E-MEMBER-SSOT AC3-1b AC2: agent_api_keys 앵커 정합 감사 (H2).

`member_ssot_apikey_cut=on`의 _resolve_api_key는 `members(id=api_key.member_id, type='agent',
is_active, not deleted)`를 요구한다. 0076은 agent_api_keys 전 row에 member_id=team_member_id를
dual-write 했고 0075는 type='agent' team_member만 members에 넣었으므로, **active key 중**
(a) tm.type != 'agent' 이거나 (b) members(agent) 행이 부재이면 cut-on 시 401(생명선 차단)이 된다.

이 스크립트는 그런 **위반 active key**를 나열한다.
- 0건  → flag-on 안전 + 0080 FK VALIDATE 통과.
- 1건+ → 처리 필요: 정당 agent면 members 보정(또는 agent_anchor_sync 재실행), human/오용 key면 무효화.

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


async def main() -> int:
    if not os.environ.get("DATABASE_URL"):
        print("[FAIL] DATABASE_URL 필요", file=sys.stderr)
        return 2
    async with async_session_factory() as s:
        rows = (await s.execute(text(AUDIT_SQL))).mappings().all()
        fk_bad = (await s.execute(text(FK_VIOLATION_SQL))).scalar_one()

    print(f"=== AC2 H2 감사: cut-on 위반 active key {len(rows)}건 ===")
    for r in rows:
        print(
            f"  api_key={r['api_key_id']} tm={r['team_member_id']}({r['tm_type']},active={r['tm_active']}) "
            f"member_id={r['member_id']} member_exists={r['member_exists']} cut_ok={r['member_cut_ok']}"
        )
    print(f"=== 0080 FK VALIDATE 위반(members 부재 referent, 전 row) {fk_bad}건 ===")

    if len(rows) == 0 and fk_bad == 0:
        print("[PASS] 위반 0건 — flag-on 안전 + 0080 FK VALIDATE 통과 예상")
        return 0
    print("[WARN] 위반 존재 — flag-on 전 처리 필요(정당 agent: members 보정 / human·오용: key 무효화)")
    return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
