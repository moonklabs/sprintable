"""story #4424 — desktop setup code · confirm · exchange · disconnect (contract in `app/services/desktop_setup.py`).

`setup-codes` and `exchange` take no login (the desktop app carries no web session; the exchange is guarded by the PKCE
verifier only) and are rate limited per address; `confirm` and the disconnect need a person's session (org owner/admin) — an
agent key is refused there. Answers never carry more than the contract: the plaintext keys exist only in the first `200`
of an exchange."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.rate_limit import limiter
from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id_no_project_gate
from app.dependencies.database import get_db
from app.services.desktop_setup import (
    DesktopSetupError,
    RoleChoice,
    confirm_setup,
    create_setup_code,
    exchange_setup,
    exchange_urls,
    list_setups,
    revoke_setup,
    setup_hands,
)

router = APIRouter(prefix="/api/v2/desktop", tags=["desktop"])

# closed code → status (the desktop app acts on the status: 410 = start again · 403/404 = refused)
_STATUS = {
    "code_not_found": 404,
    "setup_not_found": 404,
    "recipe_not_found": 404,
    "verifier_mismatch": 403,
    "not_org_admin": 403,
    "code_expired": 410,
    "code_used": 410,
    "already_confirmed": 409,
    "roles_invalid": 422,
    "request_invalid": 422,
    "human_stage_needs_member": 422,
}


def _error(e: DesktopSetupError) -> HTTPException:
    return HTTPException(status_code=_STATUS.get(e.code, 400), detail={"code": e.code, "message": e.detail or e.code})


def _human_only(auth: AuthContext) -> uuid.UUID:
    """An agent key never confirms or disconnects a setup (it would make agents and keys for itself)."""
    if (auth.claims.get("app_metadata") or {}).get("api_key_id"):
        raise HTTPException(status_code=403, detail={"code": "person_session_required", "message": "a person's session is required"})
    return uuid.UUID(str(auth.user_id))


class SetupCodeRequest(BaseModel):
    challenge: str = Field(min_length=43, max_length=43)
    device_name: str = Field(min_length=1, max_length=200)


class SetupCodeResponse(BaseModel):
    code: str
    expires_at: datetime


@router.post("/setup-codes", status_code=201, response_model=SetupCodeResponse)
@limiter.limit("10/minute")
async def post_setup_code(request: Request, response: Response, body: SetupCodeRequest, db: AsyncSession = Depends(get_db)):
    response.headers["Cache-Control"] = "no-store"
    try:
        code, expires_at = await create_setup_code(db, challenge=body.challenge, device_name=body.device_name)
    except DesktopSetupError as e:
        raise _error(e) from None
    await db.commit()
    return SetupCodeResponse(code=code, expires_at=expires_at)


class RoleIn(BaseModel):
    stage: str = Field(min_length=1, max_length=200)
    runtime: Literal["claude", "codex"]


class ConfirmRequest(BaseModel):
    project_id: uuid.UUID
    recipe_id: uuid.UUID
    roles: list[RoleIn] = Field(max_length=50)
    # the folder chosen on the web, handed back as is in the exchange (≤200 · no control characters); the desktop app judges
    # the path itself (under home · no `..`), the server does not
    workdir_hint: str | None = Field(default=None, max_length=200)

    @field_validator("workdir_hint")
    @classmethod
    def _no_control_characters(cls, v: str | None) -> str | None:
        if v is not None and any(ord(ch) < 32 or ord(ch) == 127 for ch in v):
            raise ValueError("workdir_hint must not contain control characters")
        return v


class ConfirmedMember(BaseModel):
    stage: str
    member_id: str
    kind: Literal["agent", "human"]


class ConfirmResponse(BaseModel):
    setup_id: uuid.UUID
    members: list[ConfirmedMember]


@router.post("/setup-codes/{code}/confirm", response_model=ConfirmResponse)
async def post_confirm(
    code: str,
    body: ConfirmRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    user_id = _human_only(auth)
    try:
        setup_id, members = await confirm_setup(
            db, code=code, user_id=user_id, org_id=org_id, project_id=body.project_id, recipe_id=body.recipe_id,
            roles=[RoleChoice(stage=r.stage, runtime=r.runtime) for r in body.roles], auth=auth, workdir_hint=body.workdir_hint,
        )
    except DesktopSetupError as e:
        # AC2: any error leaves the request by raising, and get_db rolls the whole session back — e.g. the plan's agent
        # limit (402) on the second agent takes the first one with it
        raise _error(e) from None
    await db.commit()
    return ConfirmResponse(setup_id=setup_id, members=[ConfirmedMember(**{k: m[k] for k in ("stage", "member_id", "kind")}) for m in members])


class ExchangeRequest(BaseModel):
    verifier: str = Field(min_length=43, max_length=128)


@router.post("/setup-codes/{code}/exchange")
@limiter.limit("60/minute")  # the app asks every 1.5 s while the person confirms
async def post_exchange(request: Request, code: str, body: ExchangeRequest, db: AsyncSession = Depends(get_db)):
    headers = {"Cache-Control": "no-store"}
    try:
        done = await exchange_setup(db, code=code, verifier=body.verifier)
    except DesktopSetupError as e:
        await db.rollback()  # returned, not raised: nothing may be committed on the way out
        err = _error(e)
        # the app's error envelope (main.py http_exception_handler), with no-store like every exchange answer
        return JSONResponse(status_code=err.status_code, content={"data": None, "error": err.detail, "meta": None}, headers=headers)
    # any other error raises → get_db rolls back (AC2: no key without the «handed over» mark, and the reverse)
    if done is None:
        await db.rollback()
        return JSONResponse(status_code=202, content={"status": "pending"}, headers=headers)
    await db.commit()
    api_url, mcp_url = exchange_urls()
    return JSONResponse(
        status_code=200,
        content={
            "setup_id": str(done.setup_id), "agents": done.agents, "api_url": api_url, "mcp_url": mcp_url,
            "workdir_hint": done.workdir_hint,
        },
        headers=headers,
    )


class SetupMember(BaseModel):
    stage: str
    member_id: str
    kind: Literal["agent", "human"]
    runtime: Literal["claude", "codex"] | None = None


class SetupItem(BaseModel):
    setup_id: uuid.UUID
    device_name: str
    state: Literal["waiting_for_app", "handed_over", "not_handed_over", "disconnected"]
    project_id: uuid.UUID | None
    recipe_key: str | None
    confirmed_by: uuid.UUID | None
    confirmed_at: datetime | None
    exchanged_at: datetime | None
    revoked_at: datetime | None
    keys_issued: int
    active_keys: int
    members: list[SetupMember]


class SetupListResponse(BaseModel):
    setups: list[SetupItem]


@router.get("/setups", response_model=SetupListResponse)
async def get_setups(
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    """The org's desktop setups for the web list (who · which device · state · keys still active)."""
    user_id = _human_only(auth)
    try:
        return SetupListResponse(setups=[SetupItem(**s) for s in await list_setups(db, user_id=user_id, org_id=org_id)])
    except DesktopSetupError as e:
        raise _error(e) from None


class SetupHandsResponse(BaseModel):
    setup_id: uuid.UUID
    human_hands: int
    minutes_to_first_result: float | None
    docs_opened: int


@router.get("/setups/{setup_id}/hands", response_model=SetupHandsResponse)
async def get_setup_hands(
    setup_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    """story #4426 ② — «human hands N · first result after M minutes · docs opened K» for one setup (the admin surface is 3801)."""
    user_id = _human_only(auth)
    try:
        return SetupHandsResponse(**await setup_hands(db, setup_id=setup_id, user_id=user_id, org_id=org_id))
    except DesktopSetupError as e:
        raise _error(e) from None


class RevokeResponse(BaseModel):
    revoked_keys: int


@router.delete("/setups/{setup_id}", response_model=RevokeResponse)
async def delete_setup(
    setup_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    from app.services.project_auth import is_org_owner_or_admin

    user_id = _human_only(auth)
    # a setup is an org-level record (who connected which device): the org owner/admin gate is its guard, checked here at the
    # route and again in the service; the lookup below is scoped to this org, so another org's id is «not found»
    if not await is_org_owner_or_admin(db, user_id, org_id):
        raise _error(DesktopSetupError("not_org_admin"))
    try:
        n = await revoke_setup(db, setup_id=setup_id, user_id=user_id, org_id=org_id)
    except DesktopSetupError as e:
        await db.rollback()
        raise _error(e) from None
    await db.commit()
    return RevokeResponse(revoked_keys=n)
