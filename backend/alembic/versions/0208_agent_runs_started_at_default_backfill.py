"""story #2161(2026-07-24) — agent_runs.started_at DEFAULT 복구 + 백필 + NOT NULL.

Revision ID: 0208
Revises: 0207
Create Date: 2026-07-24

CI real-PG 스위트(까심 실측, #2478 리뷰)가 잡음: `app/models/agent_run.py`의 `started_at`은
`server_default=func.now(), nullable=False`라고 선언돼 있었으나, 실 DB(baseline schema.sql)엔
`started_at timestamp with time zone,`뿐 — DEFAULT도 NOT NULL도 실제로는 없었다. 모델의
server_default는 "DB가 채워줄 것"이라 믿고 INSERT에서 컬럼 자체를 생략하는데, 그 DB에 정말
DEFAULT가 없으니 Postgres가 그 자리에 NULL을 넣어왔다 — `POST /agent-runs`로 생성되는 **모든**
run이 (레거시뿐 아니라 지금 이 순간 만들어지는 것도) started_at=NULL이었다는 뜻이다.

오르테가군 판정(#2478 리뷰) — "DB가 맞다(Optional로 순응)" 대신 "스키마가 맞다, NULL 행이
왜 생기는지가 진짜 결함"을 먼저 볼 것: "시작 기록이 없는 실행"은 #2161이 다루는 "끝 기록이
없는 실행"과 같은 병의 다른 얼굴이다. 그래서 응답 스키마를 물러서지 않고 DB 쪽을 모델의
원래 의도(server_default=now(), NOT NULL)에 맞게 고친다:

1. DEFAULT 복구 — 앞으로 생성되는 모든 run은 실제로 now()를 받는다.
2. 백필 — 기존 NULL 행은 created_at(row 자체의 진짜 생성 시각, DEFAULT now() NOT NULL로
   이미 신뢰 가능)으로 채운다. 정확한 순간을 모른다는 사실을 숨기지 않되(창작하지 않되),
   가진 것 중 가장 근접하고 진짜인 신호를 쓴다 — created_at과 started_at은 현재 코드
   경로상 사실상 동시 이벤트(같은 POST 호출 안에서 row가 만들어지는 순간).
3. NOT NULL — 1·2가 전건을 커버하므로 모델의 원래 선언이 마침내 사실이 된다.

⚠️백필은 되돌리지 않음(downgrade는 DEFAULT/NOT NULL만 되돌림 — 0203 backfill 선례와 동형,
데이터 손실 없는 안전한 되돌림만).
"""
from __future__ import annotations

from alembic import op

revision = "0208"
down_revision = "0207"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE agent_runs ALTER COLUMN started_at SET DEFAULT now()")
    op.execute("UPDATE agent_runs SET started_at = created_at WHERE started_at IS NULL")
    op.execute("ALTER TABLE agent_runs ALTER COLUMN started_at SET NOT NULL")


def downgrade() -> None:
    op.execute("ALTER TABLE agent_runs ALTER COLUMN started_at DROP NOT NULL")
    op.execute("ALTER TABLE agent_runs ALTER COLUMN started_at DROP DEFAULT")
