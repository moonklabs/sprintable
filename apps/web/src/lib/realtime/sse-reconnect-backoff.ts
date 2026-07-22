'use client';

/**
 * story #2095 — SSE 재연결 backoff 공용 로직.
 *
 * 배경(실측, 2026-07-22 dev-app·gcloud logging read·realtime-gateway 30분 관측):
 * 멤버 1명 기준 30분간 재연결 71회, 간격 분포가 60~68초 클러스터에 몰려 있다. 원인은
 * `sprintable-frontend-*`의 Cloud Run 요청 타임아웃이 60초로 고정돼 있어서다(cloudbuild.yaml
 * `_FRONTEND_TIMEOUT`) — frontend가 짧은 페이지 요청 기준 sizing(maxScale=3·상한 240 슬롯)이라
 * SSE 장수연결을 오래 붙들면 그 슬롯을 페이지 요청과 다투게 만드는 병목이 생기므로, 값
 * 인상이 아니라 브라우저→realtime 직결 설계(추후) 전까지는 **의도적으로 유지되는 트레이드
 * 오프**다(cloudbuild.yaml 주석 참고). 즉 이 60초 주기 컷은 "가끔 있는 이상 상황"이 아니라
 * **정상 운영 중 항상 반복되는 예정된 이벤트**다.
 *
 * 기존 `RECONNECT_DELAYS_MS = [5s, 30s, 60s, 300s]`는 `onopen`이 무조건 실패 카운트를
 * 리셋해서, 이 정상 60초 사이클에서는 우연히 5분까지 안 치솟는다 — 다만 "오래 붙어있었는지"가
 * 아니라 "열리기만 했는지"로 판정하고 있어 설계 의도가 불명확했다. 진짜 위험은 **핸드셰이크
 * 자체가 반복 실패하는(서버가 실제로 죽은) 상황**인데, 그 경우도 5분 상한은 과하다.
 *
 * 이 모듈은 "연결이 얼마나 오래 붙어 있었는지"로 리셋 여부를 가른다:
 * - `HEALTHY_CONNECTION_MS`(10초) 이상 붙어 있다가 끊겼으면 정상 사이클로 보고 실패
 *   카운트를 즉시 잊는다(다음 재시도는 1단계 지연만).
 * - 그보다 짧게(핸드셰이크 직후 등) 끊기면 진짜 불안정으로 보고 카운트를 유지·증가시킨다.
 *
 * 새 상한(20초, 기존 300초)의 근거: 실측 정상 사이클이 60~68초이므로, 최악의 경우(서버가
 * 진짜 죽어 매번 카운트가 증가)에도 누적 백오프(1+3+8+20=32초)가 정상 사이클 길이보다
 * 짧다 — 재시도 폭풍이 사이클 하나를 도는 동안 물리적으로 발생할 수 없다. 동시에 실시간
 * 공백을 기존 최악 5분에서 최악 20초로 줄인다.
 *
 * ⚠️ PO 리뷰(2026-07-22) — 지터(jitter) 필수: 지터 없이 상한만 낮추면 서버 재시작·순단처럼
 * **다수 클라이언트가 동시에 끊기는** 상황에서 전부 같은 간격으로 동시 재시도해(동기화된
 * herd) 재시도 폭풍 위험이 오히려 커진다. E-GCE-RT S6 실측(600 연결 동시 접속 시 CPU
 * 92~97%)으로 thundering herd가 실제 문제임이 확인됐고, 상한을 15배 낮췄으니(300s→20s)
 * 같은 herd가 15배 자주 온다 — 각 지연에 ±20% 랜덤 지터(`delay * (0.8~1.2)`)를 곱해
 * 동시 재시도를 시간축으로 흩뿌린다.
 */
export const RECONNECT_DELAYS_MS = [1_000, 3_000, 8_000, 20_000];

const HEALTHY_CONNECTION_MS = 10_000;
const JITTER_RATIO = 0.2; // ±20%

export interface ReconnectBackoffState {
  /** EventSource가 open됐을 때 호출 — 이후 onError 판정에 쓸 시작 시각을 기록한다. */
  onOpen: () => void;
  /** 지금이 최초 연결이 아니라 재연결(과거 open 이력이 있음)인지 — backfill 트리거용.
   *  onOpen() 호출 *전에* 확인해야 정확하다(과거 이력을 묻는 질문이므로). */
  isReconnect: () => boolean;
  /** EventSource가 error됐을 때 호출 — 다음 재시도까지 기다릴 지연(ms, ±20% 지터 적용됨)을 반환한다. */
  onError: () => number;
}

/** 테스트에서 결정적 값을 주입할 수 있도록 난수 소스를 분리(기본 Math.random). */
export function createReconnectBackoffState(random: () => number = Math.random): ReconnectBackoffState {
  let attempts = 0;
  let openedAt: number | null = null;
  let hadPriorError = false;

  return {
    onOpen() {
      openedAt = Date.now();
    },
    isReconnect() {
      return hadPriorError;
    },
    onError() {
      hadPriorError = true;
      const stayedHealthy = openedAt !== null && Date.now() - openedAt >= HEALTHY_CONNECTION_MS;
      openedAt = null;
      if (stayedHealthy) attempts = 0;
      const baseDelay = RECONNECT_DELAYS_MS[Math.min(attempts, RECONNECT_DELAYS_MS.length - 1)]!;
      attempts += 1;
      // (1-JITTER_RATIO) ~ (1+JITTER_RATIO) 범위(0.8~1.2)로 균등분포 — 동시 재시도를 흩뿌린다.
      const jitterMultiplier = 1 - JITTER_RATIO + random() * (2 * JITTER_RATIO);
      return Math.round(baseDelay * jitterMultiplier);
    },
  };
}
