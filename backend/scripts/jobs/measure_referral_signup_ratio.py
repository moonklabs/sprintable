"""story #3217(AARRR·Referral 계측) AC4 — 기간 내 가입 중 referral(초대 경유) 비율.

signup_utm_source가 신설된 시점(story #3204, 마이그 0292) 前 가입자는 이 컬럼이
NULL이다 — **NULL(미측정)과 0(측정됐으나 무추천)을 반드시 구분**해서 낸다. 이걸
합쳐 세면(예: "NULL도 0으로 취급") 0292 이전 구간이 통째로 "추천 0%"로 잘못 보여
"추천이 안 먹힌다"는 거짓 결론을 낳는다 — 계측 부재를 성과 부재로 오독하는 클래스.

referral 판정은 story #3217 A축(register()/oauth_callback()의 invite_token 수락
**성공** 시점 서버측 기록) 계약 그대로: `signup_utm_source = 'referral'`.

읽기 전용(조회만). env: DATABASE_URL이 있으면 그것을 쓴다(백엔드 동일). 없으면
ALEMBIC_URL로 떨어진다(scripts/jobs/_db_env.py).
실행: cd backend && DATABASE_URL=... python -m scripts.jobs.measure_referral_signup_ratio [--days N]
(기본 --days 30. 재사용 가능 형태 — 기간만 바꿔 정기 실행.)
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from scripts.jobs._db_env import resolve_database_url

_db_url_summary = resolve_database_url()

from app.core.database import async_session_factory  # noqa: E402 — 위 폴백이 먼저 돌아야 한다

# FILTER 절로 한 스캔에 4갈래를 동시에 센다(round-trip 1회).
# - unmeasured: signup_utm_source가 NULL(0292 이전 가입 — "미측정", 0이 아님).
# - referral: A축 계약대로 정확히 'referral'.
# - non_referral_measured: NULL이 아니면서 referral도 아닌(direct/기타 UTM 등 — "측정됐고 무추천").
REFERRAL_RATIO_SQL = """
SELECT
    count(*) FILTER (WHERE created_at >= :since)                                                    AS total_signups,
    count(*) FILTER (WHERE created_at >= :since AND signup_utm_source IS NULL)                       AS unmeasured_signups,
    count(*) FILTER (WHERE created_at >= :since AND signup_utm_source = 'referral')                  AS referral_signups,
    count(*) FILTER (WHERE created_at >= :since AND signup_utm_source IS NOT NULL
                                                 AND signup_utm_source <> 'referral')                 AS non_referral_measured
FROM users
"""


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=30, help="최근 N일(기본 30)")
    args = parser.parse_args()

    if _db_url_summary is None:
        print("[FAIL] DATABASE_URL·ALEMBIC_URL 둘 다 미설정", file=sys.stderr)
        return 2
    print(f"[db] {_db_url_summary}", file=sys.stderr)

    since = datetime.now(timezone.utc) - timedelta(days=args.days)
    async with async_session_factory() as s:
        row = (await s.execute(text(REFERRAL_RATIO_SQL), {"since": since})).mappings().one()

    total = row["total_signups"]
    unmeasured = row["unmeasured_signups"]
    referral = row["referral_signups"]
    non_referral_measured = row["non_referral_measured"]
    measured = total - unmeasured

    print(f"=== 최근 {args.days}일 가입 referral 비율 ===")
    print(f"  전체 가입: {total}건")
    print(f"  미측정(signup_utm_source IS NULL — 0292 이전 가입): {unmeasured}건")
    print(f"  측정됨(0292 이후): {measured}건 = referral {referral}건 + 그 외(direct/기타 UTM) {non_referral_measured}건")

    if measured == 0:
        print("  referral 비율: N/A(측정된 가입 0건 — «비율 0%»가 아니라 «잴 수 없음»)")
        return 0

    ratio_pct = (referral / measured) * 100
    print(f"  referral 비율(측정 모수 기준): {ratio_pct:.1f}% ({referral}/{measured})")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
