"""PaymentProvider — PG 어댑터 인터페이스(#2478 B, 설계문서 billing-arch-modular-pg-ledger-v0-1
§2). 도메인(구독·요금·집행·원장)은 PG를 모른다 — PG는 이 인터페이스 뒤에만 존재한다.

메서드는 Python 컨벤션(snake_case)을 따른다(기존 설계문서가 가리켰던 FE @/lib/payment/factory
getPaymentAdapter는 死코드 — 06:14Z 미르코 그라운딩 정정으로 backend Python이 정본).

⛔B는 PolarAdapter만 실 구현한다(기존 backend/ee/routers/billing.py 로직 무회귀 이관).
TossAdapter는 별도 스토리(C) — 구현되지 않은 메서드/어댑터는 NotImplementedError로 명시한다
(조용히 틀린 동작보다 명확한 실패가 낫다)."""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class PaymentProvider(ABC):
    @abstractmethod
    async def create_customer(self, **kwargs: Any) -> dict:
        """PG측 고객 레코드 생성."""

    @abstractmethod
    async def create_checkout(self, **kwargs: Any) -> dict:
        """호스티드 체크아웃 세션 생성(Polar 방식 — 구독 객체를 PG가 관리)."""

    @abstractmethod
    async def create_billing_key(self, **kwargs: Any) -> dict:
        """빌링키 발급(Toss 방식 — PG에 구독 객체가 없고, 우리가 정기결제를 직접 스케줄)."""

    @abstractmethod
    async def charge(self, **kwargs: Any) -> dict:
        """단건 결제 승인."""

    @abstractmethod
    def verify_webhook(self, raw_body: bytes, signature: str | None) -> bool:
        """웹훅 서명 검증. 순수 계산(HMAC 등)이라 동기 — 원 backend 로직도 동기였다."""

    @abstractmethod
    async def refund(self, **kwargs: Any) -> dict:
        """환불."""

    @abstractmethod
    async def open_portal(self, **kwargs: Any) -> dict:
        """PG 고객 포털(결제수단 관리 등) URL 발급."""

    @abstractmethod
    async def cancel(self, **kwargs: Any) -> dict:
        """구독/빌링키 취소."""
