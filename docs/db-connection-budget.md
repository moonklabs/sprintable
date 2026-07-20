# DB 커넥션 예산표

SID `f2fe1c5e` / Sprintable #2040 AC1. 근거: `db-connection-rootcause-report-2026-07-20.md`(코드
근거·산식 전문) + 오르테가군 PO 실측(2026-07-20, gcloud + Cloud Monitoring). **AC2(application_name
태깅) 배포·실측 전까지는 이 표의 "미확인" 행은 추정이 아니라 말 그대로 미확인이다** — 계측 없이
채운 예산표는 추정표라는 것이 이 스토리의 전제.

## 산식

```
per_instance = (DB_POOL_SIZE + DB_MAX_OVERFLOW) + RAW_LISTEN
             = (3 + 1) + 1
             = 5

rollout_worst_case(env) = 2 × maxScale(env) × per_instance
```

`2×`는 배포 rollout 중 old+new 리비전이 동시에 떠 있는 구간(steady-state 산식만 쓰면 배포 중
한도 초과 — 2026-06-29 dev 인시던트가 이 blind spot에서 발생). L2 트리거 워커(`L2_TRIGGER_ENABLED`)가
켜져 있으면 인스턴스당 pool 내부(라인 4 안) connection 1개를 상시 점유하지만 `per_instance` 값 자체는
늘리지 않는다 — pool 슬롯을 나눠 쓸 뿐 추가 물리 연결이 아니다. dev/prod의 실제 flag 값은 아직
미확인(보고서 "확인하지 못한 것" #6).

## 환경별 예산 (2026-07-20 기준)

| | dev | prod |
|---|---:|---:|
| DB 인스턴스 | `sprintable-dev` (db-g1-small) | `sprintable-prod` (db-custom-2-8192) |
| `max_connections` (gcloud 실측, PO 2026-07-20) | **200**(100→200 상향, 오늘 사고 대응) | **200** |
| GHA SSOT `backend_max_instances` (`.github/workflows/cloud-build.yml`, 이 커밋 기준) | **8**(rev 01256-w9r durable) | **5**(ee7794eb ③) |
| backend rollout worst-case = `2×maxScale×5` | 80 | 50 |
| worst-case가 `max_connections`에서 차지하는 비율 | 40% | 25% |

dev/prod는 별도 Cloud SQL 인스턴스다 — 오르테가군 PO가 2026-07-20 gcloud로 직접 재확인(`sprintable-dev`
db-g1-small / `sprintable-prod` db-custom-2-8192, 별개 인스턴스 2개)했고, Cloud Monitoring `num_backends`도
`database_id`별 독립 시계열로 잡힌다(dev 피크 97 / prod 최대 17 — 같은 DB라면 같은 수치가 나왔을 것).
`.github/workflows/cloud-build.yml`의 dev 블록 주석이 "dev/prod 공유 DB라면 합산 점검 필요"라고 남겨둔
캐비어트는 이걸로 해소됐다.

**prod는 오늘 처음 실측됐다** — 저장소 주석(`cloudbuild.yaml:18`, `.github/workflows/cloud-build.yml:53`)은
`max_connections=100` 가정으로 산식이 쓰여 있어 지금 낡았다(AC4에서 갱신 대상).

**dev는 backend 단독이 아니다** — `sprintable-internal-api-dev`(maxScale 10·per_instance 4)가 같은 dev
DB를 쓴다. 이 둘을 합치면:

| | backend | internal-api-dev | 합계 | dev `max_connections`(200) 대비 |
|---|---:|---:|---:|---:|
| steady 상한 | 40 (8×5) | 40 (10×4) | 80 | **40%** |
| rollout worst-case | 80 (2×8×5) | 80 (2×10×4) | 160 | **80%** |

여유가 롤아웃 중 20%뿐이라는 게 숫자로 드러났다 — 다만 이건 두 서비스의 *상한*일 뿐, 위 AC2 라이브
실측(무태그 78 vs internal-api 상한 40)을 보면 **실사용은 상한보다 훨씬 작을 수도, 상한을 넘겨 다른
원인이 섞여 있을 수도 있다** — 상한표만으로 예산표를 닫으면 다시 추정표가 된다(§AC2 라이브 실측 참고).

## dev 관측 vs 산식 (Cloud Monitoring `num_backends`, 30분 최대·KST, PO 2026-07-20 실측)

| 시각 | 커넥션 | 비고 |
|---|---:|---|
| 07-19 17:36~08:36 | 15 | 유휴 바닥 — 트래픽 0에서도 15개 |
| 07-20 09:36 | 40 | |
| 07-20 10:36 | 86 | |
| 07-20 11:06 | 81 | |
| 07-20 13:36 | 79 | |
| 07-20 14:36 | 97 | 한도 100 — `TooManyConnectionsError` 발생 지점 |
| 07-20 15:06 | 97 | |
| 07-20 16:36 | 75 | |
| 07-20 17:06 | 63 | 당시 현재 |

prod(`sprintable-prod`) 같은 24시간: 최대 17 / 한도 200 — 전혀 압박 없음.

**괴리:** 단일 리비전(rollout 아닌 steady-state) 기준 backend 물리 상한은 `maxScale(8) × per_instance(5)
= 40`이다. 17:06 관측 63은 이 상한보다 **최소 23 많다** — backend 혼자만으로는 설명이 안 된다.
14:36 사고 지점 97도 rollout worst-case(80)를 넘는 값이라 같은 결론이다. 이 23(+)이 internal-api·
migration job·운영 psql·PostgreSQL reserved 중 어디서 오는지가 AC2 계측 없이는 분해되지 않는다 —
조사 보고서가 "이 저장소만으로는 알 수 없다"로 남긴 바로 그 자리다.

또한 **유휴 바닥 15**는 트래픽이 0인데도 물려 있는 상수항이다. backend는 idle 시 상시 점유가
`maxScale × raw(1)`뿐이라(pool은 idle 시 반납) 8이면 최대 8 — 15 전부를 backend로 설명할 수 없다.
이 상수도 AC2 계측 대상.

## AC2 라이브 실측 (2026-07-20, 오르테가군 PO — dev backend `01725-pfg`)

`db-connection-stats` 배포 직후 실호출 결과, dev DB 총 100개 connection의 구성:

| application_name | state | count |
|---|---|---:|
| (무태그) | idle | **78** |
| `sprintable-backend-dev:...-01725-pfg` | idle | 13 |
| `sprintable-backend-dev:...-01725-pfg:listen` | idle | 8 |
| `sprintable-backend-dev:...-01725-pfg` | active | 1 |

**AC2 세 가지 다 확인됨**: ①`server_settings` 태그가 `pg_stat_activity`에 실제로 붙음 ②pooled(13+1=14)와
`:listen`(8)이 분리 집계됨(`:listen`==8==살아있는 인스턴스 수와 정확히 일치) ③suffix가 잘리지 않고 그대로
노출됨(2026-07-20 truncate 회귀 수정이 실환경에서도 유효함을 실증).

**핵심 발견 — 아침 추정(23+)보다 훨씬 컸다**: backend 총합은 22(=13+8+1)로 maxScale 8 물리 상한 40보다
한참 낮다 — **backend는 예산 초과의 주범이 아니다.** 반면 **무태그가 78/100**이다. 오르테가군이 이어서
실측한 internal-api 후보:

```
sprintable-internal-api-dev : maxScale 10 · DB_POOL_SIZE 3 · DB_MAX_OVERFLOW 1
                             → per_instance 4 · steady 상한 40(rollout 80) · dev DB 확정
sprintable-internal-api(운영): maxScale 3 · prod DB 사용 — dev와 무관
```

internal-api-dev 상한(40)을 넣어도 `78 − 40 = 38`이 여전히 남는다. 전부 `state=idle`이라는 것이 단서 —
일하는 연결이 아니라 **붙잡고만 있는 연결**(오래된 internal-api 구 리비전 잔존·마이그/잡·운영 접속·진짜
누수 후보).

## 주인 없는 연결(zombie) — 확定 (2026-07-20 18:24, 오르테가군 PO)

**시도했다 실패한 축**: dev DB에 prod와 동일한 TCP keepalive 플래그(`tcp_keepalives_idle/interval/count`,
`requiresRestart: False` 확인 후 무중단 적용)를 넣어 "reload 후 무태그가 급감하는지"로 좀비 가설을
검증하려 했으나, 이 GUC들이 Postgres `PGC_BACKEND` context라 **reload는 신규 연결에만 적용되고 기존
연결에는 소급되지 않는다** — 실험 설계 자체가 틀렸다고 판단해 그 축은 접었다(적용 자체는 prod와 설정
정합을 맞춘 것이라 무해·유지). `client_addr`도 Cloud SQL이 Unix socket으로 연결돼 항상 빈 값이라
폐기했다 — **둘 다 실패를 여기 기록해 다음 사람이 같은 시도를 반복하지 않게 한다.**

**대신 결정적이었던 것 — `max_idle_seconds` 직접 관측 + 산술**:

```
TOTAL 119 (rollout 중 — old/new 리비전 동시 관측됨)
  69  idle   max_idle=7458s (2h04m)   ← 무태그
  20  idle   max_idle= 125s   backend 01725(구 리비전) pooled
  19  idle   max_idle=  21s   backend 01726(신 리비전) pooled
   5  idle   max_idle=2201s   backend 01725:listen   ← LISTEN은 상시 idle이 정상
   5  idle   max_idle= 246s   backend 01726:listen
   1  active                  backend 01726
```

**판정 근거 둘**: ①무태그 최대 idle **2시간 4분** — 정상 회전이면 나올 수 없는 값. ②산술이 더
결정적 — internal-api-dev 이론상 최대가 40(maxScale 10×4)인데 무태그가 **69**로 이미 그 상한을
넘는다. **살아 있는 소비자만으로는 설명 불가 → 주인 없는 연결 실재로 판정.**

**부수 수확**: 이 한 장의 스냅샷이 예산표 산식의 `2×maxScale×per_instance`(rollout 배수)가 탁상
가정이 아니라 실물임을 보여준다 — 구 리비전(01725)이 아직 25개(풀 20+listen 5), 신 리비전(01726)이
새로 25개를 잡은 상태가 그대로 찍혔다.

**⚠️ 아직 못 닫은 것**: 위 수치는 그룹별 "최대" 하나뿐이라 69개 중 몇 개가 진짜 오래됐는지 모른다(1개만
2시간이고 나머지 68개가 30초일 수도 있다 — "최대 하나로 전체 단정"은 오늘 반복된 함정). 이번 커밋이
`max_idle_seconds` 대신 **idle 구간별 개수 분포**(`>1h`/`10m-1h`/`1m-10m`/`<1m`)로 바꾼 이유가 이것 —
`>1h`가 무더기면 좀비 확定(근본=종료 시 연결 정리·shutdown drain), 대부분 `<1m`이면 정상 회전+예산
미계상(근본=예산·상한 조정)으로 처방이 완전히 갈린다.

## 미확인 소비자 (업데이트: 좀비 실재 확定 — 남은 것은 규모 확정)

| 소비자 | 상태 | 비고 |
|---|---|---|
| `sprintable-internal-api-dev` | **상한 실측(40)·실사용은 미확인** | maxScale 10×(pool 3+1)=40(steady)/80(rollout). 별도 private repo(`sprintable-admin`) — application_name 태깅 없이는 이 40 중 실제 몇 개가 지금 떠 있는지 여전히 모른다. |
| 무태그 중 좀비(주인 없는 연결) | **실재 확定·정확한 개수는 다음 배포(idle 구간 분포) 대기** | max_idle 2h04m + 산술(internal-api 상한 40 < 무태그 69)로 확定. 근본은 인스턴스 종료 시 연결 정리(shutdown drain) 부재로 추정 — 조사 보고서 §"남는 취약점"의 `fire_and_forget` 태스크 drain 갭과 같은 계열(연결 자체가 아니라 Task 문제였던 그 갭과는 별개 확인 필요). |
| migration/admin job | **미확인** | `backend/scripts/migrate.sh`(precheck 자식 프로세스)·Alembic NullPool 1개, 순차·단명으로 보고서는 추정. rollout과 배포 job이 겹치는 시간대 headroom 필요. |
| 운영 접속(psql 등) | **미확인** | PostgreSQL reserved connection 몫 포함. `usename`으로 앱 서비스 계정과 구분 가능. |
| L2 트리거 워커 advisory lock | **미확인** | `L2_TRIGGER_ENABLED`/`L2_TRIGGER_ADVISORY_LOCK` dev/prod 실값 — 켜져 있으면 pool 내부에서 최대 `maxScale-1`개가 상시 checkout(holder 1개 제외 standby도 반납 안 함, 과거 ee7794eb 조사). |

### internal-api 계측 스코프 확장 — 권고 (여전히 보류)

`sprintable-admin`(internal-api)에 같은 `db_application_name()` 패턴을 심으면 무태그를 더 분해할 수
있지만, 이 스토리는 원래 backend 저장소 스코프였고 internal-api는 ⓐ별도 private repo ⓑdev Cloud Run
자동배포 없음(merge해도 반영 안 됨 — 수동 gcloud 필요, PO/infra lane)이라 이 PR 하나로 못 끝난다.

**권고(오르테가군 확인·수용됨)**: 좀비가 실재로 확定된 지금은 근본 원인이 backend/internal-api 어느
쪽이든 "종료 시 연결 정리 부재"라는 코드 패턴 쪽일 가능성이 높아졌다 — internal-api 태깅으로 무태그를
더 쪼개는 것보다 **idle 구간 분포로 좀비 규모를 먼저 확정**하는 게 우선순위. 그래도 안 좁혀지면
internal-api 태깅을 별건 스토리로 분리(스코프·소유자·수동배포 조율이 필요해 이 스토리 안에 우겨넣으면
"1인 1건" 원칙과도 충돌) — 바로 우겨넣지 않는 근거는 원가가 아니라 **조율 비용**이라서다.

## 알려진 drift (AC4에서 정리)

- `backend/tests/test_e_infra_s2_pool.py`의 `PROD_MAX_SCALE_ASSUMED = 10`·`PROD_MAX_CONNECTIONS = 100`·
  `DEV_MAX_CONNECTIONS = 25`·`DEV_MAX_SCALE = 1`은 전부 현재 develop 실값(prod maxScale 5·prod/dev
  max_connections 200·dev maxScale 8)과 다르다 — 과거 결정(ee7794eb 초기안·PgBouncer 폐기 시점)이
  이후 dev 429 대응(rev 01256-w9r)으로 갱신됐는데 테스트 상수가 안 따라갔다. false-safe 방향(더 빡빡한
  가정)이라 CI가 놓치는 위험은 없지만, 이 문서와 대사가 안 맞아 혼란을 준다.
- `cloudbuild.yaml`/`.github/workflows/cloud-build.yml`의 prod 주석(`max_connections=100` 가정)도 위와
  동일 사유로 낡았다.

## AC5 — LISTEN raw 커넥션 재검토 (2026-07-20, 디디 은와추쿠)

오르테가군 지시대로 셋으로 나눠 본다. 결론(필요 개수·예산 반영)은 이 문서에 그대로 반영 —
"수명" 축에서 나온 코드 결함 가설은 **실 변경이 아니라 제안**이고, 착수는 오르테가군 확認 후.

### ① 필요 개수 — 인스턴스당 1개가 맞다(구조적 요구, 축소 여지 없음)

`pg_pubsub.py`는 Cloud Run 수평 확장 인스턴스 간 **cross-instance pub/sub**이다 — 인스턴스 A가
발행한 이벤트를, A에 연결 안 된(인스턴스 B에 SSE로 연결된) 클라이언트에게 전달하려면 **B도
자기 몫의 LISTEN을 갖고 있어야** NOTIFY를 받는다. 이 설계에서 "인스턴스당 1개"는 최소값이지
과잉이 아니다 — 줄이려면 LISTEN/NOTIFY 자체를 다른 전송 계층(예: Redis pub/sub, 중앙 relay
서비스)으로 통째로 교체해야 하는데, 이건 AC5 범위를 넘는 별건 아키텍처 결정이다(제안만 아래
남기고 착수 안 함).

부가 확인: `_resolve_listen_url()`/`check_listen_config()`가 이미 문서화하듯 이 연결은 DB_PGBOUNCER
on이어도 **direct Cloud SQL로 우회**한다(transaction-mode PgBouncer가 LISTEN/NOTIFY 미지원) — 즉
AC3에서 풀러(PgBouncer)를 도입해도 **이 항목은 그 풀링 효과를 전혀 못 받는다**. 예산표 산식의
`RAW_LISTEN` 항이 풀러 도입 시나리오에서도 그대로 살아남는다는 뜻 — AC3 검토 시 이 사실을 전제로
넣어야 한다(풀러가 예산을 줄이는 건 pool 항목뿐, LISTEN 항목은 무관).

### ② 수명 — 종료 시 정리가 코드상으로는 맞는데, SSE 스트림 드레인이 그 앞을 막을 수 있다

`main.py:36-66` lifespan shutdown은 `task.cancel() → await task(CancelledError 흡수) →
engine.dispose()` 순서고, `listen_loop()`의 `finally`가 `conn.remove_listener`+`conn.close()`를
확실히 호출한다 — **이 경로만 보면 결함이 없다.**

그런데 이 서비스는 `events.py`의 `StreamingResponse`(SSE, `text/event-stream`)로 **장수명
HTTP 스트림**을 서빙한다. `cloudbuild.yaml:157`/`--timeout=${_BACKEND_TIMEOUT}`가 dev에
**3600초**(`cloud-build.yml:80`)까지 허용한다 — 즉 SSE 클라이언트가 오래 붙어 있는 게 이
서비스의 정상 설계다. ASGI 서버(uvicorn)의 graceful shutdown은 통상 **in-flight 요청(SSE
스트림 포함)이 드레인된 뒤에** lifespan shutdown 훅을 실행한다 — SSE 클라이언트가 SIGTERM
시점에 안 끊겨 있으면, `task.cancel()`이 담긴 lifespan `finally` 자체가 실행될 기회를 못 얻고
Cloud Run의 SIGTERM→SIGKILL 유예시간(코드베이스 어디에도 이 유예시간 자체를 늘리는 설정은
없다 — `--timeout`은 요청 최대 길이지 SIGTERM 유예시간이 아니다)이 끝나면 프로세스가 강제
종료된다. 이 경우 `conn.close()`가 **한 번도 불리지 않고** DB 쪽 LISTEN 연결이 고아로 남는다.

**오르테가군 19:28 실측(구 리비전 01726의 :listen 3개가 67분째 살아있음)이 정확히 이 그림과
들어맞는다** — 죽은 리비전의 LISTEN이 살아있다는 건 "graceful shutdown이 시작은 됐지만 SSE
드레인에 막혀 pg_pubsub 정리 지점까지 못 갔다"는 시나리오와 가장 잘 맞는 코드상 원인이다
(TCP 레벨에서도, SIGKILL은 소켓을 정상 종료하지 않으므로 Postgres 서버가 죽은 피어를 keepalive로
자체 탐지하기 전까지는 `pg_stat_activity`에 남는다 — 이 문서 "시도했다 실패한 축"의 keepalive
튜닝이 신규 연결에만 적용되고 기존 연결엔 소급 안 된다는 관찰과도 정합).

**제안(미착수 — 실 변경은 오르테가군 확認 후)**: SIGTERM 수신 즉시(uvicorn의 요청 드레인
완료를 기다리지 않고) `signal.signal(SIGTERM, ...)` 핸들러로 pg_pubsub raw 커넥션을 먼저
닫는 것 — lifespan `finally`가 요청 드레인 뒤에야 도는 순서 자체를 바꾸지 않고, LISTEN
정리만 그 순서에서 독립시킨다(L2 워커·engine.dispose는 기존 lifespan 경로 그대로 유지 —
스코프 최소화). 검증 없이 이 가설 하나로 코드를 바꾸는 건 이 스토리가 오늘 하루 경계한
바로 그 패턴이라(계측 없는 손잡이질) — 오르테가군이 다음 배포에서 SIGTERM 시점과 zombie
발생 시점을 대조해 이 가설을 먼저 검증하는 걸 권한다.

### ③ 예산 반영

`RAW_LISTEN=1`(steady-state, ①의 결론)은 그대로 유지한다 — 줄일 근거도 늘릴 근거도 없다.
다만 좀비(②)는 이 상수항 산식(`per_instance = pool + 1`)으로 흡수되지 않는 **별도 변수**다 —
정상 롤아웃도 `2×`로 이미 반영돼 있지만, 오늘 실측된 "리비전 5개까지 겹침"은 그 `2×` 가정보다
크다. `RAW_LISTEN`이 좀비로 인해 인스턴스당 1이 아니라 **드레인 안 된 구 리비전 수만큼 누적**될
수 있다는 것을 예산표 산식에 정성적으로 명시해둔다 — ②가 검증·수정되기 전까지는 정량화하지
않는다(추정표 금지 원칙 재적용).

## 다음 단계

1. ~~AC2 dev 배포 → `db-connection-stats`로 실측~~ **완료(2026-07-20)** — backend 태깅 확인, 무태그 78/100 확정.
2. ~~usename/client_addr/max_idle_seconds 확장 배포 → 재실측~~ **완료(2026-07-20 18:24)** — 좀비(주인
   없는 연결) 실재 확定(max_idle 2h04m + 산술). `client_addr`는 실패 축으로 폐기.
3. idle 구간 분포(`>1h`/`10m-1h`/`1m-10m`/`<1m`, 이번 커밋) 배포 → 재실측으로 좀비 **규모**(69개 중
   몇 개가 `>1h`인지) 확정 — 처방이 예산 계상 vs 근본수정(shutdown drain)으로 갈리는 분기점.
4. internal-api 태깅 확장은 위 3번 결과를 보고 오르테가군과 재논의(현재는 보류 유지).
5. 실측 후 이 문서를 갱신하고 나서 AC3(단가 인하 vs 소비자 예산 계상 vs 풀러 vs shutdown drain 근본수정)
   택일 — 과거 시도 이력(`ee7794eb`)이 이미 "Cloud Run raw TCP 미지원으로 중앙 PgBouncer 불가"를
   확정해 둔 상태라 그 벽은 다시 부딪히지 않는다. 택일 전 오르테가군 확인.
6. AC4로 위 drift 정리(테스트 상수 + cloudbuild 주석).

## story #2060 — 좀비 :listen 근본수정 검증 결과(2026-07-20, 통과)

②(수명)에서 미착수로 남겨뒀던 제안(SIGTERM 즉시 pg_pubsub 우선 종료 — uvicorn
`--timeout-graceful-shutdown 5`)이 실제로 배포돼(PR #2330) 오르테가군 PO가 연속 실측으로 검증을
마쳤다. **판정 기준**(사전 선언, keepalive 축 실패를 반복하지 않기 위한 안전판): "fix 보유
리비전이 죽은 뒤 수 분 내 `:listen`이 사라지면 통과 · 여전히 수십 분 남으면 재조사."

| 시각 | TOTAL | 연결 보유 리비전 수 | 구 리비전 `:listen` 잔재 |
|---|---:|---:|---|
| 07-20 23:41(기준선, fix 이전) | 155 | 5개 | 3개(max 66분) |
| 07-21 01:22(fix 배포 직후) | 80 | 3개 | 1개(01745, `>1h`) — 판정 보류(fix 이전 리비전인지 미확정) |
| 07-21 08:19(fix 확실히 적용된 리비전으로 3회 배포 순환 후) | 40 | **1개(현행 01749뿐)** | **0개** |

08:19 시점까지 Cloud Build 성공 배포가 3회(`f2717ac2`→`b0e37dd9`→`d1f0af69`) 있었다 — 즉
**리비전이 여러 번 교체됐는데 죽은 쪽이 연결을 하나도 안 남겼다.** 판정 근거는 TOTAL 하락이
아니라(부하 감소로도 설명 가능한 지표 — 실제로 07-20 새벽 01:22 저부하 시간대에도 구 리비전이
남아있었다) **"구 리비전 잔재 0"**(트래픽과 무관한 지표)이다. 현행 리비전의 `:listen` 8개가
`max_idle >1h`(6.5시간)인 것은 결함이 아니다 — LISTEN은 살아있는 리비전에서 상시 유휴가 정상.

**⇒ AC3 통과 확定.** ①(필요 개수, 인스턴스당 1)·②(수명, SIGTERM 즉시 정리)·③(예산 반영) 전부
닫힘. `RAW_LISTEN`이 "배포 횟수에 비례해 누적"되던 축은 이 fix로 제거됐다 — 예산 산식은
`per_instance = pool + 1`(steady-state, 좀비 보정 불요)로 되돌아간다:

```
per_instance = (DB_POOL_SIZE 3 + DB_MAX_OVERFLOW 1) + RAW_LISTEN 1 = 5   (변경 없음)
rollout_worst_case(env) = 2 × maxScale(env) × 5                          (좀비 보정항 제거)
```

AC2(SSE 평시 수명 상한 추가 조정)는 "이 timeout이 종료 시점 상한을 이미 강제해 재연결 폭증
대가를 감수할 근거가 없다"는 판단으로 조치 없음(오르테가군 확인) — story #2060 done.
