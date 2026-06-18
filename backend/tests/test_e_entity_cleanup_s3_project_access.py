"""E-ENTITY-CLEANUP S3: project_access 테이블 신설 + migration 테스트.

AC1: project_access 테이블 생성 (project_id, org_member_id, permission, created_at)
AC2: Alembic migration 존재 (0044)
AC3: 기존 team_members(type=human) → project_access 데이터 변환 로직 포함
AC4: 기본 정책: 레코드 없음 = 접근 허용 (opt-out 모델)
AC5: org_member 삭제 시 project_access cascade 삭제 (FK 정의)
AC6: 롤백 migration(downgrade) 포함
"""
from __future__ import annotations

import os


# ─── AC1: 모델 필드 검증 ─────────────────────────────────────────────────────

def test_project_access_model_exists():
    """ProjectAccess 모델 존재."""
    from app.models.project_access import ProjectAccess
    assert ProjectAccess.__tablename__ == "project_access"


def test_project_access_model_fields():
    """ProjectAccess에 project_id, org_member_id, permission, created_at 필드 존재."""
    from app.models.project_access import ProjectAccess
    cols = {c.name for c in ProjectAccess.__table__.columns}
    assert "id" in cols
    assert "project_id" in cols
    assert "org_member_id" in cols
    assert "permission" in cols
    assert "created_at" in cols


def test_project_access_unique_constraint():
    """(project_id, org_member_id) unique constraint 존재."""
    from app.models.project_access import ProjectAccess
    constraint_names = {c.name for c in ProjectAccess.__table__.constraints}
    assert "uq_project_access_project_member" in constraint_names


# ─── AC2: migration 존재 ─────────────────────────────────────────────────────

def test_migration_0044_exists():
    """0044_add_project_access.py migration 파일 존재."""
    path = os.path.join(
        os.path.dirname(__file__), "..", "alembic", "versions", "0044_add_project_access.py"
    )
    assert os.path.exists(path)


def test_migration_0044_revision():
    """0044 migration revision=0044, down_revision=0043."""
    path = os.path.join(
        os.path.dirname(__file__), "..", "alembic", "versions", "0044_add_project_access.py"
    )
    with open(path) as f:
        content = f.read()
    assert 'revision = "0044"' in content
    assert 'down_revision = "0043"' in content


def test_migration_creates_project_access():
    """0044 migration 소스에 project_access 테이블 생성 존재."""
    path = os.path.join(
        os.path.dirname(__file__), "..", "alembic", "versions", "0044_add_project_access.py"
    )
    with open(path) as f:
        content = f.read()
    assert "project_access" in content
    assert "project_id" in content
    assert "org_member_id" in content
    assert "permission" in content


# ─── AC3: 데이터 변환 로직 ───────────────────────────────────────────────────

def test_migration_has_data_conversion():
    """0044 migration 소스에 team_members → project_access 데이터 변환 SQL 존재."""
    path = os.path.join(
        os.path.dirname(__file__), "..", "alembic", "versions", "0044_add_project_access.py"
    )
    with open(path) as f:
        content = f.read()
    assert "team_members" in content
    assert "INSERT INTO project_access" in content
    assert "type" in content and ("human" in content)


# ─── AC4: opt-out 모델 검증 ─────────────────────────────────────────────────

def test_model_docstring_documents_optout():
    """ProjectAccess 모델에 opt-out 정책 문서화."""
    from app.models.project_access import ProjectAccess
    import inspect
    source = inspect.getsource(ProjectAccess)
    assert "opt-out" in source or "레코드 없음" in source


def test_permission_default_is_granted():
    """permission 컬럼 기본값 'granted' (S-MBR-10: grant 모델 전환)."""
    from app.models.project_access import ProjectAccess
    perm_col = ProjectAccess.__table__.columns["permission"]
    default = str(perm_col.server_default.arg) if perm_col.server_default else None
    assert default == "granted"


# ─── AC5: cascade 삭제 (FK) ──────────────────────────────────────────────────

def test_project_access_org_member_fk_cascade():
    """org_member_id FK에 ON DELETE CASCADE 설정."""
    from app.models.project_access import ProjectAccess
    for fk in ProjectAccess.__table__.foreign_keys:
        if "org_members" in str(fk.target_fullname):
            assert fk.ondelete == "CASCADE", f"org_member FK ondelete={fk.ondelete}, expected CASCADE"
            return
    assert False, "org_members FK not found"


def test_project_access_project_fk_cascade():
    """project_id FK에 ON DELETE CASCADE 설정."""
    from app.models.project_access import ProjectAccess
    for fk in ProjectAccess.__table__.foreign_keys:
        if "projects" in str(fk.target_fullname):
            assert fk.ondelete == "CASCADE", f"project FK ondelete={fk.ondelete}, expected CASCADE"
            return
    assert False, "projects FK not found"


# ─── AC6: 롤백 migration ─────────────────────────────────────────────────────

def test_migration_has_downgrade():
    """0044 migration 소스에 downgrade 함수 + drop_table 존재."""
    path = os.path.join(
        os.path.dirname(__file__), "..", "alembic", "versions", "0044_add_project_access.py"
    )
    with open(path) as f:
        content = f.read()
    assert "def downgrade" in content
    assert "drop_table" in content


# ─── access 500 fix: ProjectAccessResponse org_member_id Optional (0075 에이전트 placement) ──

def test_response_accepts_null_org_member_id():
    """에이전트 direct placement 행(org_member_id NULL·0075 NOT NULL 해제)을
    ProjectAccessResponse 가 수용. org_member_id required 였을 때 GET /access 가 500이었다."""
    import uuid
    from datetime import datetime, timezone
    from unittest.mock import MagicMock

    from app.routers.project_access import ProjectAccessResponse

    r = MagicMock()
    r.id = uuid.uuid4()
    r.project_id = uuid.uuid4()
    r.org_member_id = None  # 에이전트는 org_member 없음
    r.member_id = uuid.uuid4()  # canonical 앵커로 식별
    r.permission = "granted"
    r.role = "member"  # S3: ProjectAccessResponse.role 노출 추가 — mock 에 명시(str)
    r.created_at = datetime.now(timezone.utc)

    v = ProjectAccessResponse.model_validate(r)
    assert v.org_member_id is None
    assert v.member_id is not None


def test_response_accepts_human_org_member_id():
    """휴먼 행(org_member_id set) 무회귀."""
    import uuid
    from datetime import datetime, timezone
    from unittest.mock import MagicMock

    from app.routers.project_access import ProjectAccessResponse

    r = MagicMock()
    r.id = uuid.uuid4()
    r.project_id = uuid.uuid4()
    r.org_member_id = uuid.uuid4()
    r.member_id = None
    r.permission = "granted"
    r.role = "member"  # S3: ProjectAccessResponse.role 노출 추가 — mock 에 명시(str)
    r.created_at = datetime.now(timezone.utc)

    v = ProjectAccessResponse.model_validate(r)
    assert v.org_member_id is not None
