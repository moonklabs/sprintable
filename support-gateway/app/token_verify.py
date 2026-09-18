"""위임 토큰 검증 — 이 서비스가 가진 유일한 "신뢰 재료"(config.py 참고). backend의 어떤 fleet
자격(JWT_SECRET·API Key·MCP 시크릿)도 이 모듈이 알 필요가 없다: 서명이 SUPPORT_GATEWAY_TOKEN_SECRET
로 유효하면 클레임을 그대로 믿는다 — org 소속 여부를 다시 DB로 확인하지 않는다(그럴 DB 자체가
없다, AC2). 발급 측 계약은 backend/app/routers/support_gateway_token.py 참고."""
from __future__ import annotations

import uuid
from dataclasses import dataclass

import jwt
from fastapi import Header, HTTPException

from app.config import settings


class DelegatedTokenError(Exception):
    pass


@dataclass(frozen=True)
class DelegatedIdentity:
    org_id: uuid.UUID
    user_id: uuid.UUID


def verify_delegated_token(token: str) -> DelegatedIdentity:
    if not settings.token_secret:
        # fail-closed — 시크릿 미설정은 "무제한 허용"이 아니라 "전부 거부"(memory
        # feedback_actor_type_failclosed와 동형: 신뢰 재료 부재=최대 보수 판정).
        raise DelegatedTokenError("SUPPORT_GATEWAY_TOKEN_SECRET not configured")
    try:
        claims = jwt.decode(token, settings.token_secret, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise DelegatedTokenError(str(exc)) from exc
    # story #3263(지원v1·5에스컬레이션, 페드루 PO 조건①) — 같은 대칭키(SUPPORT_GATEWAY_
    # TOKEN_SECRET)로 위임 토큰(이 함수)과 에스컬 이벤트 토큰(backend가 검증, escalation_
    # delivery.py) 두 종이 공존한다. 위임 토큰은 원래 aud 클레임이 없다(support_gateway_
    # token.py 발급 계약 그대로, 4클레임 고정) — 에스컬 토큰만 aud="backend:escalation-
    # events"를 싣는다. ⚠️실측(2026-08-31): PyJWT는 decode()에 audience=를 안 넘겨도 토큰에
    # aud 클레임이 «있으면» 자동으로 InvalidAudienceError를 던진다(라이브러리 기본 동작 —
    # 위 except jwt.PyJWTError가 이미 이걸로 잡는다, 직접 확認: 아래 가드를 지워도 여전히
    # 거부됨). 아래 명시 체크는 그 1차 방어가 사라지거나(PyJWT 버전업 등) 우회되는 경우를
    # 겨냥한 2차 방어+에러 원인을 클레임 이름으로 못박아 디버깅을 쉽게 하는 목적
    # (defense-in-depth, 단독 방어선이 아니다).
    if claims.get("aud") is not None:
        raise DelegatedTokenError(f"unexpected aud claim for delegated token: {claims.get('aud')!r}")
    try:
        org_id = uuid.UUID(claims["org_id"])
        user_id = uuid.UUID(claims["user_id"])
    except (KeyError, ValueError) as exc:
        raise DelegatedTokenError(f"malformed claims: {exc}") from exc
    return DelegatedIdentity(org_id=org_id, user_id=user_id)


async def require_delegated_identity(authorization: str = Header(default="")) -> DelegatedIdentity:
    """FastAPI dependency — Authorization: Bearer <delegated token>. 자격 없으면 401(라우트 자체가
    존재를 노출하는 404가 아니라 401 — 인가 없음과 자원 부재를 섞지 않는다)."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization[len("Bearer "):]
    try:
        return verify_delegated_token(token)
    except DelegatedTokenError as exc:
        raise HTTPException(status_code=401, detail=f"invalid delegated token: {exc}") from exc


# story #3279(지원v1·후속) — 운영자 회신 배달(backend→gateway, escalation_delivery.py의
# 반대 방향). 같은 대칭키(SUPPORT_GATEWAY_TOKEN_SECRET)를 backend가 이 aud로 서명해
# 보낸다(backend/app/services/operator_reply_delivery.py 발급 계약). 위임 토큰(aud 없음)·
# 에스컬레이션 배달 토큰(aud="backend:escalation-events", backend가 검증)과 셋 다 같은
# 키를 쓰지만 aud로 구조적으로 분리된 별개 신뢰 재료다.
OPERATOR_REPLY_AUD = "support-gateway:operator-reply"


class OperatorReplyTokenError(Exception):
    pass


@dataclass(frozen=True)
class OperatorReplyClaims:
    escalation_id: uuid.UUID
    content: str


def verify_operator_reply_token(token: str) -> OperatorReplyClaims:
    if not settings.token_secret:
        raise OperatorReplyTokenError("SUPPORT_GATEWAY_TOKEN_SECRET not configured")
    try:
        # audience= 명시 — PyJWT가 이 시점에 이미 aud 부재/불일치 둘 다 거부한다(부재 시
        # MissingRequiredClaimError, 불일치 시 InvalidAudienceError — 둘 다 PyJWTError 하위).
        claims = jwt.decode(token, settings.token_secret, algorithms=["HS256"], audience=OPERATOR_REPLY_AUD)
    except jwt.PyJWTError as exc:
        raise OperatorReplyTokenError(str(exc)) from exc
    # story #3279(페드루 PO 지시, 2026-09-01) — story #3661에서 backend 쪽 jose 검증기가
    # "토큰에 aud 클레임이 아예 없으면 audience= 인자를 조용히 건너뛴다"는 라이브러리별
    # 상이 동작으로 뚫릴 뻔한 것과 동형 클래스 재발 방지. 이 함수는 PyJWT(jose 아님)라
    # 위 audience= 인자가 이미 부재/불일치 둘 다 거부하지만(실측: 가드를 지워도 여전히
    # 거부됨), "라이브러리 기본 동작 하나에만 의존하지 않는다"는 이 코드베이스의 확立된
    # 관례대로 독립 2차 방어를 명시로 남긴다 — 부재든 불일치든 이 줄이 한 번 더 잡는다.
    if claims.get("aud") != OPERATOR_REPLY_AUD:
        raise OperatorReplyTokenError(f"missing or mismatched aud claim: {claims.get('aud')!r}")
    try:
        escalation_id = uuid.UUID(claims["escalation_id"])
        content = str(claims["content"])
    except (KeyError, ValueError) as exc:
        raise OperatorReplyTokenError(f"malformed claims: {exc}") from exc
    if not content.strip():
        raise OperatorReplyTokenError("empty content")
    return OperatorReplyClaims(escalation_id=escalation_id, content=content)


async def require_operator_reply_claims(authorization: str = Header(default="")) -> OperatorReplyClaims:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization[len("Bearer "):]
    try:
        return verify_operator_reply_token(token)
    except OperatorReplyTokenError as exc:
        raise HTTPException(status_code=401, detail=f"invalid operator reply token: {exc}") from exc


# story #183fe7a5(지원v1·후속) — 게이트 해소(approve/reject)→gateway SupportEscalation.status
# 동기화 콜백(backend→gateway, escalation_delivery.py의 반대 방향 — OPERATOR_REPLY_AUD와
# 같은 방향, 같은 대칭키, aud만 다름). backend/app/services/escalation_resolution_delivery.py
# 발급 계약.
ESCALATION_RESOLUTION_AUD = "support-gateway:escalation-resolution"


class EscalationResolutionTokenError(Exception):
    pass


@dataclass(frozen=True)
class EscalationResolutionClaims:
    escalation_id: uuid.UUID
    resolution: str


def verify_escalation_resolution_token(token: str) -> EscalationResolutionClaims:
    if not settings.token_secret:
        raise EscalationResolutionTokenError("SUPPORT_GATEWAY_TOKEN_SECRET not configured")
    try:
        # audience= 명시 — PyJWT가 이 시점에 이미 aud 부재/불일치 둘 다 거부(OPERATOR_REPLY_AUD
        # 검증과 동일 실측 근거).
        claims = jwt.decode(
            token, settings.token_secret, algorithms=["HS256"], audience=ESCALATION_RESOLUTION_AUD
        )
    except jwt.PyJWTError as exc:
        raise EscalationResolutionTokenError(str(exc)) from exc
    # story #3661/#3279 선례 재사용(2026-09-01) — "라이브러리 기본 동작 하나에만 의존하지
    # 않는다"는 확立된 관례대로 독립 2차 방어를 명시로 남긴다.
    if claims.get("aud") != ESCALATION_RESOLUTION_AUD:
        raise EscalationResolutionTokenError(f"missing or mismatched aud claim: {claims.get('aud')!r}")
    try:
        escalation_id = uuid.UUID(claims["escalation_id"])
        resolution = str(claims["resolution"])
    except (KeyError, ValueError) as exc:
        raise EscalationResolutionTokenError(f"malformed claims: {exc}") from exc
    if not resolution.strip():
        raise EscalationResolutionTokenError("empty resolution")
    return EscalationResolutionClaims(escalation_id=escalation_id, resolution=resolution)


async def require_escalation_resolution_claims(
    authorization: str = Header(default=""),
) -> EscalationResolutionClaims:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization[len("Bearer "):]
    try:
        return verify_escalation_resolution_token(token)
    except EscalationResolutionTokenError as exc:
        raise HTTPException(status_code=401, detail=f"invalid escalation resolution token: {exc}") from exc


async def require_admin(authorization: str = Header(default="")) -> None:
    """story #3264 AC3/AC4 — 어드민 계측 조회(app/routers/admin.py) 전용. 고객 위임 토큰과
    완전히 다른 신뢰 재료(settings.admin_token, 정적 비교) — org 클레임이 없으므로 이 경로는
    org 스코프 개념 자체가 없다(내부 집계 조회일 뿐, 고객 대화 원문을 반환하지 않는다).
    미설정 시 fail-closed(빈 문자열끼리 비교해 통과하는 사고 방지 — 명시적으로 막는다)."""
    if not settings.admin_token:
        raise HTTPException(status_code=401, detail="admin token not configured")
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization[len("Bearer "):]
    if token != settings.admin_token:
        raise HTTPException(status_code=401, detail="invalid admin token")
