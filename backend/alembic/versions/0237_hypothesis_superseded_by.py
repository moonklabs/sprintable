"""hypotheses.superseded_by_hypothesis_id — story #2533(E-FLOW-V4 S3) 정반합 self-FK.

Revision ID: 0237
Revises: 0236
Create Date: 2026-08-09

배경: doc `flow-board-v4-hypothesis-scale` §3이 "falsified→대체 새 가설" 정반합 체인을
v4 서사의 명시 축으로 요구하는데, 이걸 표현할 1급 컬럼이 원래 없었다(PO가 최초 "실재한다"고
서술한 게 실측 前 포장이었음 — 디디·미르코 독립 그라운딩으로 정정, 2026-08-09). PO 판정(A,
근본): self-FK 신설 + **명시 확認된 페어만** 백필(텍스트 자동 페어링 절대 금지 — 없는 데이터
지어내기 방지 원칙이 백필에도 그대로 적용).

확認된 유일한 페어: `2cbdd1a9-08c5-47cc-b885-65deeabda6a2`(falsified, "체크아웃을 2단계로
줄이면 결제 완료율이 오른다") → `724dde46-5af0-481f-89ef-0783c4283fa3`(proposed, "[유나 편집]
결제 완료율은 단계 수보다 신뢰 신호(리뷰·보안 배지)에 더 크게 좌우될 것이다"). 근거(디디·
미르코 각자 dev DB 직접 조회로 독립 확認, 2026-08-09):
  - 같은 project_id(f3e6ed64-...) — 다른 후보(a794cca7, 영어 재기술)는 **다른 project_id**라
    배제(cross-project 정반합은 의미 자체가 성립 안 함).
  - 같은 날 3시간 뒤 생성(falsified 13:44 → proposed 16:44) — 시간적으로 직접 이어짐.
  - 문장 자체가 falsified 가설의 인과 변수를 정확히 반박·재구성("단계 수" → "신뢰 신호") —
    doc §3이 예시로 든 "「체크아웃 2단계」→「신뢰 신호」 대체" 문구와 정확히 일치.
  - `724dde46.source_type='retro_synthesis'`(레트로 합성 경로 생성) — falsified 판정 직후
    같은 레트로 세션에서 다음 가설로 재구성된 흐름과 정합.
그 외 falsified 1건(`c64d2a5b`, 이미지 레퍼런스 관련)은 같은 project 내 명확한 후속 후보를
못 찾아 **백필 안 함**(null 유지 — "아직").

write path(가설이 falsified로 전이할 때 대체 가설을 UI로 잇는 것)는 이 스토리 스코프 밖 —
후속 스토리(PO 예정)에서 다룬다. 이 마이그레이션은 스키마 + 확認된 과거 페어 백필까지만.
"""
from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from alembic import op

revision = "0237"
down_revision = "0236"
branch_labels = None
depends_on = None

_FALSIFIED_ID = "2cbdd1a9-08c5-47cc-b885-65deeabda6a2"
_SUCCESSOR_ID = "724dde46-5af0-481f-89ef-0783c4283fa3"


def upgrade() -> None:
    op.add_column(
        "hypotheses",
        sa.Column("superseded_by_hypothesis_id", UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_hypotheses_superseded_by",
        "hypotheses",
        "hypotheses",
        ["superseded_by_hypothesis_id"],
        ["id"],
        ondelete="SET NULL",
        deferrable=True,
        initially="DEFERRED",
    )
    # 확認된 단일 페어만 백필(위 docstring 근거) — 조건절로 두 행이 실제 존재할 때만 적용.
    op.execute(
        f"""
        UPDATE hypotheses SET superseded_by_hypothesis_id = '{_SUCCESSOR_ID}'
        WHERE id = '{_FALSIFIED_ID}'
          AND EXISTS (SELECT 1 FROM hypotheses WHERE id = '{_SUCCESSOR_ID}')
        """
    )


def downgrade() -> None:
    op.drop_constraint("fk_hypotheses_superseded_by", "hypotheses", type_="foreignkey")
    op.drop_column("hypotheses", "superseded_by_hypothesis_id")
