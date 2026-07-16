"""story 9ac9b80f(FR·대표요청): stories에 프로젝트 스코프 사람-읽는 sequential #N 추가.

⚠️⚠️⚠️ **prod-only fork 마이그** — develop의 `0194_stories_sequential_number.py`(down_revision
"0193")와 **DDL이 byte-identical**(upgrade/downgrade 본문 무변경, 헤더만 다름)한 별도 리비전.
선생님 확定(2026-07-16): FR 2건(스탠드업 core+이슈 ID)만 prod로 먼저 승격하고 auth 마이그
(0184~0193)는 develop에 남긴다 — develop 원본 0194는 down_revision="0193"이라 auth 마이그
없는 prod(head=0183)엔 직접 적용 불가. 이 파일은 그 DDL을 prod head(0183) 바로 위에 재배치한
것 — story_number는 auth 테이블(device_installations 등)과 FK/로직 의존 0(순수 stories 테이블
컬럼)이라 안전하게 독립 적용 가능함을 확인함.

id(UUID)는 canonical PK로 그대로 유지 — story_number는 additive 참조 편의 컬럼
(project_id 내에서만 유일, PR/GitHub issue 넘버링과 동형). 신규 write는
app.repositories.story.allocate_story_number(advisory xact lock 기반 race-safe
채번)가 채운다.

기존 행 백필: (project_id, created_at, id) 순서로 프로젝트별 1부터 연속 채번(soft-delete된
행도 포함 — 번호는 GitHub issue처럼 재사용/스킵 없이 생성순 그대로 유지). set-based 단일
UPDATE(윈도우 함수)라 대상 규모와 무관하게 안전.

⚠️ nullable=True 유지(NOT NULL로 안 조인다): Story를 StoryRepository.create()/oss_seed 우회해
직접 ORM construct하는 기존 테스트 fixture가 리포지토리 전역에 51개 존재(이 스토리와 무관한
다른 에픽들) — NOT NULL로 조이면 전부 깨진다. 실 생성 경로(REST API·oss_seed) 둘 다 이미
allocate_story_number를 항상 호출하므로 실 데이터는 전부 non-null. Postgres UNIQUE는 NULL을
서로 다른 값으로 취급해 다건 NULL과 무충돌 공존(non-null 값끼리는 여전히 프로젝트 내 유일 강제).

🚨 **미래 auth 전체 prod 승격 시 divergence 해소 절차**(develop을 main에 merge할 때 — 그 시점의
담당자가 반드시 수행):
1. git merge로 develop의 0184~0194(원본, down_revision="0193")가 main에 그대로 들어오면,
   alembic 그래프가 0183에서 두 갈래로 갈라진다: (A) 0183→0183a(이 파일, prod-only) (B)
   0183→0184→…→0193→0194(develop 원본). `alembic heads`가 2개 head를 보고할 것이다.
2. prod DB는 이미 0183a를 거쳐 story_number 컬럼+제약을 갖고 있음(0184~0193의 auth 테이블은
   아직 없음) — 그대로 `alembic upgrade head`를 돌리면 develop 원본 0194가 `ADD COLUMN
   story_number`를 재실행하려다 "column already exists"로 실패한다.
3. 올바른 순서: ① `alembic upgrade 0193`(0184~0193 auth 마이그를 실제로 실행 — prod엔 처음
   적용되는 것들) ② `alembic stamp 0194`(DDL 재실행 없이 prod의 추적 리비전만 0194로 이동 —
   이 파일과 develop 0194가 byte-identical DDL이므로 안전) ③ 코드베이스에 **머지 리비전**
   추가: `revision=<new>, down_revision=("0183a", "0194"), upgrade(): pass, downgrade(): pass`
   로 그래프를 단일 head로 재수렴(순수 그래프 결합, 실제 DB 변경 없음) — head 1개 되어야
   이후 `alembic upgrade head`가 다시 모호함 없이 동작한다.

Revision ID: 0183a
Revises: 0183
Create Date: 2026-07-16
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0183a"
down_revision = "0183"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("stories", sa.Column("story_number", sa.Integer(), nullable=True))

    op.execute(
        """
        UPDATE stories s
        SET story_number = sub.rn
        FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at, id) AS rn
            FROM stories
        ) sub
        WHERE s.id = sub.id
        """
    )

    op.create_unique_constraint(
        "uq_stories_project_id_story_number", "stories", ["project_id", "story_number"]
    )


def downgrade() -> None:
    op.drop_constraint("uq_stories_project_id_story_number", "stories", type_="unique")
    op.drop_column("stories", "story_number")
