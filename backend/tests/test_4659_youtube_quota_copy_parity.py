"""story 4659 (PO 07:10Z) — 유튜브 쿼터 문구의 BE↔FE 카피 대조를 test_3815(파괴적 스키마 샤드)에서 떼어 옮겼다.

이 테스트는 DB를 쓰지 않는다. 그런데 test_3815는 파일 전체가 destructive_schema 샤드라서, 웹 메시지 파일
(apps/web/messages/*.json)이 한 줄만 바뀌어도 파괴적 샤드 12개가 전부 돌았다(PR 5040 실측 ~180분).
그래서 이 한 테스트를 비파괴 레인으로 옮기고, 메시지 파일은 destructive-fe-deps 목록에서 뺀다.
원래 테스트 내용(문구 대조 · 시간대 파생)은 그대로다.
"""

from __future__ import annotations

def test_youtube_usage_exceeded_wording_derives_from_declared_timezone_and_matches_fe():
    """⭐드리프트 가드(story #3815, 배포 83 픽셀 결함, 페드루 PO 지적 2026-09-12
    23:50Z 정정) — 옛 pin은 "UTC 자정→KST 9시"를 계산해 정적 문구와 대조했으나,
    실 리셋 시간대가 America/Los_Angeles(DST 有)로 바뀌어 "9시" 같은 고정
    시각으로는 더 이상 못 박을 수 없다(PDT/PST 전환에 따라 실제로 흔들린다).
    이제 문구는 `{tz_display}` 자리에 `youtube` 채널이 선언한 `quota_reset_
    timezone`(=`America/Los_Angeles`)을 `TIMEZONE_DISPLAY_NAMES`로 조회한 값을
    끼워 넣는다 — reset_at 계산(위 두 테스트)과 문구 조립이 같은 선언값 하나에서
    파생됨을 이 테스트가 고정한다(어댑터 선언을 다른 tz로 바꾸면 이 테스트가
    아니라 TIMEZONE_DISPLAY_NAMES KeyError로 먼저 죽는다 — fail-closed).

    FE `failure-action-badge.tsx`의 `channelPostsFailureYoutubeQuotaExceeded`
    (ko/en)가 이 BE 문구를 그대로 복제한다(dead_letter 배지용, #4238 CHANGES 1과
    동형) — byte-exact 유지."""
    import json
    from pathlib import Path

    from app.services.channel_adapters import get_channel_adapter
    from app.services.i18n_catalog import TIMEZONE_DISPLAY_NAMES, t

    youtube_tz = get_channel_adapter("youtube").quota_reset_timezone
    assert youtube_tz == "America/Los_Angeles", (
        "어댑터 선언이 바뀌었다 — 아래 카탈로그 문장·TIMEZONE_DISPLAY_NAMES도 같이 재확認할 것"
    )
    assert youtube_tz in TIMEZONE_DISPLAY_NAMES, (
        f"{youtube_tz!r}가 TIMEZONE_DISPLAY_NAMES에 없다 — 라우터가 KeyError로 죽는다"
    )

    ko = t("channel_posts.youtube_usage_exceeded", "ko", tz_display=TIMEZONE_DISPLAY_NAMES[youtube_tz]["ko"])
    en = t("channel_posts.youtube_usage_exceeded", "en", tz_display=TIMEZONE_DISPLAY_NAMES[youtube_tz]["en"])
    assert "태평양 시간" in ko
    assert "Pacific Time" in en
    assert "오전 9시" not in ko, "옛 UTC 고정 가정 문구가 남아 있다"
    assert "00:00 UTC" not in en, "옛 UTC 고정 가정 문구가 남아 있다"

    repo_root = Path(__file__).resolve().parents[2]
    fe_ko = json.loads((repo_root / "apps/web/messages/ko.json").read_text())
    fe_en = json.loads((repo_root / "apps/web/messages/en.json").read_text())
    fe_ko_quota = fe_ko["content"]["channelPostsFailureYoutubeQuotaExceeded"]
    fe_en_quota = fe_en["content"]["channelPostsFailureYoutubeQuotaExceeded"]
    assert fe_ko_quota == ko, (
        f"apps/web/messages/ko.json의 content.channelPostsFailureYoutubeQuotaExceeded"
        f"가 BE i18n_catalog 원문과 갈렸다 — 화면 쪽이 바뀌면 이 문구도 같이 바꿀 것"
        f"\nFE: {fe_ko_quota!r}\nBE: {ko!r}"
    )
    assert fe_en_quota == en, (
        f"apps/web/messages/en.json의 content.channelPostsFailureYoutubeQuotaExceeded"
        f"가 BE i18n_catalog 원문과 갈렸다 — 화면 쪽이 바뀌면 이 문구도 같이 바꿀 것"
        f"\nFE: {fe_en_quota!r}\nEN: {en!r}"
    )
