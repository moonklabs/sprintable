"""story #4303(PO 02:15Z · C안) — 0075 백필이 빠뜨린 떠난 사람에게 이름만 든 members 행을 채운다.

0075는 `org_members.deleted_at IS NULL`인 사람만 members 행과 별칭(member_identity_aliases)을 만들었다. 그때 이미 떠났거나
org_members 행이 아예 없는 옛 사람은 둘 다 없어서, 이후 id 정규화 마이그(0078 · 0081 · 0086 · 0092 — 전부 별칭을 거침)도
그들의 기록을 옛 team_members_legacy id 그대로 남겼다 → 이름 풀이가 그 id를 못 찾아 «알 수 없는 구성원».

여기서는 기록(dev 뭉클랩 612곳)을 건드리지 않고, **옛 legacy id를 그대로 members.id로** 이름만 든 행을 만든다 — 에이전트가
이미 쓰는 «members.id = team_member.id» 관례와 같다. 개인 정보는 이름 · 종류뿐(user_id · avatar_url · org_role · handle NULL ·
is_active false · deleted_at 채움). user_id가 없으니 로그인 · 권한 경로에 못 들어가고, project_access가 없으니 team_members 뷰에도 안 잡힌다.

대상(술어 · 환경마다 행이 다름 — id 목록을 박지 않는다):
  legacy 휴먼 행 · 별칭 없음 · 같은 id의 members 행 없음 · 조직이 있음 · 같은 (조직, 사용자)의 **남아 있는** org_members 행 없음
  (남아 있는 사람인데 별칭만 빠진 경우는 다른 틈이라 여기서 «떠난 사람» 행을 지어내지 않는다).
deleted_at = org_members에 떠난 시각이 있으면 그 시각 · 없으면 legacy 행의 deleted_at · 둘 다 없으면 이 마이그 시각(now()).
  legacy updated_at은 «마지막으로 고친 때»지 떠난 때가 아니라 떠난 시각을 지어내지 않는다 — 모르는 건 «이 행을 만든 때»로 둔다.
  즉 deleted_at = 마이그 시각인 행은 «떠난 시각 모름»(org_members 행이 애초에 없던 옛 사람)이라는 뜻이다.
dev dry-run(PO runq 02:44Z · 이 술어 그대로): 12행(뭉클랩) — deleted_at 근거 org_members 3 · legacy 0 · 마이그 시각 9.
  예측(02:15Z) 14와의 차이 2 = 조직 행이 없는(삭제된) 두 조직(19d2bcf7 · ddfe1365)의 사람 — members.org_id FK라 넣을 수 없고
  그 조직 기록은 알림 설정 1곳뿐이라 화면에 닿지 않는다.

되돌리기: 같은 술어로 되짚어 이 마이그가 만든 모양의 행만 지운다 — type human · user_id NULL · deleted_at 있음 · id ∈ legacy 휴먼 · 별칭 없음.
  (떠남 흐름 `delete_org_member`가 남기는 members 행은 user_id를 그대로 두고 deleted_at도 비워 두므로 겹치지 않는다.)

번호: origin/develop alembic head 0413 다음. 착지 순서가 바뀌면 사다리로 다시 매긴다(디디 4299 ②와 겹칠 수 있음 · PO 02:15Z).

Revision ID: 0414
Revises: 0413
"""
from alembic import op

revision = "0414"
down_revision = "0413"
branch_labels = None
depends_on = None

# 업 · 다운이 같은 술어를 쓰도록 한 곳에 둔다. `tl` = team_members_legacy 휴먼 행.
_LEGACY_HUMAN_WITHOUT_ALIAS = """
    tl.type = 'human'
    AND NOT EXISTS (SELECT 1 FROM member_identity_aliases a WHERE a.alias_id = tl.id)
"""


def upgrade() -> None:
    op.execute(
        f"""
        INSERT INTO members (id, org_id, type, user_id, owner_member_id, name, avatar_url, handle, org_role,
                             is_active, created_at, updated_at, deleted_at)
        SELECT tl.id, tl.org_id, 'human', NULL, NULL, tl.name, NULL, NULL, NULL,
               false, tl.created_at, now(),
               COALESCE(
                   (SELECT max(om.deleted_at) FROM org_members om
                     WHERE om.org_id = tl.org_id AND om.user_id = tl.user_id AND om.deleted_at IS NOT NULL),
                   tl.deleted_at,
                   now()  -- 떠난 시각 모름(org_members 행이 없던 옛 사람) → 이 행을 만든 때
               )
        FROM team_members_legacy tl
        JOIN organizations o ON o.id = tl.org_id
        WHERE {_LEGACY_HUMAN_WITHOUT_ALIAS}
          AND NOT EXISTS (SELECT 1 FROM members m WHERE m.id = tl.id)
          AND NOT EXISTS (
              SELECT 1 FROM org_members om
               WHERE om.org_id = tl.org_id AND om.user_id = tl.user_id AND om.deleted_at IS NULL
          )
        ON CONFLICT (id) DO NOTHING
        """
    )


def downgrade() -> None:
    op.execute(
        f"""
        DELETE FROM members m
        USING team_members_legacy tl
        WHERE m.id = tl.id
          AND {_LEGACY_HUMAN_WITHOUT_ALIAS}
          AND m.type = 'human'
          AND m.user_id IS NULL
          AND m.deleted_at IS NOT NULL
        """
    )
