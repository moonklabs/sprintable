"""story #4341 AC4 — 발행 «예산 밖»(`WORKER_TICK_BUDGET_TOO_SMALL`) 명령은 운영 알림을 한 번 보낸다.

예전엔 워커가 예산 밖 명령에 사유만 적고 `logger.error` 한 줄로 끝나 받는 사람이 0이었다(4341 출처). 이제 예산 밖인 동안 **틱마다**
운영 알림 서비스(`operator_alerts.notify_operator`)를 부르고(종류 `publication.over_tick_budget` · 명령마다 멱등 키 하나), 메시지 1은 그 멱등
키가 지킨다. «처음 표시한 틱에만» 부르면 표시 커밋과 알림 사이에 워커가 죽을 때 다음 틱이 «이미 표시됨»으로 건너뛰어 영영 침묵했다(까디르).
"""
from __future__ import annotations

from datetime import UTC, datetime

import pytest

from tests.test_4287_recover_stuck_in_progress_realdb import (  # noqa: F401 — autouse 픽스처(미디어 저장소 · 비밀 키)를 그대로 쓴다
    _REAL_DB_URL,
    _configure_secrets,
    _dispose_global_engine_after_test,
    _local_channel_media_storage,
    _row,
    _session_factory,
    _tick,
    _world,
)

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_an_over_budget_command_alerts_the_operators_once(monkeypatch):
    import app.core.config as config_module
    import app.services.channel_posts as channel_posts_module
    import app.services.operator_alerts as operator_alerts
    from app.services import publication_command as svc
    from app.services.channel_posts import ChannelPublishProviderError
    from app.services.operator_alerts import OperatorAlertResult

    engine, Session = await _session_factory()
    try:
        big = await _world(Session)
        real_worst = svc.command_worst_case_seconds

        async def _worst(db, command):
            return 900 if command.id == big else await real_worst(db, command)

        async def _adapter(db, *, org_id, draft_id, **_kwargs):
            raise ChannelPublishProviderError(provider_code="INSTAGRAM_IMAGE_REQUIRED", provider_message="stub")

        alerts: list[dict] = []

        async def _notify(**kwargs):
            alerts.append(kwargs)
            return OperatorAlertResult(delivered=True, reason="delivered", alert_id=None)

        monkeypatch.setattr(svc, "command_worst_case_seconds", _worst)
        monkeypatch.setattr(channel_posts_module, "publish_channel_post_draft", _adapter)
        monkeypatch.setattr(operator_alerts, "notify_operator", _notify)
        monkeypatch.setattr(config_module.settings, "publication_worker_scheduler_deadline_seconds", 1800)
        monkeypatch.setattr(config_module.settings, "backend_request_timeout_seconds", 300)

        now = datetime.now(UTC)
        await _tick(Session, now)
        big_row = await _row(Session, big)
        assert big_row.reason_code == svc.OVER_TICK_BUDGET_CODE
        assert len(alerts) == 1, alerts
        alert = alerts[0]
        assert alert["kind"] == "publication.over_tick_budget"
        assert alert["dedupe_key"] == svc.over_tick_budget_alert_dedupe_key(big)
        assert alert["target_org_id"] == big_row.org_id
        assert alert["facts"]["code"] == svc.OVER_TICK_BUDGET_CODE
        # 운영 대화에 실제로 실리는지 — 알림 서비스의 거르기가 이 사실 · 대상을 하나도 버리지 않는다(스텁이 가리는 자리).
        from app.services.operator_alerts import sanitize_alert_fields
        assert sanitize_alert_fields(alert["facts"])[1] == [] and sanitize_alert_fields(alert["target"])[1] == []

        await _tick(Session, now)
        assert len(alerts) == 2, "예산 밖인 동안 틱마다 부른다(메시지 1은 멱등 키가 지킨다)"
        assert alerts[1]["dedupe_key"] == alerts[0]["dedupe_key"], "같은 명령은 같은 멱등 키"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_crash_between_the_mark_and_the_alert_still_alerts_once_on_the_next_ticks(monkeypatch):
    """까디르 09-27 — 표시 커밋 뒤 · 알림 전에 워커가 죽은 상태(명령은 이미 `WORKER_TICK_BUDGET_TOO_SMALL` · 알림 행 0)에서 다음 틱이
    **실제 알림 서비스**로 그 명령의 알림 한 건을 남기고, 그다음 틱은 0 더(멱등 키). «처음일 때만» 조건이면 첫 틱에 0 → RED.

    운영 대화 배달(메시지)은 여기서 안 본다: 이 파일은 파괴 스키마 픽스처(`create_all`)라 `team_members`가 뷰가 아닌 표로 만들어져
    시스템 발신자 해석이 성립하지 않는다 — 배달은 비파괴 `test_4341_operator_alerts_realdb.py`가 맡는다. 받는 곳을 비워 두면(설정 0)
    알림은 `pending` 한 행으로 남는다 — 이 테스트가 세는 것은 그 행(명령마다 멱등 키 하나)이다."""
    from sqlalchemy import func, select, update

    import app.core.config as config_module
    import app.services.channel_posts as channel_posts_module
    from app.models.operator_alert import OperatorAlert
    from app.models.publication_command import PublicationCommand
    from app.services import publication_command as svc
    from app.services.channel_posts import ChannelPublishProviderError

    engine, Session = await _session_factory()
    try:
        monkeypatch.setattr("app.core.database.async_session_factory", Session)  # 알림 서비스의 기본 세션 → 이 테스트 DB
        monkeypatch.setattr(config_module.settings, "ops_alert_conversation_id", "")
        big = await _world(Session)
        # 크래시 상태: 표시는 커밋됐고 알림은 한 번도 안 불렸다.
        async with Session() as s:
            await s.execute(update(PublicationCommand).where(PublicationCommand.id == big).values(
                reason_code=svc.OVER_TICK_BUDGET_CODE, last_error="worst case 900s exceeds worker tick budget 240s",
            ))
            await s.commit()
        real_worst = svc.command_worst_case_seconds

        async def _worst(db, command):
            return 900 if command.id == big else await real_worst(db, command)

        async def _adapter(db, *, org_id, draft_id, **_kwargs):
            raise ChannelPublishProviderError(provider_code="INSTAGRAM_IMAGE_REQUIRED", provider_message="stub")

        monkeypatch.setattr(svc, "command_worst_case_seconds", _worst)
        monkeypatch.setattr(channel_posts_module, "publish_channel_post_draft", _adapter)
        monkeypatch.setattr(config_module.settings, "publication_worker_scheduler_deadline_seconds", 1800)
        monkeypatch.setattr(config_module.settings, "backend_request_timeout_seconds", 300)
        key = svc.over_tick_budget_alert_dedupe_key(big)

        async def alert_rows() -> int:
            async with Session() as s:
                return (await s.execute(select(func.count()).select_from(OperatorAlert).where(OperatorAlert.dedupe_key == key))).scalar_one()

        now = datetime.now(UTC)
        await _tick(Session, now)
        assert await alert_rows() == 1, "표시 커밋 뒤 끊긴 명령이 다음 틱에도 알림을 못 남겼다(영영 침묵)"
        await _tick(Session, now)
        assert await alert_rows() == 1, "멱등 — 그다음 틱은 0 더"
    finally:
        await engine.dispose()
