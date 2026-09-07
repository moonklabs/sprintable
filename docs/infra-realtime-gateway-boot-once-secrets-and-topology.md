# realtime-gateway(GCE MIG) — 부팅 1회형 시크릿 소비자·이중 구조 판정

story #3616(2026-09-07, 라이브 결함) 후속 문서. 배경: `DATABASE_URL_DEV` 로테이션
(2026-09-06T14:27:40Z, v17) 뒤 GCE MIG `sprintable-realtime-gateway-dev`가 15시간
동안 옛 비밀번호를 컨테이너 env에 굳힌 채 503을 냈다(부팅 때 시크릿을 1회만 읽고
디스크에 기록하지 않는 설계 — `backend/scripts/deploy_realtime_gce.sh` — 라 로테이션
사본 목록·감시 대상에서 이 소비자가 빠져 있었다). 원인·처방 코드는 PR 본문 참고
(`backend/scripts/deploy_realtime_gce.sh`의 잔존 소켓 정리, `app/services/
realtime_readiness.py::run_active_probe_loop`).

## AC3 — 「부팅 1회형」 시크릿 소비자 목록(로테이션 런북 체크리스트)

시크릿을 **부팅 시점에 1회만 읽고 디스크/env에 그대로 굳히는** 소비자는 일반적인
"시크릿 갱신 → 다음 배포가 자동으로 새 값을 받는다" 가정이 깨진다. 로테이션 PR/절차는
아래 목록을 체크리스트로 삼아, 로테이션 대상 시크릿을 쓰는 소비자가 이 표에 있으면
**그 소비자의 재부팅/재배포를 로테이션과 같은 변경 세트에 명시적으로 포함**해야 한다.

| 소비자 | 시크릿 소비 방식 | 로테이션 후 필요한 조치 |
|---|---|---|
| GCE MIG `sprintable-realtime-gateway-dev`/`-prod` | startup-script가 `gcloud secrets versions access latest`를 **부팅 때 1회**만 호출해 컨테이너 `-e` 인자로 굳힘(`deploy_realtime_gce.sh`) — 디스크 미기록(보안 설계 그대로 유지, 바꾸지 않음) | `gcloud compute instance-groups managed rolling-action replace <MIG> --project=<proj> --zone=<zone>`(지역 MIG는 `--region`+`--max-unavailable=<zone 수 이상>`) — **`restart`가 아니라 `replace`**를 써야 새 시크릿을 읽는다(restart는 같은 디스크·같은 env로 컨테이너만 재기동, 값이 안 바뀜). `deploy_realtime_gce.sh`를 develop HEAD로 재실행해도 동일 효과(cloudbuild.yaml의 `deploy-realtime-gce` 스텝이 develop 푸시마다 이미 자동 수행 — 로테이션이 코드 변경과 별도로 일어난 창에서만 수동 개입 필요). |

체크리스트 항목(로테이션 실행 PR/절차에 추가할 것):
1. 로테이션 대상 시크릿 이름을 위 표의 "시크릿 소비 방식" 열과 대조 — 겹치면 해당 소비자를
   같은 변경 세트에 포함.
2. GCE MIG가 겹치면 로테이션 직후(같은 절차 안에서) `rolling-action replace` 실행 —
   **사후 대응이 아니라 로테이션 자체의 마지막 스텝**으로 취급한다(이번 인시던트는 이
   스텝이 절차에 아예 없어 15시간 방치됐다).
3. `replace` 뒤 각 VM의 `/api/v2/health`(DB 포함)가 `db: ok`인지 확認 — `/api/v2/ready`
   만으로는 부족하다(트래픽 의존·능동 프로브 주기 지연 가능, 아래 판정 참고).

이 목록은 "새로 발견되는 대로 추가"하는 살아있는 문서다 — Cloud Run 서비스(backend-dev/
realtime-dev 등)는 `--update-secrets`로 재배포마다 최신 값을 받아 이 클래스에 안 걸린다
(GCE MIG처럼 "값을 굳히는" 축이 없음).

## AC1/AC2 코드 처방 요약(실물은 코드 참고)

- **시작 스크립트 멱등화**: `docker rm -f cloud-sql-proxy` 뒤 `rm -rf
  "${_HOST_SOCKET_DIR}/${SQL_INSTANCE_CONN}"`를 추가 — `/mnt/stateful_partition`은
  stateful(재부팅에도 보존)이라 이전 부팅의 소켓 파일이 남아 새 프록시가
  "address already in use"로 죽던 것을 막는다. 이제 `restart`(재부팅)만으로도
  `replace`(디스크 재생성)와 동등하게 복구된다.
- **LB 헬스체크가 DB까지 보게**: `/api/v2/ready`에 새 신호원 ③(`run_active_probe_loop`,
  `realtime_readiness.py`)을 추가 — 60초 주기 백그라운드 `SELECT 1` 1커넥션(헬스체크
  호출 빈도와 무관한 고정 비용, 기존 `/health`가 겪은 "체크마다 DB 부하" 문제를
  재도입하지 않음). backplane=redis(dev/prod 실값)·무트래픽 구간에서 기존 신호원
  (①pg_pubsub 재연결·②agent API키 인증)이 둘 다 못 내던 신호를 이 능동 프로브가
  대신 낸다 — 이번 인시던트가 정확히 그 사각지대였다(story #2295 원문이 "실 신호가
  나오면 후속 스토리로" 미뤄뒀던 그 자리).

## AC4 — Cloud Run `sprintable-realtime-dev` vs GCE MIG 게이트웨이 이중 구조 판정

**둘 다 `/api/v2/events/stream`을 마운트하지만 실제로는 서로 다른 역할이다(단순 중복
아님) — cloudbuild.yaml의 `realtime_url` output(:326~354 이력 주석) 실물 대조 결과:**

- **GCE MIG `sprintable-realtime-gateway-dev`(GCLB 뒤, `dev-realtime.sprintable.ai`)**
  = **정본(primary)**. story #2185(2026-07-27)가 FE `REALTIME_URL`을 이 스택으로
  durable 전환했다 — 실 브라우저 SSE 트래픽이 여기로 붙는다(GCLB 로그 실측: `/api/v2/
  events/stream` 다건, 콜드스타트 없는 상시 2~3노드).
- **Cloud Run `sprintable-realtime-dev`** = FE가 더는 직접 안 붙지만(REALTIME_URL이
  GCE를 가리킨 뒤로 신규 연결 0에 가까움) **폐기되지 않았다** — story #3198(2026-08-28)
  이 이 서비스를 Redis backplane의 **consume+dispatch 노드**로 계속 쓴다(`backend_
  redis_consume_enabled=true`·`dispatch_enabled=true`, cloudbuild.yaml). backend-dev
  (API 쓰기 경로)가 Redis 채널에 발행한 이벤트를 GCE MIG 인스턴스들이 구독해 실제
  SSE로 내보내는데, 그 크로스인스턴스 팬아웃 배관의 소비측이 바로 이 Cloud Run
  서비스다 — **같은 `/api/v2/events/stream` 라우트를 갖고 있어도 실질 소비처가 다르다**
  (Cloud Run=Redis 구독·팬아웃 백플레인 / GCE=사람이 붙는 프런트 게이트웨이).

**판정: 하나로 수렴 불가 — 별도 스토리 제안 안 함.** 두 서비스가 "같은 라우트를
제공"하는 것처럼 보이지만 실제로는 **레이어가 다르다**(하나는 팬아웃 백플레인,
하나는 엣지 게이트웨이) — 이건 이중 구조가 아니라 **의도된 2계층 구조**다. `event_
broker.py::resolve_backplane()`이 redis일 때 이 2계층이 정확히 필요(Cloud Run이
없으면 Redis pub/sub을 구독해 GCE 인스턴스들에 팬아웃할 주체가 없어진다). 굳이 하나로
합친다면 GCE MIG 컨테이너 안에 Redis consume+dispatch 로직을 흡수시켜야 하는데,
그러면 (a) 상시 3대 각각이 독립적으로 같은 Redis 채널을 구독·중복 배달 방지 로직을
새로 설계해야 하고 (b) `realtime_main.py`가 이미 이 로직을 갖고 있어(`redis_consume_
loop`) 재사용이 아니라 재작성이 된다 — 이번 스토리(AC4 "판정과 제안까지")의 스코프를
넘는 별도 아키텍처 변경. 현재 2계층 유지를 권고.

## AC5 — 알림(제안, 실행은 PO 확인 후)

이번 인시던트에서 "관측 구멍"으로 지목된 것: `/api/event-stream`(FE BFF) 5xx 루프가
10분 60~90회씩 발생했는데 사람이 보는 알림이 0이었다(선생님이 직접 신고해서야 발견).
아래는 Cloud Monitoring 알림 정책 제안이다 — **실행(정책 생성)은 PO 확인 후 진행**
(인프라 조치 lane 규율).

```bash
# 제안 — dev-realtime GCLB 백엔드 헬스 실패율 알림(실행 전 PO 확인)
gcloud alpha monitoring policies create \
  --project=sprintable-494803 \
  --display-name="dev-realtime GCLB backend UNHEALTHY" \
  --condition-display-name="realtime-gateway-dev-backend health check failing" \
  --condition-filter='resource.type="https_lb_rule" AND resource.labels.backend_target_name="realtime-gateway-dev-backend" AND metric.type="loadbalancing.googleapis.com/https/backend_request_count" AND metric.labels.response_code_class="500"' \
  --condition-threshold-value=10 \
  --condition-threshold-duration=300s \
  --notification-channels=<PO가 지정할 채널>
```

임계값(5분 내 500 10건)은 실측(10분 60~90회) 대비 보수적으로 낮게 잡아 — 이 정책이
실 사고보다 먼저(60~90회에 도달하기 전) 울리게 하는 것이 목적. 정확한 채널(Slack/
PagerDuty/이메일 등)과 임계값 튜닝은 PO 판단 — 이 커맨드는 「신호가 있어야 한다」는
요구를 채우는 최소 제안이다.
