"""story #3674(BE 確定, 페드루 PO 確定 2026-09-07) — org_time.py 순수 헬퍼 단위
테스트(실PG 불요). 경계 표본은 스토리 본문이 지정한 값 그대로: UTC 2026-09-07T23:30
(KST=Asia/Seoul 2026-09-08 08:30, 아직 KST 00:00~09:00 창 안) → org tz가 Asia/Seoul
이면 org_today가 09-08, org tz가 null(미설정)이면 UTC 그대로 09-07(3665 동작 보존).

크론/잡 경로(요청 컨텍스트 없음)가 org_id만으로 성립해야 한다는 것이 org.timezone
(방식 A)을 택한 이유 그 자체(그라운딩 ③) — 이 파일의 모든 테스트가 FastAPI
request/Depends 없이 org_timezone 문자열 하나만으로 순수 함수를 호출한다. 이 자체가
"크론 경로 성립"의 직접 증거다(별도 크론 라우터 통합 테스트 불요)."""
from __future__ import annotations

from datetime import date, datetime, timezone
from unittest.mock import patch

from app.services.org_time import (
    org_date_sql,
    org_midnight_utc,
    org_today,
    org_tz,
    to_org_date,
)

_FROZEN_UTC = datetime(2026, 9, 7, 23, 30, tzinfo=timezone.utc)


def _frozen_now(tz=None):
    assert tz == timezone.utc
    return _FROZEN_UTC


@patch("app.services.org_time.datetime")
def test_org_today_asia_seoul_crosses_to_next_day(mock_dt):
    """AC 경계 표본 — UTC 23:30(2026-09-07)은 Asia/Seoul(UTC+9)로는 이미 09-08 08:30."""
    mock_dt.now.side_effect = _frozen_now
    assert org_today("Asia/Seoul") == date(2026, 9, 8)


@patch("app.services.org_time.datetime")
def test_org_today_null_timezone_stays_utc(mock_dt):
    """AC 경계 표본 — org.timezone 미설정(null)이면 UTC 그대로 09-07(3665 동작 보존,
    크론 경로에서 org.timezone이 아직 아무도 안 채운 조직이어도 회귀 0)."""
    mock_dt.now.side_effect = _frozen_now
    assert org_today(None) == date(2026, 9, 7)


@patch("app.services.org_time.datetime")
def test_org_today_utc_explicit_same_as_null(mock_dt):
    """org.timezone="UTC"로 명시 설정한 것과 미설정(null)이 같은 값을 낸다 — 폴백이
    "다른 경로"가 아니라 "같은 값에 도달하는 지름길"임을 고정."""
    mock_dt.now.side_effect = _frozen_now
    assert org_today("UTC") == org_today(None) == date(2026, 9, 7)


def test_org_tz_resolves_iana_name():
    assert str(org_tz("Asia/Seoul")) == "Asia/Seoul"
    assert str(org_tz(None)) == "UTC"
    assert str(org_tz("")) == "UTC"  # 빈 문자열도 "미설정"으로 취급(falsy).


def test_to_org_date_converts_utc_instant_to_org_calendar_date():
    dt = datetime(2026, 9, 7, 23, 30, tzinfo=timezone.utc)
    assert to_org_date(dt, "Asia/Seoul") == date(2026, 9, 8)
    assert to_org_date(dt, None) == date(2026, 9, 7)


@patch("app.services.org_time.datetime")
def test_org_midnight_utc_is_org_local_midnight_not_utc_midnight(mock_dt):
    """org_midnight_utc가 "그냥 UTC 오늘 0시"가 아니라 "org tz 기준 오늘 0시를 UTC로
    변환한 값"임을 고정 — deployment_lifecycle.py 원 결함(UTC 자정으로 잘못 계산)과
    정확히 반대되는 값이 나와야 한다."""
    mock_dt.now.side_effect = _frozen_now
    # 실제 datetime 생성자도 필요하므로 side_effect 없는 호출은 진짜 클래스로 위임.
    mock_dt.side_effect = datetime
    result = org_midnight_utc("Asia/Seoul")
    # Asia/Seoul 09-08 00:00:00 == UTC 09-07 15:00:00.
    assert result == datetime(2026, 9, 7, 15, 0, tzinfo=timezone.utc)


def test_org_date_sql_defaults_to_utc_when_timezone_none():
    """SQL 컴파일 결과에 "UTC" 리터럴이 실리는지(폴백 확認) — 실제 실행은 realdb 통합
    테스트(test_3674_standups_history_org_timezone_realdb.py 등) 몫."""
    from app.models.agent_run import AgentRun
    compiled = str(org_date_sql(AgentRun.started_at, None).compile(compile_kwargs={"literal_binds": True}))
    assert "'UTC'" in compiled


def test_org_date_sql_uses_given_timezone():
    from app.models.agent_run import AgentRun
    compiled = str(org_date_sql(AgentRun.started_at, "Asia/Seoul").compile(compile_kwargs={"literal_binds": True}))
    assert "'Asia/Seoul'" in compiled


# story #3674 rebase CHANGES(페드루 PO, 2026-09-07) — #4026을 develop(#4020/3665 착지 뒤)
# 위로 rebase하며 deployment_lifecycle._utc_midnight_today()·ga4_client의 process-local
# datetime import를 org_time.py 헬퍼로 흡수했다(§3674 확定 그대로) — 그 결과
# test_3665_utc_date_boundary_regression.py의 두 테스트가 삭제된 헬퍼/이름을 직접
# monkeypatch하려다 AttributeError로 죽는다(CI 실물로만 드러남, 로컬은 그 파일을 안
# 돌려 안 잡힘 — PO 재대조 발견). 그 파일이 지키던 불변식("UTC 기준 계산은 프로세스
# 로컬 TZ가 이미 다음 날로 넘어가도 안 흔들린다")을 org_time.py 축으로 옮겨 고정한다
# (아래 두 테스트) — superseded 파일은 이 커밋에서 삭제.

@patch("app.services.org_time.datetime")
def test_org_midnight_utc_null_timezone_uses_utc_boundary_not_process_local(mock_dt):
    """구 test_utc_midnight_today_uses_utc_not_process_local_date와 동일 경계
    (UTC 23:30 — 프로세스 로컬 TZ가 이미 "다음 날"로 갈렸다고 가정해도) —
    org_midnight_utc(None)은 org.timezone 미설정이면 UTC 폴백이라 "그날(UTC 기준)"의
    00:00:00+00:00을 내야 한다(다음 날 자정이 아니다)."""
    mock_dt.now.side_effect = _frozen_now
    mock_dt.side_effect = datetime
    result = org_midnight_utc(None)
    assert result == datetime(2026, 9, 7, 0, 0, 0, tzinfo=timezone.utc)


@patch("app.services.org_time.datetime")
def test_make_date_range_null_org_timezone_uses_utc_not_process_local(mock_dt):
    """구 test_make_date_range_uses_utc_not_process_local_date와 동일 경계·동일
    기대값 — `_make_date_range`가 이제 org_today()(org_time.py)에 위임하므로 그
    모듈의 datetime을 고정한다(ga4_client 자신은 더 이상 datetime을 top-level
    import하지 않는다 — monkeypatch 대상이 바뀐 것 자체가 «흡수됐다»는 증거)."""
    from app.services.ga4_client import _make_date_range

    mock_dt.now.side_effect = _frozen_now
    mock_dt.side_effect = datetime
    start, end = _make_date_range(1, None)
    assert end == "2026-09-06"
    assert start == "2026-09-06"
