# Support Gateway

지원·활성화 에이전트 v1의 경계 서비스(story #3259, Blueprint v0.3 §5-1). 고객 org 데이터·fleet
자격과 물리 분리된 독립 Cloud Run 서비스.

## 불변식

- 이 디렉터리의 `app/`는 `backend/app`·`backend/ee`를 **import하지 않는다**(pyproject.toml에
  `sprintable-backend` 의존성 자체가 없음 — 의존성 그래프 레벨에서 fleet 자격 0을 강제).
- org 소속 판별은 항상 위임 토큰(`SUPPORT_GATEWAY_TOKEN_SECRET`으로 서명, backend가 발급) 클레임만
  신뢰한다. 별도 DB 조회로 재확인하지 않는다 — 그럴 DB(fleet 쪽) 자체가 이 서비스엔 없다.
- `moonklabs` org는 특례 없는 고객 #N. `app/` 소스에 그 org의 UUID 리터럴이나
  `org_id == <literal>` 분기가 있으면 `tests/test_no_org_special_case.py`가 CI에서 잡는다.

## 로컬 실행

```bash
cd support-gateway
uv sync --group dev
export SUPPORT_GATEWAY_DATABASE_URL=postgresql+asyncpg://support:support@localhost:5433/support
export SUPPORT_GATEWAY_TOKEN_SECRET=local-dev-secret-change-me
uv run alembic upgrade head
uv run uvicorn app.main:app --reload --port 8081
```

테스트(SQLite 인메모리, PG 불요):

```bash
uv run pytest
```

## 아직 없는 것 (다른 스토리 스코프)

- 위젯 FE(story #2), Interaction/Execution 오케스트레이션(story #3), 지식원(story #4),
  에스컬레이션(story #5) — 이 서비스는 그 위에 서는 **경계 API**만.
- `app/injection_defense.py::sanitize_customer_text`는 pass-through 스텁 — 실 방어 내용은
  story #6.
- 토큰 발급 측(`backend/app/routers/support_gateway_token.py`)은 이 스토리에서 최소 골격만
  추가(로그인 사용자 → 위임 토큰 1종 발급). 위젯 로그인 플로우 자체는 story #2 스코프.

## 프로비저닝(PO 레인)

이 스토리는 코드/설정/스키마까지 — 실 GCP 자원(전용 서비스 계정·전용 Cloud SQL 인스턴스·
Secret Manager 값·Cloud Run 서비스 최초 생성)은 PO가 gcloud로 만든다(팀 관례: 인프라 프로비저닝은
PO 레인). `cloudbuild.yaml`의 `deploy-support-gateway` 스텝은 그 자원들이 이미 존재한다는 전제로
빌드·배포만 한다 — 최초 1회는 PO가 이 스텝 실행 전에 자원을 만들어야 한다(substitution 변수
목록은 `cloudbuild.yaml` 해당 스텝 주석 참고).
