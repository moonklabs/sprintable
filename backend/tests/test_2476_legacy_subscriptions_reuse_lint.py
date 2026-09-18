"""story #2476(결제②-A1후속 재그라운딩) — lint_legacy_subscriptions_reuse.py의 정탐/오탐 회귀
가드. 합성 fixture로 짓는다(실물이 고쳐져도 이 테스트는 안 사라진다, story #2335/#2342 lint와
동형)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from lint_legacy_subscriptions_reuse import find_violations, scan  # noqa: E402


def _write(tmp_path: Path, name: str, source: str) -> Path:
    p = tmp_path / name
    p.write_text(source)
    return p


def test_detects_tablename_reintroduction(tmp_path):
    src = '''
class Subscription(Base):
    __tablename__ = "subscriptions"
'''
    path = _write(tmp_path, "bad_model.py", src)
    assert len(find_violations(path)) == 1


def test_detects_checkout_sessions_tablename(tmp_path):
    src = '''
class SubscriptionCheckoutSession(Base):
    __tablename__ = "subscription_checkout_sessions"
'''
    path = _write(tmp_path, "bad_checkout_model.py", src)
    assert len(find_violations(path)) == 1


def test_detects_raw_sql_from_clause(tmp_path):
    src = '''
async def legacy_lookup(session):
    return await session.execute(text("SELECT * FROM subscriptions WHERE org_id = :org_id"))
'''
    path = _write(tmp_path, "bad_raw_sql.py", src)
    assert len(find_violations(path)) == 1


def test_detects_table_reflection(tmp_path):
    src = '''
legacy = sa.Table("subscriptions", metadata, autoload_with=engine)
'''
    path = _write(tmp_path, "bad_reflection.py", src)
    assert len(find_violations(path)) == 1


def test_org_subscriptions_canonical_not_flagged(tmp_path):
    """정본 org_subscriptions는 legacy 테이블명과 다른 문자열이라 안 걸려야 한다."""
    src = '''
class OrgSubscription(Base):
    __tablename__ = "org_subscriptions"

async def get_org_subscription(session, org_id):
    return await session.execute(text("SELECT * FROM org_subscriptions WHERE org_id = :org_id"))
'''
    path = _write(tmp_path, "good_canonical.py", src)
    assert find_violations(path) == []


def test_prose_mention_in_docstring_not_flagged(tmp_path):
    """死선언 주석 자체(이 스토리가 새로 추가한 것과 동형)는 SQL 절/__tablename__ 패턴이 아니라
    안 걸려야 한다 — 걸리면 이 lint가 자기 자신의 문서화 커밋을 매번 빨갛게 만드는 셈이라
    오탐 방지 실패."""
    src = '''
class OrgSubscription(Base):
    """OSS 유일 정본. legacy subscriptions·subscription_checkout_sessions는 SaaS 전용 라이브라
    OSS에서 안 쓴다 — docs/pk-triage-orm-unmodeled.md 참고."""

    __tablename__ = "org_subscriptions"
'''
    path = _write(tmp_path, "good_docstring.py", src)
    assert find_violations(path) == []


def test_mutation_disabling_patterns_causes_zero_detections():
    """뮤테이션: 패턴 리스트를 비우면 위 양성 테스트가 깨져야 한다 — 이 lint의 핵심 로직이
    실제로 테스트에 의해 지켜지는지 자가 검증(story #2342 lint와 동일 관례)."""
    import lint_legacy_subscriptions_reuse as mod

    original = mod._PATTERNS
    try:
        mod._PATTERNS = []
        src = 'class Subscription(Base):\n    __tablename__ = "subscriptions"\n'
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "bad.py"
            path.write_text(src)
            violations = find_violations(path)
        assert violations == [], "뮤테이션 후에는 탐지가 0이어야 정상(로직이 실제로 패턴에 의존함을 증명)"
    finally:
        mod._PATTERNS = original


def test_current_repo_has_zero_violations():
    """실물 backend/app/ 전수 스캔 — 재그라운딩 시점(2026-09-01) 확認한 참조 0건이 유지되는지
    CI가 도는 그 검사 자체를 pytest로도 한 번 더 고정한다."""
    backend_root = Path(__file__).parent.parent
    assert scan(backend_root) == []
