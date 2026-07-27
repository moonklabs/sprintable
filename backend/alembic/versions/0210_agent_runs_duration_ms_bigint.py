"""story #2161/#2181(2026-07-24, 오르테가군 라이브 발견) — agent_runs.duration_ms int32 overflow.

Revision ID: 0210
Revises: 0209
Create Date: 2026-07-24

리퍼(app/services/agent_run_lifecycle.py, story #2161) 등록 전 오르테가군이 직접 호출해보다
발견 — 오래 stuck된 running run을 abandoned로 전이하며 finished_at을 쓰는 순간
`duration_ms`(GENERATED, `integer` 32bit)가 계산되는데, `started_at`이 오래된(#2161 0208
백필로 `created_at`이 들어간 레거시 run 포함) run은 `(finished_at - started_at)`이 ~24.83일
(2,147,483,647ms = INT32_MAX)을 넘으면 `asyncpg.NumericValueOutOfRangeError: integer out of
range`로 UPDATE 자체가 실패한다. 스케줄 등록 前 라이브 호출로 잡음 — 등록됐으면 10분마다
조용히 500 나며 아무 run도 안 걷혔을 것(#2181과 같은 가족: GENERATED 컬럼 제약이 코드
어디에도 안 보이던 자리, 4번째 사례).

**처방 판단(오르테가군 요청 — 근거 명시)**:
- ⛔"전이 시 finished_at 안 쓰기"는 배제 — #2161이 고치던 "사망시각 기록 없음" 병을 다시
  불러오는 것이라(반대 방향 회귀).
- ⛔"계산식을 INT32 상한으로 clamp"도 배제 — 오래 stuck된 run의 실제 지속시간을 거짓값으로
  위장하는 것이라 오늘 하루 지켜온 "완료로 위장 금지"와 같은 원칙 위반(진실을 안 잃는 쪽).
- ✅**타입 확장(bigint)** — 유일하게 진실을 안 잃는 선택. bigint 상한(~9.2×10^18ms ≈ 2.9억년)은
  현실적인 어떤 run 지속시간도 넘지 않는다.

⚠️`ALTER COLUMN ... TYPE bigint`만으로는 부족함을 로컬 실PG로 직접 확認했다 — GENERATED
표현식 내부의 `::integer` 캐스팅이 여전히 원본 그대로 남아 같은 자리에서 오버플로된다(외부
컬럼 타입만 넓히고 내부 캐스팅은 안 바뀜). DROP COLUMN + 재-ADD로 표현식 자체의 캐스팅을
`::bigint`로 교체해야 한다(Postgres는 GENERATED 표현식을 in-place ALTER 못 함).
`duration_ms_legacy`(백필-only, 여전히 32bit)도 CASE 분기에서 `::bigint`로 캐스팅.

백필 불요(GENERATED STORED 컬럼 재-ADD 시 Postgres가 기존 행 전부를 자동 재계산).
"""
from __future__ import annotations

from alembic import op

revision = "0210"
down_revision = "0209"
branch_labels = None
depends_on = None

_NEW_EXPR = """
CASE
    WHEN ((finished_at IS NOT NULL) AND (started_at IS NOT NULL)) THEN GREATEST(((EXTRACT(epoch FROM (finished_at - started_at)) * (1000)::numeric))::bigint, (0)::bigint)
    WHEN (duration_ms_legacy IS NOT NULL) THEN (duration_ms_legacy)::bigint
    ELSE NULL::bigint
END
""".strip()


def upgrade() -> None:
    op.execute("ALTER TABLE agent_runs DROP COLUMN duration_ms")
    op.execute(f"ALTER TABLE agent_runs ADD COLUMN duration_ms bigint GENERATED ALWAYS AS ({_NEW_EXPR}) STORED")


def downgrade() -> None:
    _OLD_EXPR = """
CASE
    WHEN ((finished_at IS NOT NULL) AND (started_at IS NOT NULL)) THEN GREATEST(((EXTRACT(epoch FROM (finished_at - started_at)) * (1000)::numeric))::integer, 0)
    WHEN (duration_ms_legacy IS NOT NULL) THEN duration_ms_legacy
    ELSE NULL::integer
END
""".strip()
    op.execute("ALTER TABLE agent_runs DROP COLUMN duration_ms")
    op.execute(f"ALTER TABLE agent_runs ADD COLUMN duration_ms integer GENERATED ALWAYS AS ({_OLD_EXPR}) STORED")
