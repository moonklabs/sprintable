// story #2446 — 「생성기 자체가 목표 rps를 뽑을 수 있는가」positive control.
//
// 왜 이게 따로 필요한가(PO 지시, 2026-08-04): Run 1(2026-08-03, dev_db_capacity_test.js,
// 200/s·5m)이 정확히 이 실패모드를 실측했다 — k6 executor가 MAX_VUS=400 천장을
// 14초 만에 쳐서 dropped_iterations=63,573(완주 건수를 압도)가 났는데, 그 순간 DB pool
// 텔레메트리(cl_active=24)는 전혀 바쁘지 않았다. 즉 「서버가 200/s에서 캡됐다」가 아니라
// 「k6 생성기 자체가 200/s를 못 뽑았다」였다 — 그런데 얼핏 보면 http_req_failed 같은
// 서버쪽 지표만 보고 "서버가 느리다"로 오판하기 쉽다(자가 정확해도 틀린 걸 재는 병).
//
// 이 스크립트는 그 오판을 원천 차단한다 — 서버에 «전혀 부담을 주지 않는» 엔드포인트
// (GET /api/v2/ping: 인증 불필요·DB 미접속·핸들러가 딕셔너리 하나 반환하는 게 전부,
// backend/app/routers/health.py)를 목표 rps의 1.2배로 짧게 쏴서, 생성기 자체가 그 이상을
// 뽑아낼 수 있는지만 격리해서 잰다. 서버 부하가 0에 가까운 엔드포인트이므로 achieved rate가
// attempted(target) 에 못 미치면 그 원인은 100% 생성기(k6 VU 수·로컬 머신 CPU/네트워크)다.
//
// 통과 기준: achieved iteration «개수» >= ramp_expected.py가 계산한 기대 개수(램프
// 사다리꼴 적분) * 0.95. iterations.rate(전체구간 평균)를 target과 직접 비교하지
// «않는다» — 램프업/다운 구간이 평균을 구조적으로 깎아 정상 생성기도 fail로 오판하게
// 만든다(실측: TARGET=300에서 rate=308/s vs attempted=360/s는 86%로 보이지만 실제
// iteration 개수는 기대치의 99.98%). 실패하면 본 테스트를 돌리지 말 것 — 그 결과는
// 「서버가 X에서 캡」이 아니라 「생성기가 X 밖에 못 쏨」일 뿐이다.
//
// 실행:
//   BASE_URL=https://sprintable-backend-dev-... TARGET_RATE=300 k6 run generator_selfcheck.js
// 오케스트레이터(run_loadtest.sh)가 본 테스트 前에 자동으로 이걸 먼저 돌리고 게이트한다 —
// 수동으로 이 파일만 돌릴 때도 동일한 통과 기준이 적용된다(별도 로직 없음).

import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'https://sprintable-backend-dev-57iommnikq-du.a.run.app';
// 본 테스트가 목표할 rps보다 «높게» 잡아야 「생성기가 목표보다 여유 있게 뽑을 수 있다」는
// 걸 증명한다 — 자기 자신의 목표치를 간신히 맞추는 정도로는 다음 실 부하(추가 지연·재시도)
// 아래서 재현 안 될 위험이 있다(20% 헤드룸).
const TARGET_RATE = Number(__ENV.TARGET_RATE || 300);
const SELFCHECK_RATE = Math.ceil(TARGET_RATE * 1.2);
const DURATION = __ENV.SELFCHECK_DURATION || '20s';
// run_loadtest.sh가 ramp_expected.py로 기대 iteration 개수를 계산할 때 이 두 값을
// 그대로 참조한다(하드코딩 값이 여기와 오케스트레이터 양쪽에 따로 있으면 드리프트) —
// 바꿀 땐 run_loadtest.sh의 SELFCHECK_RAMP_UP/SELFCHECK_RAMP_DOWN 기본값도 같이.
const RAMP_UP = __ENV.SELFCHECK_RAMP_UP || '5s';
const RAMP_DOWN = __ENV.SELFCHECK_RAMP_DOWN || '3s';
// Run 1의 400 천장이 14초 만에 밟혔던 것 — 이번엔 훨씬 큰 여유치로 시작(생성기 자체
// 상한을 재는 게 목적이라 서버 부하 걱정 없이 넉넉하게 잡아도 무해, GET /ping이 받는다).
const PRE_ALLOCATED_VUS = Number(__ENV.SELFCHECK_PRE_ALLOCATED_VUS || 2000);
const MAX_VUS = Number(__ENV.SELFCHECK_MAX_VUS || 5000);

export const options = {
  scenarios: {
    generator_ceiling: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages: [
        { duration: RAMP_UP, target: SELFCHECK_RATE },
        { duration: DURATION, target: SELFCHECK_RATE },
        { duration: RAMP_DOWN, target: 0 },
      ],
    },
  },
  // 여기 threshold는 「생성기가 스스로도 못 뽑는지」를 last-resort로 잡는다 — 진짜 판정은
  // run_loadtest.sh가 summary JSON의 achieved rate를 직접 계산해서 한다(threshold만으론
  // "시도 대비 달성 비율"을 못 표현함, http_req_duration/failed는 서버 응답 지표라 이
  // 무부하 엔드포인트에선 항상 통과할 것 — dropped_iterations만이 생성기 기아의 신호).
  thresholds: {
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/api/v2/ping`);
  check(res, { 'ping 200': (r) => r.status === 200 });
}
