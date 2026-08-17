"""story #2295 — 「응답하는가」(/ping)와 「일할 수 있는가」를 가르는 readiness 신호.

2026-07-28 인시던트(민 실증, dev): `realtime-gateway` GCE 인스턴스 재부팅 후
`cloud-sql-proxy`가 스테일 소켓(`bind: address already in use`)으로 크래시루프 —
그런데 GCLB 헬스체크(`/ping`, DB 미조회)는 계속 HEALTHY를 줬다. 「프로세스가 응답한다」와
「DB에 붙어 일할 수 있다」는 다른 질문인데 하나로 재고 있었다.

⛔안 하는 것(스토리 본문 명시) — 이 모듈은 **DB를 직접 조회하지 않는다**. 헬스체크마다
`SELECT 1`을 날리면 그 자체가 DB 부하고, DB가 잠깐 흔들리면 멀쩡한 인스턴스까지 전부
UNHEALTHY로 떨어뜨려 부분장애를 전면장애로 증폭시킨다.

하는 것 — 아래 두 신호원이 **이미** 자기 목적으로 갖고 있던 연결 성공/실패 상태를 이
모듈이 기록만 해두고(모듈 레벨 변수, DB 왕복 0), 아무 때나 그 「캐시된 사실」을 읽어 답한다.

신호원(OR 집합 — 어느 쪽이든 최근 성공이면 healthy, 둘 다 유예시간 넘겨 실패 상태면
unhealthy):
① `app.services.pg_pubsub.listen_loop()` — backplane=pg일 때만 뜬다(재연결 목적으로
   이미 갖고 있던 상태).
② `app.dependencies.auth._resolve_api_key()` — story #2295 갭 후속(2026-08-17, PO 판정).
   ①이 backplane=redis(현재 dev/prod 실값)에서 아예 안 떠 영구 fail-open이던 갭을
   그라운딩(원 인시던트 재조사: 「신규 연결만 거부·기존 스트림 유지」 실증상과 대조)해
   찾은 실제 소비처 — 신규 SSE 연결마다 agent API키 인증이 DB 왕복을 한다(JWT 경로는
   DB 불요라 무관). DB 연결 자체의 실패(예외)만 신호로 잡는다 — 틀린 키(정상 401)는
   readiness와 무관(같이 잡으면 「틀린 키 = 인프라 UNHEALTHY」라는 오판정이 된다).

⚠️못 잡는 것(PO 명시, AC) — 이 신호는 **트래픽 의존**이다. 신규 SSE 연결 시도(agent API키
경로)가 0인 구간엔 cloud-sql-proxy가 죽어도 ②가 안 나서 `/ready`가 마지막 캐시 상태(또는
기동 후 첫 시도 前 fail-open 「not_yet_connected」)에 그대로 머문다 — 무트래픽 구간의
감지 지연. 원 인시던트류(크래시루프)는 fleet 전체의 재연결 폭주가 신호를 계속 만들어
실용상 잘 잡히지만, 이론상 무트래픽 구간은 이 처방의 사각지대다. 능동 프로브(예: 60s급
백그라운드 1회 SELECT)는 이번 스코프 밖 — 실 신호(무트래픽 구간에서 놓친 사례)가 나오면
후속 스토리로.
"""
from __future__ import annotations

from datetime import UTC, datetime

# AC4(카디르 제안, 근거): listen_loop()의 재연결 backoff는 1s→2s→4s→8s→16s→30s(cap)로
# 자란다. 유예시간을 그 backoff 자체의 수렴값(30s)으로 맞추면 — 연결이 끊긴 순간부터
# 최소 5회(1+2+4+8+16=31s)의 재연결 시도가 그 안에 들어간다 — 「한 번 실패했다고 바로
# UNHEALTHY」가 아니라 「backoff가 스스로 회복할 기회를 다 쓰고도 여전히 안 되면」이라는
# 뜻이 된다. 임의 숫자가 아니라 기존 재시도 스케줄 자체를 유예 기준으로 재사용한 것 — 새
# 임계값 체계를 따로 발명하지 않는다.
UNHEALTHY_GRACE_SECONDS = 30.0

_connected: bool = False
_disconnected_since: datetime | None = None
_last_error: str | None = None


def mark_connected() -> None:
    """listen_loop()이 연결(재)성공 시 호출."""
    global _connected, _disconnected_since, _last_error
    _connected = True
    _disconnected_since = None
    _last_error = None


def mark_disconnected(error: str) -> None:
    """listen_loop()이 연결 실패/끊김을 감지했을 때 호출 — 최초 실패 시점만 기록."""
    global _connected, _disconnected_since, _last_error
    was_connected = _connected
    _connected = False
    _last_error = error
    if was_connected or _disconnected_since is None:
        _disconnected_since = datetime.now(UTC)


def is_ready() -> tuple[bool, dict]:
    """readiness 판정 — DB/네트워크 왕복 0, 모듈 상태 읽기만.

    연결이 살아있으면 즉시 ready. 끊겼어도 `UNHEALTHY_GRACE_SECONDS` 유예 안이면
    (listen_loop()의 backoff가 아직 재시도 중일 수 있으므로) 아직 ready로 본다 — 이래야
    반짝 끊김 한 번에 LB가 인스턴스를 바로 빼는 flapping을 피한다(스토리 AC4 요구).
    """
    if _connected:
        return True, {"pg_listen": "connected"}

    if _disconnected_since is None:
        # listen_loop()이 아직 첫 연결을 시도한 적 없음(기동 직후) — fail-open으로
        # 시작 직후 헬스체크가 즉시 실패하는 것을 막는다(정상 기동 유예).
        return True, {"pg_listen": "not_yet_connected"}

    elapsed = (datetime.now(UTC) - _disconnected_since).total_seconds()
    if elapsed <= UNHEALTHY_GRACE_SECONDS:
        return True, {
            "pg_listen": "reconnecting",
            "disconnected_for_seconds": round(elapsed, 1),
            "last_error": _last_error,
        }

    return False, {
        "pg_listen": "disconnected",
        "disconnected_for_seconds": round(elapsed, 1),
        "last_error": _last_error,
    }
