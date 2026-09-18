#!/usr/bin/env python3
"""story #3383 — destructive_schema 파일 200개가 각자 `Base.metadata.create_all()`을
자기 안에서 호출해(story 8236bbc3 격리 원칙) 파일마다 전체 스키마를 처음부터 다시 만든다.
파일 수가 94→200으로 늘면서(story #6283a9d1 실측) 이 반복 비용이 CI 벽시계를 지배하게
됐다 — 개별 테스트 자체는 안 느리다(로컬 재현으로 확認, 원인은 GH Actions 러너가 로컬
대비 ~6배 느린 것과 겹쳐 증폭).

이 스크립트는 그 create_all()을 **한 번만** 실 DB에 대해 돌려 템플릿 DB를 만든다. Postgres의
`CREATE DATABASE ... TEMPLATE tpl`은 파일시스템 레벨 복제라 초 단위로 끝난다 — 이후 매
destructive-schema 파일은 `createdb -T tpl`로 이미 스키마가 있는 DB를 받고, 파일 자신의
`create_all()` 호출은 SQLAlchemy 기본 `checkfirst=True`라 이미 있는 테이블엔 아무것도
안 해 사실상 no-op이 된다(테스트 파일 쪽 코드는 한 줄도 안 고친다 — 그 자체가 안전장치:
템플릿이 어떤 이유로든 못 만들어지면 각 파일이 여전히 스스로 스키마를 만들 수 있다).

`app.models`(app/models/__init__.py)를 import하는 것만으로 전체 스키마가 채워지는지는
`scripts/lint_model_registration_completeness.py`가 별도로 보증한다(이 스크립트가 그
보증에 의존한다 — 새 모델이 그 가드를 통과했다면 여기도 자동으로 포함된다).

사용: DATABASE_URL(asyncpg)이 가리키는 DB에 스키마를 만든다. ci.yml이 한 번 호출하고
바로 `ALTER DATABASE ... 불필요`(sprintable 유저가 superuser라 소유 DB를 바로 템플릿
소스로 쓸 수 있다 — 로컬 실측 확認, `is_template` 플래그 전환 불요).
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

# `python scripts/foo.py`는 sys.path[0]을 scripts/ 자신으로 잡는다(cwd가 아니다) — `app`은
# backend/ 바로 아래라 이대로면 항상 ModuleNotFoundError(다른 backend/scripts/*.py 몇 개가
# 이미 겪고 있던 것과 동일 클래스, 이 스크립트만 스스로 고쳐 둔다).
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


async def main() -> int:
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL 미설정 — 템플릿을 만들 대상 DB가 없다", file=sys.stderr)
        return 2

    from sqlalchemy.ext.asyncio import create_async_engine

    import app.models  # noqa: F401 — Base.metadata 전체 등록(위 docstring 참고)
    from app.core.database import Base

    engine = create_async_engine(database_url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await engine.dispose()
    print(f"OK: 템플릿 스키마 생성 완료({len(Base.metadata.tables)}개 테이블)")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
