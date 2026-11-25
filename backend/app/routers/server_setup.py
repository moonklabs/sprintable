"""story 5023 (B2-2, a) — `GET /api/v2/server-setup/state`: the one question `sprintable-host server set-public-origin` (and the server host's own start) asks before the server may be opened to other computers.

Answer: `{"owner_exists": bool, "signup_open": bool}` (no envelope — the contract of doc «공개 주소» 값 정의 v1.1). The host opens the door only on `owner_exists: true` AND `signup_open: false`.

Who may ask: only a caller on this machine that came straight to the loopback port. The route exists ONLY on an embedded install (`register_server_setup_routes` — not registered anywhere else, hosted included); it answers 403 (the same bare refusal as local-bootstrap) to a caller that is not loopback or that carries a
proxy header: every request that comes in through the web server's relay (and so through the TLS front) carries `X-Forwarded-For`, so the outside can never read it. No sign-in is needed: the answer is two booleans and the caller is this machine.

`signup_open`: a stranger could still register. False exactly when the first-owner rule (`services/server_owner_setup`) is on AND an owner exists; on a server where the rule is off (the desktop app's) sign-up is as open as it always was, so the answer is True and the door is never opened there.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.database import get_db
from app.routers.local_auth import _FORWARDED_HEADERS, _LOOPBACK, _refuse
from app.services import server_owner_setup

router = APIRouter(prefix="/api/v2/server-setup", tags=["server-setup", "local"])


@router.get("/state")
async def server_setup_state(request: Request, session: AsyncSession = Depends(get_db)) -> JSONResponse:
    if not settings.is_embedded:  # registered only when embedded; this keeps a mis-wired app from serving it anywhere else
        return _refuse()
    host = request.client.host if request.client else ""
    if host not in _LOOPBACK or any(h in request.headers for h in _FORWARDED_HEADERS):
        return _refuse()
    owner = await server_owner_setup.owner_exists(session)
    return JSONResponse({"owner_exists": owner, "signup_open": not (server_owner_setup.enabled() and owner)}, headers={"Cache-Control": "no-store"})


def register_server_setup_routes(app: FastAPI) -> bool:
    """Register the route on `app` only when this is an embedded install. Returns whether it did."""
    if settings.is_embedded:
        app.include_router(router)
        return True
    return False
