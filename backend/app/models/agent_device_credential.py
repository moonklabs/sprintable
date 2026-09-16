"""기기별 자격증명(per-device credential) — 정적 API 키(sk_live_*)의 blast radius를 좁힌다.

배경: `sk_live_*` 는 org 전역 장수명 bearer 비밀이라 노트북 1대를 잃으면 org 전체 키를
회전해야 하고, 그 회전이 연결된 모든 에이전트를 끊는다. 이 테이블은 **기기 단위**로
등록·폐기 가능한 자격증명을 둔다(revoke 1대로 그 기기만 끊긴다) — 방어적 변경이다.

⚠️평문 비밀을 저장하지 않는다 — **공개키(DER)만** 저장하고 개인키는 서버에 오지 않는다.
그래서 이 테이블에는 흔히 있는 `key_hash`/`key_prefix`/서명값 컬럼이 **없다**(탈취할
장수명 bearer 비밀이 애초에 존재하지 않는다 — `agent_api_keys`/`human_api_keys` 와 다른 점).

`device_installations`(app/models/device_installation.py)와 개념만 차용하고 목적은 다르다:
그쪽은 App Attest/Play Integrity 기반 **앱 무결성 증명**이고, 이쪽은 키쌍 기반 **기기
식별·폐기**다. 앱 무결성(attestation) 계층은 이 모델에 없다 — 자체호스팅에서도 성립해야
하는 계층이라 의도적으로 분리돼 있다.
"""
import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    LargeBinary,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AgentDeviceCredential(Base):
    """기기 자격증명 1행 = (휴먼 member 1명, 기기 라벨 1개).

    `member_id` = 등록한 휴먼의 members.id(폐기 권한의 축 — 남의 기기를 못 건드린다).
    `agent_member_id` = 이 자격증명으로 인증되는 에이전트의 members.id(인증 해소 축).
    0075 1:1 불변식(members.id = team_member.id)으로 `_resolve_api_key` 의 신원 해소와
    같은 id 공간이라 소비처가 두 경로를 구분 없이 태운다.
    """

    __tablename__ = "agent_device_credentials"
    __table_args__ = (
        UniqueConstraint("member_id", "device_label", name="uq_agent_device_credentials_member_label"),
        # 인증 hot-path는 **active 행만** 조회한다 — 폐기된 기기는 후보에서 아예 빠져야 하고,
        # revoked 행이 인덱스에 남아 스캔을 늘릴 이유가 없다.
        Index(
            "ix_agent_device_credentials_key_fingerprint_active",
            "key_fingerprint",
            postgresql_where=text("status = 'active'"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    member_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("members.id", ondelete="CASCADE"), nullable=False, index=True
    )
    agent_member_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("members.id", ondelete="CASCADE"), nullable=False, index=True
    )
    device_label: Mapped[str] = mapped_column(Text, nullable=False)
    # 등록 시 클라이언트가 제출한 공개키(DER, SubjectPublicKeyInfo). 개인키는 서버에 없다.
    # ⚠️자체호스팅 경로는 앱 무결성 증명이 없어 "그 공개키가 진짜 그 앱에서 났다"는 보증이
    # 없다 — 그건 attestation 계층 몫이고 여기서 대리하지 않는다(이 모델은 서명 검증만 한다).
    public_key_der: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    key_fingerprint: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="active", server_default="active"
    )  # active | revoked
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 리플레이 방어용 서버 발급 단조 증가 카운터(CAS). NULL = 아직 한 번도 인증 못 함.
    last_server_seq: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
