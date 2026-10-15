from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# Expo push 토큰 포맷: ExponentPushToken[...] 또는 ExpoPushToken[...] (crux §2: 클라 제출값 방어적 검증).
_EXPO_TOKEN_RE = re.compile(r"^Expo(nent)?PushToken\[[^\[\]\s]+\]$")
# APNs raw device token: didRegisterForRemoteNotificationsWithDeviceToken NSData를 byte별
# %02x로 이어붙인 hex(story #3064, 민군 앱 축 확認 포맷). 길이는 고정하지 않는다 — Apple이
# 토큰 바이트 길이를 문서상 보장하지 않아(현재 32바이트=64자가 통상값) 짝수 hex만 강제.
_APNS_TOKEN_RE = re.compile(r"^[0-9a-fA-F]{16,}$")


class RegisterPushDevice(BaseModel):
    """디바이스 등록 요청. member_id 는 body 에 없음 — auth context 서 산출(IDOR: 타 멤버 등록 불가).

    story #3064: macOS는 Expo push 토큰을 만들 수 없어(Expo 런타임이 아님) 플랫폼별 토큰
    필드가 분리된다 — platform="macos"면 apns_device_token 필수·expo_push_token은 생략,
    그 외(ios/android/미보고)는 기존과 동일하게 expo_push_token 필수.
    """

    expo_push_token: str | None = None
    apns_device_token: str | None = None
    # story 1935: v0.2.4 앱이 platform 없이 register하는 실 케이스 발견 — optional화(fake
    # default 아닌 진짜 미보고). 신 버전이 보내면 그대로 저장, 안 보내면 NULL(repo가 기존
    # 값을 덮어쓰지 않음 — upsert COALESCE).
    platform: Literal["ios", "android", "macos"] | None = None
    device_id: str | None = None
    app_version: str | None = None

    @field_validator("expo_push_token")
    @classmethod
    def token_must_be_expo_format(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if not _EXPO_TOKEN_RE.match(v):
            raise ValueError("expo_push_token must be an ExponentPushToken[...] value")
        return v

    @field_validator("apns_device_token")
    @classmethod
    def token_must_be_apns_hex(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip().lower()
        if not _APNS_TOKEN_RE.match(v):
            raise ValueError("apns_device_token must be a hex device token")
        return v

    @model_validator(mode="after")
    def token_matches_platform(self) -> "RegisterPushDevice":
        if self.platform == "macos":
            if not self.apns_device_token:
                raise ValueError("apns_device_token is required when platform is macos")
            if self.expo_push_token:
                raise ValueError("expo_push_token must not be set when platform is macos")
        elif not self.expo_push_token:
            raise ValueError("expo_push_token is required unless platform is macos")
        return self


class PushDeviceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    member_id: uuid.UUID
    expo_push_token: str | None = None
    apns_device_token: str | None = None
    platform: str | None = None
    device_id: str | None = None
    app_version: str | None = None
    is_active: bool
    created_at: datetime
    last_seen_at: datetime


class PushDiagnosticsReport(BaseModel):
    """story #4394 — the app reports where push registration stopped, so a release build that is denied permission or fails to
    get a token leaves a trace on the server (those failures were silent: logs are debug-only in the app).

    Carries **no token**: any unknown field is rejected with 422, so a client that sends expo_push_token (or any other token)
    cannot slip it into the log line. Field names agreed with the app side (Min, 2026-09-28).
    """

    model_config = ConfigDict(extra="forbid")

    platform: Literal["android", "ios"]
    app_version: str = Field(min_length=1, max_length=32)
    app_build: str = Field(min_length=1, max_length=16)
    permission: Literal["granted", "provisional", "denied", "undetermined"]
    can_ask_again: bool
    # where the flow stopped: permission → device_token (native FCM/APNs token) → expo_token → register (POST /api/push/devices
    # not 2xx) → ok (registered).
    stage: Literal["permission", "device_token", "expo_token", "register", "ok"]
    # a code, never a raw message (e.g. E_REGISTRATION_FAILED · FIS_AUTH_ERROR · HTTP_401 · UNKNOWN)
    error_code: str | None = Field(default=None, max_length=64, pattern=r"^[A-Z0-9_:.-]+$")


class UnregisterPushDevice(BaseModel):
    """story #4397 — the app switches its own device off when it lands on /login (logout · expired session) or starts
    without a session. No session is needed: only whoever knows the token can switch that device off, and only off."""

    model_config = ConfigDict(extra="forbid")

    expo_push_token: str

    @field_validator("expo_push_token")
    @classmethod
    def token_must_be_expo_format(cls, v: str) -> str:
        v = v.strip()
        if not _EXPO_TOKEN_RE.match(v):
            raise ValueError("expo_push_token must be ExponentPushToken[...] or ExpoPushToken[...]")
        return v

