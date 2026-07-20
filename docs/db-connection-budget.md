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

## 미확인 소비자 (AC2 배포 후 `GET /api/v2/internal/cron/db-connection-stats`로 채울 것)

| 소비자 | 상태 | 비고 |
|---|---|---|
| `sprintable-internal-api-dev` | **미확인** | 같은 dev DB 공유(보고서 §확인). 엔진/pool/raw 구성 미상 — 별도 private repo(`sprintable-admin`), 이 스토리 스코프 밖. AC2 application_name 태깅을 internal-api에도 심어야 pg_stat_activity에서 분리된다(현재는 무태그 상태로 잡혀도 "backend가 아닌 나머지"로는 식별 가능). |
| migration/admin job | **미확인** | `backend/scripts/migrate.sh`(precheck 자식 프로세스)·Alembic NullPool 1개, 순차·단명으로 보고서는 추정. rollout과 배포 job이 겹치는 시간대 headroom 필요. |
| 운영 접속(psql 등) | **미확인** | PostgreSQL reserved connection 몫 포함. |
| L2 트리거 워커 advisory lock | **미확인** | `L2_TRIGGER_ENABLED`/`L2_TRIGGER_ADVISORY_LOCK` dev/prod 실값 — 켜져 있으면 pool 내부에서 최대 `maxScale-1`개가 상시 checkout(holder 1개 제외 standby도 반납 안 함, 과거 ee7794eb 조사). |

## 알려진 drift (AC4에서 정리)

- `backend/tests/test_e_infra_s2_pool.py`의 `PROD_MAX_SCALE_ASSUMED = 10`·`PROD_MAX_CONNECTIONS = 100`·
  `DEV_MAX_CONNECTIONS = 25`·`DEV_MAX_SCALE = 1`은 전부 현재 develop 실값(prod maxScale 5·prod/dev
  max_connections 200·dev maxScale 8)과 다르다 — 과거 결정(ee7794eb 초기안·PgBouncer 폐기 시점)이
  이후 dev 429 대응(rev 01256-w9r)으로 갱신됐는데 테스트 상수가 안 따라갔다. false-safe 방향(더 빡빡한
  가정)이라 CI가 놓치는 위험은 없지만, 이 문서와 대사가 안 맞아 혼란을 준다.
- `cloudbuild.yaml`/`.github/workflows/cloud-build.yml`의 prod 주석(`max_connections=100` 가정)도 위와
  동일 사유로 낡았다.

## 다음 단계

1. AC2(이 브랜치에 이미 구현) dev 배포 → `db-connection-stats`로 실측 → 위 "미확인" 표를 실수치로 채운다.
2. 실측 후 이 문서를 갱신하고 나서 AC3(단가 인하 vs 소비자 예산 계상 vs 풀러) 택일 — 과거 시도
   이력(`ee7794eb`)이 이미 "Cloud Run raw TCP 미지원으로 중앙 PgBouncer 불가"를 확정해 둔 상태라 그
   벽은 다시 부딪히지 않는다. 택일 전 오르테가군 확인.
3. AC4로 위 drift 정리(테스트 상수 + cloudbuild 주석).
