"""story #2777 — admin billing mutation 라우터의 prod 하드가드 단위 테스트(DB 불요)."""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.core.config import settings
from app.routers import admin_billing


@pytest.fixture(autouse=True)
def _reset_deploy_env():
    orig = settings.deploy_env
    yield
    settings.deploy_env = orig


def test_reject_prod_raises_403_when_deploy_env_prod():
    settings.deploy_env = "prod"
    with pytest.raises(HTTPException) as exc_info:
        admin_billing._reject_prod()
    assert exc_info.value.status_code == 403


def test_reject_prod_noop_when_deploy_env_dev():
    settings.deploy_env = "dev"
    admin_billing._reject_prod()  # 예외 없이 통과


def test_reject_prod_noop_when_deploy_env_develop():
    settings.deploy_env = "develop"
    admin_billing._reject_prod()  # prod가 아닌 값은 전부 통과(dev/develop 자율 범위, PO 지시)
