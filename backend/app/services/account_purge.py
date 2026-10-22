"""story #4752 — the purge that keeps the account-deletion promise: «계정을 삭제하면 30일 유예 기간 후 모든 개인정보가 익명화돼요. 작성한 콘텐츠는 유지돼요.»

A deleted account (`users.deleted_at`, see routers/account.py) has been closed at once; this job, run daily by Cloud Scheduler (`account-purge`), removes the personal data of the ones whose
grace period (ACCOUNT_PURGE_GRACE_DAYS) is over and which are not anonymized yet (`users.anonymized_at IS NULL`). The user row stays — its id is what what the person wrote points at — with
no name, no e-mail address, no password hash, no second factor, no provider id; the person's human member rows lose their name and picture (a neutral label stands for them); the
rows that only exist to sign the person in (provider identities · registered devices · session and hand-over codes) are deleted.

What this does NOT touch (named here so nobody reads «everything» in the copy as more than it is — each is its own follow-up): the text of what the person wrote, an invitation sent TO the
person's address by another member (org_invites.email), a project API key's label, files they uploaded, an e-mail a mail provider has already sent. The job is idempotent and bounded:
`SCRUB_BATCH` accounts per run, locked `FOR UPDATE SKIP LOCKED` so two runs never meet.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

#: the days between «delete» and the purge (the copy says 30; the deletion endpoint and this job read the same number)
ACCOUNT_PURGE_GRACE_DAYS = 30
PURGE_BATCH = 200
#: what stands for a person's name once it is gone (shown where a member's name was)
DELETED_MEMBER_NAME = "탈퇴한 사용자"
#: an address nobody can receive at (RFC 2606 `.invalid`); the unique constraint is kept by the id plus a random part, so nobody can register it beforehand to make the purge fail (codex 1)
_DELETED_EMAIL_DOMAIN = "deleted.invalid"


async def purge_deleted_accounts(session: AsyncSession, *, now: datetime | None = None, batch: int = PURGE_BATCH) -> int:
    """Anonymize up to `batch` accounts deleted at least ACCOUNT_PURGE_GRACE_DAYS ago. Returns how many. The caller commits (the request session does)."""
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=ACCOUNT_PURGE_GRACE_DAYS)
    rows = (await session.execute(
        text(
            "SELECT id FROM users WHERE deleted_at IS NOT NULL AND anonymized_at IS NULL AND deleted_at <= :cutoff"
            " ORDER BY deleted_at, id LIMIT :batch FOR UPDATE SKIP LOCKED"
        ),
        {"cutoff": cutoff, "batch": batch},
    )).all()
    ids = [r[0] for r in rows]
    if not ids:
        return 0
    arg = {"ids": ids}
    await session.execute(
        text(
            "UPDATE users SET email = 'deleted-' || id::text || '-' || substr(md5(random()::text || id::text), 1, 12) || '@" + _DELETED_EMAIL_DOMAIN + "', hashed_password = '', display_name = NULL,"
            " totp_secret = NULL, totp_enabled = false, google_id = NULL, github_id = NULL, apple_id = NULL, reclaim_notice = NULL,"
            " signup_utm_source = NULL, signup_utm_medium = NULL, signup_utm_campaign = NULL, signup_referrer = NULL,"
            " is_active = false, anonymized_at = :now WHERE id = ANY(CAST(:ids AS uuid[]))"
        ),
        {**arg, "now": now},
    )
    await session.execute(
        text("UPDATE members SET name = :label, avatar_url = NULL, handle = NULL WHERE type = 'human' AND user_id = ANY(CAST(:ids AS uuid[]))"),
        {**arg, "label": DELETED_MEMBER_NAME},
    )
    await session.execute(text("UPDATE auth_migrations SET firebase_uid = NULL WHERE user_id = ANY(CAST(:ids AS uuid[]))"), arg)  # the row stays: its `auth_valid_after` keeps the old access tokens dead
    for table in ("auth_identities", "device_proof_challenges", "device_installations", "refresh_tokens", "oauth_handoff_codes", "auth_native_bootstrap_codes"):
        await session.execute(text(f"DELETE FROM {table} WHERE user_id = ANY(CAST(:ids AS uuid[]))"), arg)  # noqa: S608 — the table names are this module's own constants
    return len(ids)
