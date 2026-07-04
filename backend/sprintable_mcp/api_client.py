"""SprintableClient — httpx 기반 PM API HTTP 클라이언트."""
from __future__ import annotations

import contextvars
import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# 85429ee0: per-call 프로젝트 override(org-agent 멀티프로젝트 grant). server._flat 가 tool-call 스코프로
# set/reset. 설정 시 client.project_id(쿼리/바디) + X-Project-Id 헤더에 반영. 미설정 시 키 default(무회귀).
_project_override: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "mcp_project_override", default=None
)


def set_project_override(project_id: str | None):
    """per-call 프로젝트 override 설정 — 반환 token 으로 reset(server _flat wrapper 가 tool 호출 스코프로 사용)."""
    return _project_override.set(project_id or None)


def reset_project_override(token) -> None:
    _project_override.reset(token)


# E-MCP-HTTP S1: per-request API 키 override(http 모드 멀티테넌트). http 미들웨어가 요청경계서
# Authorization: Bearer <key> 를 set → request() 가 그 키로 백엔드 호출. 미설정(stdio)이면 env
# 단일키(self._api_key) 사용(무회귀). contextvar 라 async 동시요청별 격리.
_api_key_override: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "mcp_api_key_override", default=None
)


def set_api_key_override(api_key: str | None):
    """per-request API 키 override 설정 — 반환 token 으로 reset(http 미들웨어가 요청 스코프로 사용)."""
    return _api_key_override.set(api_key or None)


def reset_api_key_override(token) -> None:
    _api_key_override.reset(token)


# E-MCP-HTTP ee2f4e58: per-key 해소 컨텍스트 캐시(http 멀티테넌트). 키 → {member_id,org_id,project_id}.
# http 미들웨어가 요청경계서 ensure_auth_context(key) 로 1회 해소·캐시 → 명시 project_id 없는 툴도 그 키의
# default 로 해소(stdio startup resolve_auth_context 와 parity). 싱글톤 self._* 에 쓰지 않아 테넌트 격리(무블리드).
_auth_ctx_cache: dict[str, dict[str, str]] = {}

# 백엔드 에러 본문을 MCP 에러 문자열에 노출할 때, 비정상적으로 큰 body가
# 에이전트 컨텍스트를 잠식하지 않도록 자르는 상한.
_ERROR_BODY_MAX = 1500


class SprintableApiError(Exception):
    def __init__(self, status: int, message: str, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


def _format_validation_errors(detail: list) -> str | None:
    """FastAPI 422 RequestValidationError 배열 → 'field: msg' 요약.

    detail 항목 shape: {"loc": ["body", "metric_definition", "source"], "msg": "...", "type": "..."}.
    loc의 선행 "body"/"query"/"path" 토큰은 노이즈라 제거하고 남은 경로를 '.'로 잇는다.
    """
    parts: list[str] = []
    for item in detail:
        if not isinstance(item, dict):
            parts.append(str(item))
            continue
        loc = item.get("loc") or []
        trimmed = [str(p) for p in loc if p not in ("body", "query", "path")]
        field = ".".join(trimmed) if trimmed else "(request)"
        msg = item.get("msg") or item.get("type") or "invalid"
        parts.append(f"{field}: {msg}")
    return "; ".join(parts) if parts else None


def _extract_error_message(status: int, body: Any) -> str:
    """백엔드 4xx/5xx 응답 본문에서 사람이 읽을 수 있는 사유를 추출한다.

    지원 shape (우선순위 순):
      1. {"error": {"code", "message", ...}}  — 앱 표준 엔벨로프(main.py http_exception_handler)
      2. {"detail": {"code", "message"}}      — dict detail HTTPException(엔벨로프 전 raw, 방어적)
      3. {"detail": [ {loc, msg, type}, ... ]} — FastAPI 422 pydantic 검증 배열
      4. {"detail": "...문자열..."}            — 평문 detail
      5. JSON이 아니거나 미지의 shape         — 본문 텍스트를 잘라서 그대로 노출

    이전 구현은 1만 보고 2~5를 버려(특히 422 검증 배열) 'Sprintable API 422'로 삼켜버렸다.
    """
    # 5: JSON 파싱 실패 → 원문 텍스트(잘림)로 폴백.
    if isinstance(body, str):
        text = body.strip()
        if not text:
            return f"Sprintable API {status}"
        if len(text) > _ERROR_BODY_MAX:
            text = text[:_ERROR_BODY_MAX] + "…(truncated)"
        return f"Sprintable API {status}: {text}"

    if isinstance(body, dict):
        # 1: 표준 {error: {code, message}} 엔벨로프.
        env = body.get("error")
        if isinstance(env, dict):
            code = env.get("code")
            message = env.get("message") or ""
            if code and message:
                return f"{code}: {message}"
            if message:
                return str(message)
            if code:
                return str(code)
        elif isinstance(env, str) and env:
            return env

        detail = body.get("detail")
        # 2: dict detail({code, message}) — 엔벨로프 미적용 raw HTTPException 방어.
        if isinstance(detail, dict):
            code = detail.get("code")
            message = detail.get("message") or ""
            if code and message:
                return f"{code}: {message}"
            if message:
                return str(message)
        # 3: 422 검증 배열.
        if isinstance(detail, list):
            summary = _format_validation_errors(detail)
            if summary:
                return f"Sprintable API {status} validation: {summary}"
        # 4: 평문 detail.
        if isinstance(detail, str) and detail.strip():
            return f"Sprintable API {status}: {detail.strip()}"

    # 미지의 shape — 직렬화해서 잘라 노출(완전 삼킴 방지).
    try:
        import json as _json

        text = _json.dumps(body, ensure_ascii=False)
        if len(text) > _ERROR_BODY_MAX:
            text = text[:_ERROR_BODY_MAX] + "…(truncated)"
        return f"Sprintable API {status}: {text}"
    except Exception:
        return f"Sprintable API {status}"


class SprintableClient:
    """Sprintable PM API 싱글톤 클라이언트.

    사용 순서:
      1. client.configure(api_url, api_key)
      2. await client.resolve_auth_context()   ← 부팅 시 1회
      3. await client.get/post/put/patch/delete(...)
    """

    def __init__(self) -> None:
        self._base_url: str = ""
        self._api_key: str = ""
        self._member_id: str = ""
        self._org_id: str = ""
        self._project_id: str = ""

    def configure(self, api_url: str, api_key: str) -> None:
        if not api_url:
            raise ValueError("api_url is required")
        if not api_key:
            raise ValueError("api_key is required")
        self._base_url = api_url.rstrip("/")
        self._api_key = api_key

    async def resolve_auth_context(self) -> dict[str, str]:
        """GET /api/v2/auth/me → org_id/project_id/member_id 캐시(stdio 부팅 시 1회)."""
        data = await self.get("/api/v2/auth/me")
        self._member_id = data.get("member_id") or ""
        self._org_id = data.get("org_id") or ""
        self._project_id = data.get("project_id") or ""
        logger.info(
            "auth context resolved member_id=%s org_id=%s project_id=%s",
            self._member_id, self._org_id, self._project_id,
        )
        return {
            "member_id": self._member_id,
            "org_id": self._org_id,
            "project_id": self._project_id,
        }

    async def ensure_auth_context(self, api_key: str) -> dict[str, str]:
        """E-MCP-HTTP ee2f4e58: per-request bearer 키의 default 컨텍스트(member/org/project)를 키별
        1회 해소·캐시. http 미들웨어가 요청경계서 호출 → 명시 project_id 없는 툴 호출도 그 키의 default 로
        해소(stdio resolve_auth_context 와 parity·422 제거). 싱글톤 self._* 는 건드리지 않아 테넌트 격리.

        멀티프로젝트 키: /api/v2/auth/me 가 주는 server-canonical default project_id 를 그대로 사용
        (클라 임의선택 0). default 가 비면 빈 채로 둬 호출자가 project_id 를 명시하게 한다(추측 금지).

        캐시 수명 = 프로세스. 키의 default project 가 런타임 중 바뀌면 stale 할 수 있으나(재기동 시 해소),
        parity 가 목표라 TTL 은 의도적으로 두지 않는다(over-engineer 회피).
        """
        if not api_key:
            return {}
        cached = _auth_ctx_cache.get(api_key)
        if cached is not None:
            return cached
        data = await self.get("/api/v2/auth/me")
        ctx = {
            "member_id": data.get("member_id") or "",
            "org_id": data.get("org_id") or "",
            "project_id": data.get("project_id") or "",
        }
        _auth_ctx_cache[api_key] = ctx
        return ctx

    def _effective_ctx(self) -> dict[str, str]:
        """현 요청의 effective 키(per-request override ∨ env 단일키)에 해소된 컨텍스트.

        stdio: override 미설정이라 env 키 기준이고 캐시는 비어 있어 {} → 프로퍼티는 self._* 로 폴백(무회귀).
        http: 미들웨어가 그 요청 키로 ensure_auth_context 해둬 default 컨텍스트를 돌려준다.
        """
        key = _api_key_override.get() or self._api_key
        return _auth_ctx_cache.get(key, {})

    @property
    def member_id(self) -> str:
        # stdio env-key 해소값 우선 → 없으면(http) per-key 해소 캐시.
        return self._member_id or self._effective_ctx().get("member_id", "")

    @property
    def org_id(self) -> str:
        return self._org_id or self._effective_ctx().get("org_id", "")

    @property
    def project_id(self) -> str:
        # per-call override(85429ee0) 우선. override=None(=미설정·arg 부재)은 falsy 라 skip →
        # stdio env-key default → http per-key 해소 default(ee2f4e58). 이 fall-through 가 422 제거 핵심.
        return (
            _project_override.get()
            or self._project_id
            or self._effective_ctx().get("project_id", "")
        )

    async def request(
        self,
        method: str,
        path: str,
        *,
        json: dict | None = None,
        params: dict | None = None,
    ) -> Any:
        url = f"{self._base_url}{path}"
        # E-MCP-HTTP S1: effective 키 = per-request override(http 멀티테넌트) ∨ env 단일키(stdio·무회귀).
        _key = _api_key_override.get() or self._api_key
        from .config import settings as _mcp_settings

        headers = {
            "Authorization": f"Bearer {_key}",
            "x-agent-api-key": _key,
            "Content-Type": "application/json",
            # E-MCP-OPT S5(#5): BE 가 첫인증 등 텔레메트리에서 실 transport 를 알 수 있도록 자기신고
            # (BE 는 이 값을 신뢰만 하고 인가에 쓰지 않음 — 순수 관측용, per-request bearer/scope 가 실
            # SSOT). 미설정 시 BE 는 fallback "stdio"(레거시 무회귀).
            "X-MCP-Transport": (_mcp_settings.mcp_transport or "stdio").strip().lower(),
        }
        # 85429ee0: per-call override 시 X-Project-Id 헤더 전송 — 백엔드 get_verified_org_id 가
        # has_project_access 로 멤버십 검증 후 그 프로젝트로 컨텍스트 전환(mutation 라우트). 미설정 시
        # 헤더 미전송(키 default·무회귀).
        _override = _project_override.get()
        if _override:
            headers["X-Project-Id"] = _override

        # POST/PUT/PATCH body에 context 필드 자동 주입. ee2f4e58: 프로퍼티 경유로 읽어 http per-key
        # 해소 default 까지 반영(stdio 는 self._* 우선이라 무회귀).
        if method.upper() in ("POST", "PUT", "PATCH") and json is not None:
            if not json.get("project_id") and self.project_id:
                json = {**json, "project_id": self.project_id}
            if not json.get("org_id") and self.org_id:
                json = {**json, "org_id": self.org_id}
            if not json.get("created_by") and self.member_id:
                json = {**json, "created_by": self.member_id}

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.request(method, url, json=json, params=params, headers=headers)

        if not resp.is_success:
            body: Any = None
            try:
                body = resp.json()
            except Exception:
                # 비-JSON 본문(HTML 502, 평문 등)도 삼키지 않고 노출.
                try:
                    body = resp.text
                except Exception:
                    body = None
            message = _extract_error_message(resp.status_code, body)
            raise SprintableApiError(resp.status_code, message, body)

        data = resp.json()
        # {data: T} 래핑이면 언래핑, 그 외(배열 등)는 직접 반환
        if isinstance(data, dict) and "data" in data:
            return data["data"]
        return data

    async def get(self, path: str, *, params: dict | None = None) -> Any:
        return await self.request("GET", path, params=params)

    async def post(self, path: str, *, json: dict | None = None) -> Any:
        return await self.request("POST", path, json=json or {})

    async def put(self, path: str, *, json: dict | None = None) -> Any:
        return await self.request("PUT", path, json=json or {})

    async def patch(self, path: str, *, json: dict | None = None) -> Any:
        return await self.request("PATCH", path, json=json or {})

    async def delete(self, path: str, *, params: dict | None = None) -> Any:
        return await self.request("DELETE", path, params=params)


client = SprintableClient()
