"""E-VERIFY V0-S1(story 5a5ba27b): Evidence 1급 객체 — 에이전트 자기증명.

done의 검사지가 아니라 에이전트가 자기 완결을 표현하는 서명(blueprint `e-verify-v0-blueprint`
§0 제1원칙: 감시가 아니라 신뢰). Gate(app/models/gate.py)의 검증된 polymorphic 패턴을 그대로
재사용 — work_item_id/work_item_type에 FK 없음(Story/Task 양쪽 커버), org_id만 인덱스.
"""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

EVIDENCE_TYPES = frozenset({"url", "file", "pr", "deploy", "metric", "report", "gate_approval"})

# gate_approval은 시스템(V0-S2 게이트 승인 훅)만 생성 — 공개 API/MCP로 직접 생성 시 스푸핑
# 위험(에이전트가 "이거 승인됐음" 허위 서명 가능)이라 라우터 레벨에서 별도 차단.
_CLIENT_CREATABLE_TYPES = EVIDENCE_TYPES - {"gate_approval"}


class Evidence(Base):
    __tablename__ = "evidence"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    work_item_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    work_item_type: Mapped[str] = mapped_column(String(20), nullable=False)
    type: Mapped[str] = mapped_column(String(20), nullable=False)
    ref: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str | None] = mapped_column(Text, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # story #3497(migration 0332, 페드루 決定 2026-09-05) — nullable로 완화. NULL=
    # 특정 행위자 없는 순수 시스템 기록(activity_log의 actor_type=platform·actor_id=
    # None과 동류, 예: 인사이트 스냅샷 evidence) — NIL UUID 같은 센티널로 "없는
    # 행위자를 지어내지" 않는다. routers/evidence.py의 소유 검사는 None이면 "내
    # 것 아님"으로 읽는다(플랫폼 기록은 멤버가 수정 못 함 — 의도).
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # story #2722(아티팩트·evidence 버전 pin) — 이 evidence가 아티팩트를 근거로 삼을 때
    # "그 시각의 그 버전"을 고정한다. artifact_versions.artifact_id가 이미 visual_artifacts를
    # 함의하므로 별도 visual_artifact_id 컬럼은 안 둔다(비정규화 회피). NULL=버전 미상
    # (구 데이터이거나 아티팩트를 근거로 안 삼은 evidence) — 소급 백필 없음.
    artifact_version_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("artifact_versions.id", ondelete="SET NULL"), nullable=True
    )
    # story #3497(migration 0332) — type="metric"(채널 인사이트) 전용 구조화 칸. note는
    # "한 겹 얕은 원본"이라 대시보드·「채널 원본 지표와 evidence 대조」가 text 파싱에
    # 얹히면 두 번째 지름길이 된다(페드루 決定, 2026-09-05) — 정규화된 7키(impressions·
    # reach·views·engagements·clicks·spend·conversions, 각 int|null)·captured_at·
    # source·snapshot_id를 여기 그대로 싣는다. captured_at 전용 컬럼은 신설 안 함
    # (insight_snapshots 행이 정본, payload는 그 스냅샷의 사본). NULL=이 evidence가
    # metric이 아니거나(다른 type) 구 데이터.
    payload: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
