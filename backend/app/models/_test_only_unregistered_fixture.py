"""story #2662 AC2 전용 — 영구 미등재 픽스처(운영 모델 아님).

PR#3700(story #2255) 리뷰(페드루, 2026-09-02)에서 드러난 문제: AC2 양성대조가 실제 운영
모델(`app.models.activity_log`)을 "아직 `app/models/__init__.py`에 안 잡힌 모델"의 예시로
빌려 썼는데, 그 모델이 나중에(story #2255에서) 실제로 등재되면서 양성대조의 전제
("이 모듈은 app.models 벌크 import에 없다")가 깨져 `test_ac2_positive_control_missing_import_gets_diagnosed`가
거짓 GREEN(failed=0)으로 무너졌다.

이 파일은 그 함정을 구조적으로 없앤다 — 운영 모델을 빌려 쓰는 대신, **의도적으로 영원히
미등재 상태로 남는 테스트 전용 모델**을 만든다. `app/models/__init__.py`가 이 모듈을 절대
import하면 안 된다(그 순간 이 파일의 존재 이유가 사라진다) — `scripts/lint_model_registration_completeness.py`의
`_INTENTIONALLY_UNREGISTERED` 허용목록에 등재해 AC6 가드의 오탐 대상에서 제외했다.

`__tablename__`을 가진 채로 `app/models/` 안에 있어야 하는 이유: story #2662의 진단
레지스트리(`tests/conftest.py::_build_tablename_to_module_registry`)가 이 디렉터리를
AST로 정적 스캔해 테이블명→모듈 경로를 맵핑하기 때문 — `__init__.py` 등재 여부와 무관하게
파일이 여기 있기만 하면 레지스트리에 잡힌다(그래서 진단 문구에 이 모듈명이 뜬다).
"""
import uuid

from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class _Story2662Ac2UnregisteredFixture(Base):
    """운영 코드는 이 클래스를 절대 참조하지 않는다 — story #2662 AC2 양성대조 전용."""

    __tablename__ = "test_2662_ac2_positive_control"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
