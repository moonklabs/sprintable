"""story #2041(그라운딩 doc 67b44d1e, PR-D) — storage 크론 2종(assets-grace-hard-delete·
storage-usage-warn) 회귀가드.

핵심 검증축(PR-C의 GA4 검증과 동형 — DB 불요, 배선/스레드만 직접 고정):
①두 크론 라우터 엔드포인트가 `get_db`(요청 primary pool)가 아니라 `get_worker_db`(전용
  소형 풀)를 의존한다.
②`storage_usage_warn`의 `send_email` 호출이 메인 이벤트루프 스레드가 아니라 별도 스레드
  (asyncio.to_thread)에서 실행된다.

realdb 회귀(test_asset_registry_realdb.py·test_2906_storage_quota_enforcement_realdb.py)는
이 세션의 로컬 scratch PG(bare `createdb`, 마이그 미적용)로는 검증 불가 — 두 파일 모두
ALEMBIC_DATABASE_URL(CI의 alembic-fresh-db 잡·마이그 완료된 실 PG) 전제라, 무수정 develop
HEAD에서도 동일 "relation ... does not exist"로 실패함을 diff-only 대조로 확認(사전 존재
갭, 이 PR이 만든 회귀 아님) — CI가 최종 판정."""
from __future__ import annotations

import inspect
import threading
from unittest.mock import patch

import pytest

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


def test_assets_grace_hard_delete_depends_on_worker_db():
    from app.dependencies.database import get_worker_db
    from app.routers.cron import assets_grace_hard_delete

    params = inspect.signature(assets_grace_hard_delete).parameters
    assert params["session"].default.dependency is get_worker_db, (
        "assets_grace_hard_delete가 여전히 get_db(요청 primary pool)를 쓰면 story #2041의 "
        "GCS 배치 커넥션 예산 이관이 회귀한다"
    )


def test_storage_usage_warn_depends_on_worker_db():
    from app.dependencies.database import get_worker_db
    from app.routers.cron import storage_usage_warn

    params = inspect.signature(storage_usage_warn).parameters
    assert params["session"].default.dependency is get_worker_db


async def test_storage_usage_warn_send_email_runs_off_event_loop_thread():
    """② — storage_usage_warn이 send_email을 to_thread로 넘기는지, 메인 루프 스레드
    식별로 직접 증명(실 DB/HTTP 없이 함수 소스만으로는 증명 안 됨 — 실행으로 잡는다)."""
    import uuid
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, MagicMock

    from app.routers import cron

    main_thread = threading.current_thread()
    seen_threads: list[threading.Thread] = []

    def _fake_send_email(to, subject, html):
        seen_threads.append(threading.current_thread())
        return True

    org_id = uuid.uuid4()
    sub = SimpleNamespace(
        id=uuid.uuid4(), org_id=org_id, tier="pro", storage_warn_notified_at=None,
    )

    # 실 함수 본문의 session.execute 호출 순서 그대로 흉내(cron.py::storage_usage_warn):
    # ①subs(active OrgSubscription) 목록 ②caps(offering_versions) ③used bytes 합계
    # (cap의 80% 이상이 되도록·cooldown 미적용이라 바로 발송 분기) ④owner/admin 이메일 목록
    # ⑤storage_warn_notified_at 갱신 UPDATE.
    cap_mb = 1000
    used_bytes = int(cap_mb * 1024 * 1024 * 0.9)  # 90% — 경고 임계(80%) 초과
    responses = [
        lambda r: setattr(r.scalars.return_value.all, "return_value", [sub]),
        lambda r: setattr(r.all, "return_value", [("pro", cap_mb)]),
        lambda r: setattr(r.scalar_one, "return_value", used_bytes),
        # story #3205: 조회가 (email, locale) 2열로 확장됨.
        lambda r: setattr(r.all, "return_value", [("owner@example.com", "ko")]),
        lambda r: None,  # UPDATE storage_warn_notified_at — 반환값 미사용.
    ]
    call_count = 0

    async def _execute(stmt, *a, **kw):
        nonlocal call_count
        result = MagicMock()
        if call_count < len(responses):
            responses[call_count](result)
        call_count += 1
        return result

    mock_session = AsyncMock()
    mock_session.execute = _execute
    mock_session.commit = AsyncMock()

    with patch.object(cron, "send_email", side_effect=_fake_send_email), \
         patch.object(cron, "verify_cron", return_value=None):
        await cron.storage_usage_warn(MagicMock(), session=mock_session)

    assert len(seen_threads) == 1, (
        f"send_email이 정확히 1회 호출됐어야 한다(호출 {len(seen_threads)}회) — 픽스처 mock "
        "순서를 다시 확인할 것"
    )
    assert seen_threads[0] is not main_thread, (
        "send_email이 메인 이벤트루프 스레드에서 그대로 실행됨 — asyncio.to_thread 포장이 "
        "빠졌거나 회귀했다(story #2041 재발)"
    )
