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

## 미확인 소비자 (업데이트: 남은 ~38의 정체가 AC3 이전 선결 과제)

| 소비자 | 상태 | 비고 |
|---|---|---|
| `sprintable-internal-api-dev` | **상한 실측(40)·실사용은 미확인** | maxScale 10×(pool 3+1)=40(steady)/80(rollout). 별도 private repo(`sprintable-admin`) — application_name 태깅 없이는 이 40 중 실제 몇 개가 지금 떠 있는지 여전히 모른다. |
| 무태그 잔여 ~38 | **미확인** | internal-api 상한 40을 다 채워도 안 없어지는 나머지. 후보: internal-api 구 리비전(rollout 잔존)·migration/admin job·운영 psql·leaked idle connection. `max_idle_seconds`(이번 커밋에 추가) 대사로 "오래 붙잡힌" 것부터 우선순위화할 것. |
| migration/admin job | **미확인** | `backend/scripts/migrate.sh`(precheck 자식 프로세스)·Alembic NullPool 1개, 순차·단명으로 보고서는 추정. rollout과 배포 job이 겹치는 시간대 headroom 필요. |
| 운영 접속(psql 등) | **미확인** | PostgreSQL reserved connection 몫 포함. `usename`(이번 커밋에 추가)으로 앱 서비스 계정과 구분 가능해질 것. |
| L2 트리거 워커 advisory lock | **미확인** | `L2_TRIGGER_ENABLED`/`L2_TRIGGER_ADVISORY_LOCK` dev/prod 실값 — 켜져 있으면 pool 내부에서 최대 `maxScale-1`개가 상시 checkout(holder 1개 제외 standby도 반납 안 함, 과거 ee7794eb 조사). |

### internal-api 계측 스코프 확장 — 권고

`sprintable-admin`(internal-api)에 같은 `db_application_name()` 패턴을 심으면 가장 빠르게 78을 분해할
수 있지만, 이 스토리는 원래 backend 저장소 스코프였고 internal-api는 ⓐ별도 private repo ⓑdev Cloud Run
자동배포 없음(merge해도 반영 안 됨 — 수동 gcloud 필요, PO/infra lane)이라 이 PR 하나로 못 끝난다.

**권고**: 이번 커밋의 `usename`/`client_addr`/`max_idle_seconds` 확장으로 **internal-api 코드를 건드리지
않고** 먼저 얼마나 좁혀지는지 실측(다음 배포 후)한 뒤 — 그래도 안 좁혀지면 internal-api 태깅을 별건
스토리로 분리(스코프·소유자·수동배포 조율이 필요해 이 스토리 안에 우겨넣으면 "1인 1건" 원칙과도 충돌).
바로 우겨넣지 않는 근거는 이 판단이 원가에 안 잡힌 게 아니라 **조율 비용**이라서다 — 오르테가군 확인 요청.

## 알려진 drift (AC4에서 정리)

- `backend/tests/test_e_infra_s2_pool.py`의 `PROD_MAX_SCALE_ASSUMED = 10`·`PROD_MAX_CONNECTIONS = 100`·
  `DEV_MAX_CONNECTIONS = 25`·`DEV_MAX_SCALE = 1`은 전부 현재 develop 실값(prod maxScale 5·prod/dev
  max_connections 200·dev maxScale 8)과 다르다 — 과거 결정(ee7794eb 초기안·PgBouncer 폐기 시점)이
  이후 dev 429 대응(rev 01256-w9r)으로 갱신됐는데 테스트 상수가 안 따라갔다. false-safe 방향(더 빡빡한
  가정)이라 CI가 놓치는 위험은 없지만, 이 문서와 대사가 안 맞아 혼란을 준다.
- `cloudbuild.yaml`/`.github/workflows/cloud-build.yml`의 prod 주석(`max_connections=100` 가정)도 위와
  동일 사유로 낡았다.

## 다음 단계

1. ~~AC2 dev 배포 → `db-connection-stats`로 실측~~ **완료(2026-07-20)** — backend 태깅 확인, 무태그 78/100 확정.
2. usename/client_addr/max_idle_seconds 확장(이번 커밋) 배포 → 재실측으로 무태그 78 중 얼마나 좁혀지는지 확인.
3. 그래도 안 좁혀지면 internal-api 태깅을 별건 스토리로 분리할지 오르테가군 확인(위 "internal-api 계측
   스코프 확장 — 권고" 참고).
4. 실측 후 이 문서를 갱신하고 나서 AC3(단가 인하 vs 소비자 예산 계상 vs 풀러) 택일 — 과거 시도
   이력(`ee7794eb`)이 이미 "Cloud Run raw TCP 미지원으로 중앙 PgBouncer 불가"를 확정해 둔 상태라 그
   벽은 다시 부딪히지 않는다. 택일 전 오르테가군 확인.
5. AC4로 위 drift 정리(테스트 상수 + cloudbuild 주석).
