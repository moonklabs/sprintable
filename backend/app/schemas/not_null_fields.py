"""story #4337 — 요청 스키마의 «생략은 되지만 null은 안 되는» 필드.

DB 칸이 NOT NULL인데 요청 스키마가 `X | None = None`이면, 생략(= 바꾸지 않음 · 서버 기본값)과 명시 null이 같은 모양으로 들어와
null이 저장까지 가서 무결성 오류 500이 됐다(미팅 수정 · 가설 수정 등). 이 베이스를 쓰는 스키마는 `NOT_NULL_FIELDS`에 적은 필드에
명시 null이 오면 그 필드 자리의 422로 거절한다. 생략은 그대로 허용한다(기본값은 검증하지 않으므로 이 검사가 돌지 않는다).
"""
from __future__ import annotations

from typing import Any, ClassVar

from pydantic import BaseModel, ValidationInfo, field_validator
from pydantic_core import PydanticCustomError


class RejectsExplicitNull(BaseModel):
    """`NOT_NULL_FIELDS`의 필드는 생략 가능 · null 불가(422 `null_not_allowed`)."""

    NOT_NULL_FIELDS: ClassVar[frozenset[str]] = frozenset()

    @field_validator("*", mode="before")
    @classmethod
    def _reject_explicit_null(cls, value: Any, info: ValidationInfo) -> Any:
        if value is None and info.field_name in cls.NOT_NULL_FIELDS:
            raise PydanticCustomError(
                "null_not_allowed",
                "{field} cannot be null — omit it to leave it unchanged",
                {"field": info.field_name},
            )
        return value
