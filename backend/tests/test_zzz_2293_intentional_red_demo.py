"""story #2293 AC4 실증용 — 일부러 실패하는 destructive_schema 테스트.
⛔이 파일은 CI 레드 증거를 남긴 뒤 즉시 삭제한다(영구 파일 아님)."""
import pytest


@pytest.mark.destructive_schema
def test_intentional_failure_for_2293_ac4_demo():
    assert False, "story #2293 AC4 — 일부러 심은 실패, 곧 원복함"
