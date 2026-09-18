from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.database import get_db
from app.services import realtime_readiness

router = APIRouter(prefix="/api/v2", tags=["health"])


@router.get("/ping")
async def ping():
    """인증 불필요 생존 확인 — CLI npx sprintable connect 호환."""
    return {"ok": True}


@router.get("/health")
async def health_check(response: Response, db: AsyncSession = Depends(get_db)):
    """AC2: GET /api/v2/health — DB 연결 포함 헬스체크 (AC3).

    story #2295 별개 fix(2026-08-17, 카디르 QA 적발) — 이 엔드포인트가 원래 DB 조회
    실패를 `db` 필드에만 담고 top-level `status`·HTTP status code는 항상 "ok"/200으로
    고정 반환했다(호출자가 status만 보면 DB 장애를 절대 못 봄 — 이 스토리 자체가 고치려는
    "HEALTHY≠일할 수 있음" 병을 이 엔드포인트 자신이 앓고 있었다). `db` 필드 체크(예:
    setup_dns.sh)는 이미 문자열 매칭이라 무영향, `check_http ... 200` 기대 스크립트는
    DB가 정상일 때만 여전히 200 — DB가 실제로 죽었을 때만 그 스크립트가 이제 정확히
    실패를 본다(이게 이 fix의 목적).
    """
    db_status = "ok"
    try:
        await db.execute(text("SELECT 1"))
    except Exception as exc:
        db_status = f"error: {type(exc).__name__}"

    # story #3418(AC2) — rate_limit_backend를 이 사람이 보는 표면에 노출한다. 앱은 인스턴스가
    # 몇 개인지 모르므로 이 값만으로 "여러 인스턴스+memory"를 스스로 판정할 수는 없다(그건
    # startup 경고, `warn_if_rate_limit_backend_is_memory()`의 몫) — 여기서는 있는 그대로의
    # 설정값을 실어 사람이 인스턴스 수와 대조할 수 있게만 한다.
    if db_status != "ok":
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "error", "version": "v2", "db": db_status, "rate_limit_backend": settings.rate_limit_backend}

    return {"status": "ok", "version": "v2", "db": db_status, "rate_limit_backend": settings.rate_limit_backend}


@router.get("/ready")
async def readiness_check(response: Response):
    """story #2295 — 「응답하는가」(/ping)와 「일할 수 있는가」를 가른다.

    이 엔드포인트는 **DB를 조회하지 않는다**(AC3, 체크당 쿼리 0) — `/health`처럼 매 체크마다
    `SELECT 1`을 날리면 그 자체가 DB 부하이고, DB가 잠깐 흔들리면 멀쩡한 인스턴스까지 전부
    UNHEALTHY로 떨어뜨려 부분장애를 전면장애로 증폭시킨다(스토리 본문이 명시적으로 "안 하는
    것"으로 선언한 그 함정). 대신 `pg_pubsub.listen_loop()`가 **이미** 갖고 있는 연결
    성공/실패 상태기계(자기 재연결 목적으로 원래도 추적하던 사실)를 그대로 읽어 응답한다 —
    「캐시된 사실을 답한다」(스토리 본문 "하는 것 ②").

    realtime-gateway(GCE MIG, `provision_realtime_gclb.sh`)에서 GCLB healthcheck target을
    이 엔드포인트로 돌린다 — cloud-sql-proxy가 죽어 `listen_loop()`의 재연결이 계속
    실패하면(AC4 임계값 이상) 이 응답이 UNHEALTHY로 바뀌어 LB가 그 인스턴스를 빼게 된다
    (원 인시던트 2026-07-28: 죽은 proxy가 `/ping`으로는 절대 안 보였던 그 자리).
    """
    healthy, detail = realtime_readiness.is_ready()
    if not healthy:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return {"ready": healthy, **detail}
