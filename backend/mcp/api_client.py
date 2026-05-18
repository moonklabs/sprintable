"""SprintableClient — httpx 기반 PM API HTTP 클라이언트."""
from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class SprintableApiError(Exception):
    def __init__(self, status: int, message: str, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


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
        """GET /api/v2/auth/me → org_id/project_id/member_id 캐시."""
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

    @property
    def member_id(self) -> str:
        return self._member_id

    @property
    def org_id(self) -> str:
        return self._org_id

    @property
    def project_id(self) -> str:
        return self._project_id

    async def request(
        self,
        method: str,
        path: str,
        *,
        json: dict | None = None,
        params: dict | None = None,
    ) -> Any:
        url = f"{self._base_url}{path}"
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "x-agent-api-key": self._api_key,
            "Content-Type": "application/json",
        }

        # POST/PUT/PATCH body에 context 필드 자동 주입
        if method.upper() in ("POST", "PUT", "PATCH") and json is not None:
            if not json.get("project_id") and self._project_id:
                json = {**json, "project_id": self._project_id}
            if not json.get("org_id") and self._org_id:
                json = {**json, "org_id": self._org_id}
            if not json.get("created_by") and self._member_id:
                json = {**json, "created_by": self._member_id}

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.request(method, url, json=json, params=params, headers=headers)

        if not resp.is_success:
            body: Any = None
            try:
                body = resp.json()
            except Exception:
                pass
            error = body or {}
            message = (
                (error.get("error") or {}).get("message")
                if isinstance(error.get("error"), dict)
                else error.get("error")
            ) or f"Sprintable API {resp.status_code}"
            raise SprintableApiError(resp.status_code, str(message), body)

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
