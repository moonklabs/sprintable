"""story #1616(측정선행): agent_audit_logs — (org_id, event_type, created_at DESC) 인덱스 추가.

관련: A3 `f4a882cc`(별도 사설 internal-api 레포의 admin audit 조회 — 현재 safe-mode로
org_id 필수+7일 윈도우+limit<=50 제한 하에서만 동작). 원 스토리는 이 테이블에 PK 외
인덱스가 전혀 없다고 가정했으나 실측 결과 오류 — baseline schema.sql에 이미 4개 인덱스가
있다: idx_agent_audit_logs_event_type(event_type, created_at DESC) ·
idx_agent_audit_logs_org_project_created(org_id, project_id, created_at DESC) ·
idx_agent_audit_logs_run(run_id, created_at DESC) WHERE run_id IS NOT NULL ·
idx_agent_audit_logs_session(session_id, created_at DESC) WHERE session_id IS NOT NULL.

**측정 방법**: 로컬 pg@16(alembic head 적용) 스크래치 DB에 org_id/project_id 분포가 현실적인
~1.075M행(150 org 균등분포 org당 ~6-7k행·4 project + medium org 25k행(전체 2.3%) + mega org
150k행(전체 14%, 의도적 극단치))을 시드하고 "safe-mode 해제" 후 실제 목표 접근 패턴
(org 전역·project_id 미필터·시간창 미제한, ORDER BY created_at DESC LIMIT 50)을
EXPLAIN(ANALYZE, BUFFERS)로 실측.

**결과 A — org만 필터(프로젝트/이벤트타입 무필터)**: 기존
idx_agent_audit_logs_org_project_created 로 Bitmap Heap Scan + top-N heapsort. 실측 6~52ms
(0.58%~14% 선택도 전 구간, 후자는 비현실적 극단치인데도) — 신규 인덱스 불필요로 판정,
추가하지 않음.

**결과 B — org + event_type 필터**: 기존 idx_agent_audit_logs_event_type(event_type,
created_at DESC) 를 org_id는 사후 Filter로만 적용하는 Index Scan으로 처리 — 대상 org의
전역 event_type 점유율이 낮을수록 스캔해야 하는 행 수가 O(1/점유율)로 증가. 실측: 점유율
0.58% org 기준 웜캐시 12.2ms(6565 버퍼)·콜드캐시 46.7ms(디스크 read 4817+hint-bit write
1703) — 프로덕션 규모(테이블이 더 크고 org별 점유율이 이보다 낮은 경우 흔함)에서 이 패턴은
구조적으로 더 악화된다. → **증명된 갭**. `(org_id, event_type, created_at DESC, id DESC)`
인덱스 추가 후 동일 케이스 재측정: Index Scan 단독(정렬 노드 소멸)으로 0.44ms(버퍼 54개) —
전 org 규모(0.58%/2.3%/14%)에서 균일하게 <1ms. `id DESC`는 created_at 동시분 tie-break용
(무제한창 페이지네이션이 안정적 순서를 요구 — AC 권고 그대로).

AC가 제시한 두 후보 중 `(org_id, created_at DESC, id DESC)`는 결과 A가 이미 충분히 빠름을
증명했으므로 **추가하지 않는다**(반사적 양쪽 추가 금지 — 실측이 가리키는 것만).

전체 측정 방법론·EXPLAIN 원문(트림)은 PR 본문 참고.

Revision ID: 0202
Revises: 0201
Create Date: 2026-07-19
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0202"
down_revision = "0201"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "idx_agent_audit_logs_org_event_created",
        "agent_audit_logs",
        ["org_id", "event_type", sa.text("created_at DESC"), sa.text("id DESC")],
    )


def downgrade() -> None:
    op.drop_index("idx_agent_audit_logs_org_event_created", table_name="agent_audit_logs")
