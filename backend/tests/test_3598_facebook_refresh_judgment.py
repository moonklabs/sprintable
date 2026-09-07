"""story #3598(BE·중형, PO 確定 2026-09-06) — 確定③ FB 사전 갱신 필요성 판정.

Meta 문서 인용(channel_adapters.py::"facebook" refresh_mode 주석에 전문) — 장기
사용자 토큰으로 얻은 페이지 액세스 토큰은 시간 경과로 만료되지 않는다(비밀번호
변경·권한 회수·앱 비활성 등 사용자/보안 행동으로만 무효화). 결론: FB에 필요한 건
«갱신»이 아니라 «무효화 감지»(이 스토리의 classify_graph_oauth_error·샌드박스
마커 3종이 담당) — refresh_mode를 "reissue_from_access_token"(threads류, 자동
갱신 가능)에서 "manual"(자동 갱신 불가 — 재인증 유도)로 정정한다.

이전엔 refresh_mode가 잘못 선언돼 있어 can_auto_refresh()가 True를 내
list_connections_due_for_refresh()가 facebook 연결을 매 tick "갱신 대상"으로
집어 왔지만 cron._REFRESH_FN_BY_CHANNEL에 facebook이 없어 조용히 continue만
반복하던 죽은 경로였다(무해하나 FE can_auto_refresh 플래그도 거짓)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_620beefc_channel_post_image_upload import (
    _client_for,
    _seed_org,
    _session_factory,
    _setup_org_scoped_app,
)

pytestmark = [
    pytest.mark.destructive_schema,
]


@pytest.fixture(autouse=True)
def _configure_secrets(monkeypatch):
    """test_620beefc_channel_post_image_upload.py의 동형 fixture 재사용(import 대신
    복붙 — 그 파일의 autouse는 그 모듈 안에서만 적용된다)."""
    import importlib
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())

    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


def test_facebook_adapter_declares_manual_refresh_not_auto():
    """순수 단위 — 어댑터 선언 자체가 정정됐는지(DB 불요)."""
    from app.services.channel_adapters import can_auto_refresh, get_channel_adapter

    adapter = get_channel_adapter("facebook")
    assert adapter is not None
    assert adapter.refresh_mode == "manual"
    assert can_auto_refresh(adapter.refresh_mode) is False


@pytest.mark.anyio
async def test_facebook_connection_near_expiry_is_not_selected_for_auto_refresh():
    """⭐뮤테이션 표적 — refresh_mode를 되돌리면(reissue_from_access_token) 이 테스트가
    RED로 떨어진다: facebook 연결이 만료 임박이어도 list_connections_due_for_refresh()
    가 절대 집지 않는다(갱신 함수가 없어 죽은 경로로 매 tick 낭비되던 결함의 회귀
    가드)."""
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_adapters import get_channel_adapter
    from app.services.channel_connection import list_connections_due_for_refresh
    from app.services.channel_credential_crypto import encrypt_channel_credential

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            adapter = get_channel_adapter("facebook")
            assert adapter is not None
            conn = ChannelConnection(
                id=uuid.uuid4(), org_id=org_id, channel="facebook",
                account_id=f"page-{uuid.uuid4().hex[:8]}", status="active",
                credential_kind="oauth", refresh_mode=adapter.refresh_mode,
                encrypted_access_token=encrypt_channel_credential("page-token"),
                # 만료 임박(REFRESH_LEAD_TIME=48h 이내) — 예전 버그였다면 이 값 때문에
                # 갱신 대상으로 집혔을 표본.
                token_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
            )
            s.add(conn)
            await s.commit()

            due = await list_connections_due_for_refresh(s, now=datetime.now(timezone.utc))
            assert conn.id not in {row.id for row in due}, (
                "facebook은 manual refresh_mode라 애초에 갱신 대상 목록에 오르면 안 된다"
            )
    finally:
        await engine.dispose()
