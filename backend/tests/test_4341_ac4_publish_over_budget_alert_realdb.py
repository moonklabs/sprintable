"""story #4341 AC4 — 발행 «예산 밖»(`WORKER_TICK_BUDGET_TOO_SMALL`) 명령은 운영 알림을 한 번 보낸다.

예전엔 워커가 예산 밖 명령에 사유만 적고 `logger.error` 한 줄로 끝나 받는 사람이 0이었다(4341 출처). 이제 처음 예산 밖으로 표시되는
틱에서 운영 알림 서비스(`operator_alerts.notify_operator`)를 부른다 — 종류 `publication.over_tick_budget` · 명령마다 멱등 키 하나 ·
표시가 그대로인 다음 틱은 다시 부르지 않는다(멱등 키로 메시지 1도 서비스가 지킨다 — 두 겹). 예산이 커져 집히면 표시가 지워진다.
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
        assert len(alerts) == 1, "표시가 그대로인 다음 틱은 다시 알리지 않는다"
    finally:
        await engine.dispose()
