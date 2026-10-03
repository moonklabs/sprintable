"""story #4424 — desktop setup code · confirm · exchange · disconnect (contract in `app/services/desktop_setup.py`).

`setup-codes` and `exchange` take no login (the desktop app carries no web session; the exchange is guarded by the PKCE
verifier only) and are rate limited per address; `confirm` and the disconnect need a person's session (org owner/admin) — an
agent key is refused there. Answers never carry more than the contract: the plaintext keys exist only in the first `200`
of an exchange."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Request, Response
from fastapi.security import HTTPAuthorizationCredentials
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.rate_limit import hit_person_limits, open_setup_limiter
from app.dependencies.auth import AuthContext, bearer_scheme, get_current_user, get_verified_org_id_no_project_gate
from app.dependencies.database import get_db
from app.services import desktop_device_token_codes as device_codes
from app.services.desktop_setup import (
    DesktopSetupError,
    RoleChoice,
    confirm_setup,
    confirm_setup_first_project,
    confirm_setup_new_org,
    create_setup_code,
    exchange_setup,
    exchange_urls,
    list_setup_recipes,
    list_setups,
    person_names,
    revoke_setup,
    setup_hands,
    setup_status,
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
    "setup_disconnected": 409,  # story #4548 — the device was disconnected (its token code can no longer be confirmed or exchanged)
    "roles_invalid": 422,
    "request_invalid": 422,
    "service_unavailable": 503,
    "human_stage_needs_member": 422,
    "no_agent_role": 422,
    "recipe_too_large": 422,
    # story 4427 (나): the new-organization path — the person already has one (use the usual confirm) · has an invite (join)
    "has_organization": 409,
    "pending_invites": 409,
    # story 4496: no project chosen, and the organization has projects — the web picks one of them (none is made)
    "project_required": 409,
}


def _error(e: DesktopSetupError) -> HTTPException:
    return HTTPException(status_code=_STATUS.get(e.code, 400), detail={"code": e.code, "message": e.detail or e.code})


def _human_only(auth: AuthContext) -> uuid.UUID:
    """A person at a browser, not a key: an agent key never confirms or disconnects a setup (it would make agents and keys for
    itself), and neither does a person's own API key (hu_live_ — codex 01a10155 T1 · PO 10:59Z: a script holding an admin's key
    would skip «a person confirms on the web» and take a device token). The same rule set-password already uses."""
    from app.routers.auth import _requires_interactive_session

    if _requires_interactive_session(auth):
        raise HTTPException(status_code=403, detail={"code": "person_session_required", "message": "a person's session is required"})
    return uuid.UUID(str(auth.user_id))


class SetupCodeRequest(BaseModel):
    challenge: str = Field(min_length=43, max_length=43)
    device_name: str = Field(min_length=1, max_length=200)


class SetupCodeResponse(BaseModel):
    code: str
    expires_at: datetime
    # PO 12:21Z — the app's step events carry it (header `X-Setup-Event-Token`) to be counted; given once, only its hash kept
    event_token: str
    setup_id: uuid.UUID  # not a secret — the app passes it to the web page (`&setup=`) so pre-confirm steps can be keyed


@router.post("/setup-codes", status_code=201, response_model=SetupCodeResponse)
@open_setup_limiter.limit("10/minute")  # per user IP (PO 13:04Z)
async def post_setup_code(request: Request, response: Response, body: SetupCodeRequest, db: AsyncSession = Depends(get_db)):
    response.headers["Cache-Control"] = "no-store"
    try:
        code, expires_at, setup_id, event_token = await create_setup_code(db, challenge=body.challenge, device_name=body.device_name)
    except DesktopSetupError as e:
        raise _error(e) from None
    await db.commit()
    return SetupCodeResponse(code=code, expires_at=expires_at, setup_id=setup_id, event_token=event_token)


# abuse caps for the request body (generous — the product's own limits are judged with a closed code, PO 06:04Z)
ROLE_FIELD_CAP = 1000
ROLES_FIELD_CAP = 500


class RoleIn(BaseModel):
    """One setup row: `{role, runtime}` — a new agent on that runtime — or `{role, owner: "me"}` — the person confirming holds
    it (an either row only · Qadir 4834 · PO 05:21Z ⒜). Exactly one of the two.

    PO 06:04Z — the schema only caps sizes against abuse (generous); every rule a person can break — exactly one of runtime /
    owner, a known runtime, a repeated role, the product's limits — is judged by bind_setup_roles with a closed code
    (roles_invalid · recipe_too_large), so the web never has to read a generic 422's `loc` to tell a body defect from a recipe
    that is too large."""
    role: str = Field(max_length=ROLE_FIELD_CAP)  # a recipe role (stage_metadata[stage].role), not a stage
    runtime: str | None = Field(default=None, max_length=32)
    owner: str | None = Field(default=None, max_length=32)


# Qadir 4825 (PO 09:45Z) — the setup code travels in bodies only, never in a URL: a path is written to the access log and the
# error handler's log (the exchange polls for ten minutes, a line each time), and a code plus any org's admin session could
# bind someone else's desktop to that org. So neither route has the code in its path.
SETUP_CODE_FIELD = Field(min_length=20, max_length=128)


class ConfirmRequest(BaseModel):
    code: str = SETUP_CODE_FIELD
    # story 4496: left out → the setup makes the organization's first project (`project_name`) — only when it has none
    project_id: uuid.UUID | None = None
    project_name: str | None = Field(default=None, min_length=1, max_length=100)
    recipe_id: uuid.UUID
    roles: list[RoleIn] = Field(max_length=ROLES_FIELD_CAP)  # abuse cap only — the product limit is recipe_too_large
    # the folder chosen on the web, handed back as is in the exchange (≤200 · no control characters); the desktop app judges
    # the path itself (under home · no `..`), the server does not
    workdir_hint: str | None = Field(default=None, max_length=200)

    @field_validator("project_name")
    @classmethod
    def _project_name_trimmed(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.strip()
        if not v:
            raise ValueError("must not be blank")
        if any(ord(ch) < 32 or ord(ch) == 127 for ch in v):
            raise ValueError("must not contain control characters")
        return v

    @field_validator("workdir_hint")
    @classmethod
    def _no_control_characters(cls, v: str | None) -> str | None:
        if v is not None and any(ord(ch) < 32 or ord(ch) == 127 for ch in v):
            raise ValueError("workdir_hint must not contain control characters")
        return v


class ConfirmedMember(BaseModel):
    stage: str
    role: str
    member_id: str
    kind: Literal["agent", "human"]


class ConfirmResponse(BaseModel):
    setup_id: uuid.UUID
    members: list[ConfirmedMember]
    work_item_id: uuid.UUID  # the story the recipe's first stage was published on
    # story 4496: the organization's first project, when this confirmation made it (the web makes it the tab's project)
    project_id: uuid.UUID | None = None


@router.post("/setup-codes/confirm", response_model=ConfirmResponse)
async def post_confirm(
    body: ConfirmRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    user_id = _human_only(auth)
    roles = [RoleChoice(role=r.role, runtime=r.runtime, owner=r.owner) for r in body.roles]
    made_project: uuid.UUID | None = None
    try:
        if body.project_id is None and not body.project_name:
            raise DesktopSetupError("request_invalid", "project_id or project_name is required")
        if body.project_id is None:
            # story 4496 (PO 09:32Z (가)): no project chosen — the first project is made with the setup when the organization has
            # none (the server counts; the web's list is not trusted for it), else 409 project_required
            setup_id, members, work_item_id, made_project = await confirm_setup_first_project(
                db, code=body.code, user_id=user_id, org_id=org_id, project_name=body.project_name,
                recipe_id=body.recipe_id, roles=roles, auth=auth, workdir_hint=body.workdir_hint, background_tasks=background_tasks,
            )
        else:
            setup_id, members, work_item_id = await confirm_setup(
                db, code=body.code, user_id=user_id, org_id=org_id, project_id=body.project_id, recipe_id=body.recipe_id,
                roles=roles, auth=auth, workdir_hint=body.workdir_hint, background_tasks=background_tasks,
            )
    except DesktopSetupError as e:
        # AC2: any error leaves the request by raising, and get_db rolls the whole session back — e.g. the plan's agent
        # limit (402) on the second agent takes the first one with it
        raise _error(e) from None
    await db.commit()
    return ConfirmResponse(
        setup_id=setup_id, work_item_id=work_item_id, project_id=made_project,
        members=[ConfirmedMember(**{k: m[k] for k in ("stage", "role", "member_id", "kind")}) for m in members],
    )


# story 4427 (나) · design doc 9a4cb445 §1 · §8 · §10 — a person with no organization: «시작» makes the organization, its first
# project and the setup in one transaction. No organization or project field at all (extra=forbid): this path can only make a
# new organization, never point at an existing one.
CONFIRM_NEW_ORG_LIMITS = ("3/hour", "10/day")  # PO 02:57Z — the way an organization is made (OSS has no EE owner limit)
RECIPES_NEW_ORG_LIMITS = ("60/minute",)  # PO 02:57Z — a read


def _rate_limited(retry_after: int) -> HTTPException:
    """The same answer as the shared limiters' handler (429 RATE_LIMITED + Retry-After)."""
    return HTTPException(
        status_code=429, detail={"code": "RATE_LIMITED", "message": "Too many requests"}, headers={"Retry-After": str(retry_after)},
    )


class ConfirmNewOrgRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = SETUP_CODE_FIELD
    recipe_id: uuid.UUID
    roles: list[RoleIn] = Field(max_length=50)
    workdir_hint: str | None = Field(default=None, max_length=200)
    org_name: str = Field(min_length=1, max_length=100)
    project_name: str = Field(min_length=1, max_length=100)

    @field_validator("workdir_hint")
    @classmethod
    def _hint_no_control_characters(cls, v: str | None) -> str | None:
        if v is not None and any(ord(ch) < 32 or ord(ch) == 127 for ch in v):
            raise ValueError("workdir_hint must not contain control characters")
        return v

    @field_validator("org_name", "project_name")
    @classmethod
    def _name_trimmed_no_control_characters(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("must not be blank")
        if any(ord(ch) < 32 or ord(ch) == 127 for ch in v):
            raise ValueError("must not contain control characters")
        return v


class ConfirmNewOrgResponse(ConfirmResponse):
    org_id: uuid.UUID
    project_id: uuid.UUID


@router.post("/setup-codes/confirm-new-org", response_model=ConfirmNewOrgResponse)
async def post_confirm_new_org(
    body: ConfirmNewOrgRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
):
    user_id = _human_only(auth)
    retry = hit_person_limits("desktop-confirm-new-org", str(user_id), *CONFIRM_NEW_ORG_LIMITS)
    if retry is not None:
        raise _rate_limited(retry)
    try:
        setup_id, members, work_item_id, org_id, project_id = await confirm_setup_new_org(
            db, code=body.code, user_id=user_id, org_name=body.org_name, project_name=body.project_name, recipe_id=body.recipe_id,
            roles=[RoleChoice(role=r.role, runtime=r.runtime, owner=r.owner) for r in body.roles], auth=auth, workdir_hint=body.workdir_hint,
            background_tasks=background_tasks,
        )
    except DesktopSetupError as e:
        # get_db rolls the whole session back: no organization, project or agent is left by a failed setup
        raise _error(e) from None
    await db.commit()
    return ConfirmNewOrgResponse(
        setup_id=setup_id, work_item_id=work_item_id, org_id=org_id, project_id=project_id,
        members=[ConfirmedMember(**{k: m[k] for k in ("stage", "role", "member_id", "kind")}) for m in members],
    )


class ExchangeRequest(BaseModel):
    code: str = SETUP_CODE_FIELD
    verifier: str = Field(min_length=43, max_length=128)


@router.post("/setup-codes/exchange")
# per user IP; the app asks every 1.5 s (40/minute) while the person confirms, and several can sit behind one NAT — the
# exchange is guarded by the verifier, so this limit is only against load (PO 13:04Z)
@open_setup_limiter.limit("240/minute")
async def post_exchange(request: Request, body: ExchangeRequest, db: AsyncSession = Depends(get_db)):
    headers = {"Cache-Control": "no-store"}
    try:
        done = await exchange_setup(db, code=body.code, verifier=body.verifier)
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
            "workdir_hint": done.workdir_hint, "recipe_name": done.recipe_name, "org_name": done.org_name,
            # story 4470: the org's id (an added field — an older app ignores it)
            "org_id": str(done.org_id) if done.org_id else None,
            # story #4529 — the device token for /api/v2/desktop/relay/* (shown once · an older app ignores it)
            "device_token": done.device_token,
        },
        headers=headers,
    )


class SetupMember(BaseModel):
    stage: str
    role: str | None = None
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
    confirmed_by_name: str | None = None  # the person's name in this org (none: left, or no name)
    exchanged_at: datetime | None
    revoked_at: datetime | None
    revoked_by_name: str | None = None
    keys_issued: int
    active_keys: int
    members: list[SetupMember]


class SetupListResponse(BaseModel):
    setups: list[SetupItem]


class SetupRecipeRole(BaseModel):
    role: str
    kind: Literal["human", "agent", "either"]  # human → the person confirming · agent → a runtime · either → a runtime or owner «me»
    stages: list[str]


class SetupRecipe(BaseModel):
    id: uuid.UUID
    key: str
    org_id: uuid.UUID | None  # null = a platform preset (the web names it in the viewer's language by key)
    name: str
    description: str | None
    roles: list[SetupRecipeRole]


class SetupRecipesResponse(BaseModel):
    recipes: list[SetupRecipe]


@router.get("/recipes", response_model=SetupRecipesResponse)
async def get_setup_recipes(
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    """PO 16:03Z — the recipes the desktop setup page can start, each with its setup rows worked out by the same function the
    confirmation checks with (the web draws them as they come)."""
    _human_only(auth)
    return SetupRecipesResponse(recipes=[SetupRecipe(**r) for r in await list_setup_recipes(db, org_id=org_id)])


@router.get("/recipes/for-new-org", response_model=SetupRecipesResponse)
async def get_setup_recipes_for_new_org(
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
):
    """story 4427 (나) · PO 02:26Z — the recipes a person with **no organization** can start (the «새 조직» setup page): the
    platform presets only (`org_id IS NULL`), in the same shape and rows as `/recipes`. A person who has an organization gets
    409 has_organization (they read `/recipes`)."""
    from app.services.org_project_create import has_active_org

    user_id = _human_only(auth)
    retry = hit_person_limits("desktop-recipes-new-org", str(user_id), *RECIPES_NEW_ORG_LIMITS)
    if retry is not None:
        raise _rate_limited(retry)
    if await has_active_org(db, user_id):
        raise _error(DesktopSetupError("has_organization"))
    return SetupRecipesResponse(recipes=[SetupRecipe(**r) for r in await list_setup_recipes(db, org_id=None)])


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


class ToolsConnected(BaseModel):
    member_id: str
    at: datetime


class SetupBlocked(BaseModel):
    at: datetime
    reason: str | None  # closed list (services/desktop_setup.BLOCKED_REASONS); anything else → null
    runtime: str | None = None  # claude | codex
    when: str | None = None  # found (while finding the runtime) | after_start (the session ended right after start)


class AgentEnded(BaseModel):
    """story #4433 — an agent whose session ended early: its last report and the person's last restart (None if never)."""
    member_id: str
    at: datetime
    runtime: Literal["claude", "codex"] | None = None
    exit_code: int | None = None
    restarted_at: datetime | None = None


class AgentStartFailed(BaseModel):
    """story #4452 — an agent the shell could not start: its last report (cleared once it connects or is restarted after it).
    `reason`/`code` are closed sets (onboarding_funnel START_FAILED_*) — the web words them; None = not one it knows."""
    member_id: str
    at: datetime
    reason: Literal["runtime_missing", "credentials_refused", "start_refused", "key_unreadable", "first_not_ready"] | None = None
    code: Literal[
        "session_limit", "credentials_missing", "profile_invalid", "unknown_profile", "adapter_prepare_failed", "spawn_failed",
        "not_connected", "bad_reply", "ended", "timeout",
    ] | None = None
    runtime: Literal["claude", "codex"] | None = None
    limit: int | None = None
    first_member_id: str | None = None


class SetupSignals(BaseModel):
    tools_connected: list[ToolsConnected]  # per agent: its first MCP connection (the manifest fetch)
    first_task_handed_at: datetime | None
    first_result_at: datetime | None
    first_result_member_id: str | None = None  # story #4468 — the agent that showed the first result (one of the setup's)
    first_screen_human_input_at: datetime | None  # the person typed on the agent's first screen (PO 12:23Z · web ⑦)
    workdir_fallback_at: datetime | None
    blocked: SetupBlocked | None
    agents_ended: list[AgentEnded] = []  # story #4433 — one row per agent whose session ended early
    agents_start_failed: list[AgentStartFailed] = []  # story #4452 — one row per agent the shell could not start


class SetupStatusRecipe(BaseModel):
    key: str
    name: str | None
    org_id: uuid.UUID | None  # null = a platform preset (the web names it by its translation, as the recipe list does)


class SetupStatusResponse(BaseModel):
    setup_id: uuid.UUID
    device_name: str
    state: Literal["waiting_for_app", "handed_over", "not_handed_over", "disconnected"]
    recipe_name: str | None
    recipe: SetupStatusRecipe | None = None
    work_item_id: str | None
    members: list[SetupMember]
    signals: SetupSignals


@router.get("/setups/{setup_id}", response_model=SetupStatusResponse)
async def get_setup_status(
    setup_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    """PO 08:31Z — one setup's state and the signals read from its events (web progress · folder fallback · failure ⑥)."""
    user_id = _human_only(auth)
    try:
        return SetupStatusResponse(**await setup_status(db, setup_id=setup_id, user_id=user_id, org_id=org_id))
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
    # Qadir 4830 · PO 05:48Z ④ — true when the device was already disconnected before this call (another admin first); the
    # screen then says so and shows who and when from here, instead of «you disconnected it»
    already_disconnected: bool
    revoked_at: datetime
    revoked_by_name: str | None


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
        done = await revoke_setup(db, setup_id=setup_id, user_id=user_id, org_id=org_id)
        names = await person_names(db, org_id, {done.revoked_by})
    except DesktopSetupError as e:
        await db.rollback()
        raise _error(e) from None
    await db.commit()
    return RevokeResponse(
        revoked_keys=done.keys, already_disconnected=done.already, revoked_at=done.revoked_at,
        revoked_by_name=names.get(done.revoked_by),
    )


# ── story #4548 — an already set-up device gets its relay token by a person's confirmation (contract 02d2cf71 v1.4 §1.1) ──


async def _auth_or_none(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    x_agent_api_key: str | None = Header(default=None, alias="x-agent-api-key"),
    request: Request = None,  # type: ignore[assignment]
) -> AuthContext | None:
    """The caller's identity, or None — so «no key» answers like every other refusal of the code (setup_not_found)."""
    try:
        return await get_current_user(credentials, x_agent_api_key, None, request)
    except HTTPException:
        return None


class DeviceTokenCodeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    setup_id: uuid.UUID | None = None  # PO 11:51Z — left out: the key's own setup
    challenge: str = Field(min_length=43, max_length=43)


class DeviceTokenCodeResponse(BaseModel):
    code: str
    expires_at: datetime


class DeviceTokenCodeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = SETUP_CODE_FIELD


class DeviceTokenCodePeek(BaseModel):
    device_name: str
    org_name: str | None
    expires_at: datetime


class DeviceTokenCodeConfirmed(BaseModel):
    setup_id: uuid.UUID


class DeviceTokenExchangeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = SETUP_CODE_FIELD
    verifier: str = Field(min_length=43, max_length=128)


@router.post("/device-token-codes", status_code=201, response_model=DeviceTokenCodeResponse)
@open_setup_limiter.limit("10/minute")  # per IP, as the setup code
async def post_device_token_code(
    request: Request, response: Response, body: DeviceTokenCodeRequest, db: AsyncSession = Depends(get_db),
    auth: AuthContext | None = Depends(_auth_or_none),
):
    """Asked with the setup's own agent key (PO 08:36Z) — the key asks, it never receives a token."""
    response.headers["Cache-Control"] = "no-store"
    api_key_id = ((auth.claims.get("app_metadata") or {}).get("api_key_id")) if auth is not None else None
    try:
        code, expires_at = await device_codes.create_code(db, api_key_id=api_key_id, setup_id=body.setup_id, challenge=body.challenge)
    except DesktopSetupError as e:
        raise _error(e) from None
    await db.commit()
    return DeviceTokenCodeResponse(code=code, expires_at=expires_at)


@router.post("/device-token-codes/peek", response_model=DeviceTokenCodePeek)
async def post_device_token_code_peek(
    body: DeviceTokenCodeBody, db: AsyncSession = Depends(get_db), auth: AuthContext = Depends(get_current_user),
):
    user_id = _human_only(auth)
    try:
        peeked = await device_codes.peek_code(db, code=body.code, user_id=user_id)
    except DesktopSetupError as e:
        raise _error(e) from None
    return DeviceTokenCodePeek(device_name=peeked.device_name, org_name=peeked.org_name, expires_at=peeked.expires_at)


@router.post("/device-token-codes/confirm", response_model=DeviceTokenCodeConfirmed)
async def post_device_token_code_confirm(
    body: DeviceTokenCodeBody, db: AsyncSession = Depends(get_db), auth: AuthContext = Depends(get_current_user),
):
    """A person's session, an owner/admin of the device's own org (not the org the web has open)."""
    user_id = _human_only(auth)
    try:
        setup_id = await device_codes.confirm_code(db, code=body.code, user_id=user_id)
    except DesktopSetupError as e:
        raise _error(e) from None
    await db.commit()
    return DeviceTokenCodeConfirmed(setup_id=setup_id)


@router.post("/device-token-codes/exchange")
@open_setup_limiter.limit("240/minute")  # the app asks every 1.5 s while the person confirms (as the setup exchange)
async def post_device_token_exchange(request: Request, body: DeviceTokenExchangeRequest, db: AsyncSession = Depends(get_db)):
    headers = {"Cache-Control": "no-store"}
    try:
        done = await device_codes.exchange_code(db, code=body.code, verifier=body.verifier)
    except DesktopSetupError as e:
        await db.rollback()
        err = _error(e)
        return JSONResponse(status_code=err.status_code, content={"data": None, "error": err.detail, "meta": None}, headers=headers)
    if done is None:
        await db.rollback()
        return JSONResponse(status_code=202, content={"status": "pending"}, headers=headers)
    await db.commit()
    setup_id, token, agent_ids = done
    return JSONResponse(
        status_code=200, content={"setup_id": str(setup_id), "device_token": token, "agent_member_ids": agent_ids}, headers=headers,
    )
