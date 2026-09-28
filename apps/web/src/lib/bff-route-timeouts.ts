/**
 * story #4320(까디르 QA ① · PO 판정 2026-09-26) — 오래 걸리는 라우트의 시한 **한 곳**. 브라우저(fetchWithAuth 호출별 시한)와 BFF(백엔드
 * fetch 시한)가 같은 표를 읽는다 — 'use client'도 서버 전용도 아닌 순수 상수 모듈.
 *
 * 세 층: 브라우저(fetchWithAuth 기본 30초) → 프런트 Cloud Run(요청 한도 60초 · cloudbuild.yaml `_FRONTEND_TIMEOUT`) → BFF → 백엔드.
 * 원칙: BFF 시한 = min(백엔드 최악 + 여유, 프런트 한도 − 여유). Cloud Run이 먼저 끊으면 봉투 없는 504가 나간다 — BFF가 먼저
 * `UPSTREAM_TIMEOUT` 503 봉투로 답하게 한도 안쪽에 둔다. 브라우저 시한은 BFF보다 조금 길게(BFF의 503이 먼저 닿게 · 브라우저가 먼저
 * 끊어 BFF · 백엔드가 헛돌지 않게).
 *
 * 백엔드 최악이 한도를 넘는 줄(`syncImpossible`)은 **요청 하나로 기다릴 수 없는 일을 동기로 기다리는 구조가 결함**이다 — 한도를 키우는 건
 * 숫자만 옮기는 것이라(PO) 키우지 않는다. 그 줄은 이 표에서 «지금보다 나빠지지 않게»만 하고, 처방은 후속 카드(결과 조회 흐름 · 비동기화).
 * 백엔드 최악은 코드에서 뽑은 값(timeout 인자 × 잇단 호출)이지 실측 분포가 아니다 — httpx timeout은 단계별이라 느린 물방울은 넘을 수 있다.
 */

/** 프런트 Cloud Run 요청 한도 — cloudbuild.yaml `_FRONTEND_TIMEOUT: '60'`과 같은 수(테스트가 고정). */
export const FRONTEND_REQUEST_LIMIT_MS = 60_000;
/** BFF가 Cloud Run보다 먼저 답하는 여유. */
const BELOW_FRONTEND_LIMIT_MS = 5_000;
/** BFF 시한의 천장 — 이보다 길면 Cloud Run이 먼저 끊는다. */
export const BFF_CEILING_MS = FRONTEND_REQUEST_LIMIT_MS - BELOW_FRONTEND_LIMIT_MS;
/** 백엔드 최악 위에 두는 여유. */
const OVER_BACKEND_WORST_MS = 10_000;
/** 브라우저가 BFF보다 더 기다리는 몫(BFF의 503 봉투가 먼저 닿게). */
const BROWSER_OVER_BFF_MS = 3_000;

export interface LongRoute {
  /** 백엔드 최악(ms) — null이면 상한 없음. */
  backendWorstMs: number | null;
  /** 근거: 백엔드 파일:줄과 셈. */
  basis: string;
  /** BFF가 백엔드를 기다리는 시한. */
  bffMs: number;
  /** 브라우저 fetchWithAuth 호출 시한. */
  browserMs: number;
  /** 백엔드 최악이 천장 이상 — BFF가 답해야 할 때까지 백엔드가 끝날 수 없다: 동기로 못 기다림(후속 카드). 최악 + 여유만 천장을 넘는 줄
   * (예: 회고 종합 50초)은 끝날 수는 있고 여유만 줄어든다. */
  syncImpossible: boolean;
}

function route(backendWorstMs: number | null, basis: string): LongRoute {
  const wanted = backendWorstMs === null ? Number.POSITIVE_INFINITY : backendWorstMs + OVER_BACKEND_WORST_MS;
  const bffMs = Math.min(wanted, BFF_CEILING_MS);
  const syncImpossible = backendWorstMs === null || backendWorstMs >= BFF_CEILING_MS;
  return { backendWorstMs, basis, bffMs, browserMs: bffMs + BROWSER_OVER_BFF_MS, syncImpossible };
}

/** story #4336 — 공급자 호출이 요청 밖(발행 명령 워커)으로 나간 줄. 요청은 DB 읽기 · 쓰기뿐이라 코드에서 뽑을 네트워크 시한이 없다
 * (`backendWorstMs` 0 = «시한 있는 외부 호출 없음»). 시한은 다른 DB 라우트와 같은 기본값 — BFF 30초는 `backend-signal.ts`
 * `BFF_BACKEND_TIMEOUT_MS`와 같은 수(그 모듈이 이 표를 가져오므로 여기선 값을 적고, 같은 수인지는 테스트가 고정). */
export const DB_ONLY_BFF_MS = 30_000;

function dbOnlyRoute(basis: string): LongRoute {
  return { backendWorstMs: 0, basis, bffMs: DB_ONLY_BFF_MS, browserMs: DB_ONLY_BFF_MS + BROWSER_OVER_BFF_MS, syncImpossible: false };
}

export const LONG_ROUTES = {
  /** 결제 시작 — 빌링키 발급 15 + 옛 키 삭제 15 + 청구 65 + 중복 주문 조회 15 + 영수 메일(청구 안에서 await). */
  billingCheckout: route(110_000, 'toss_adapter.py:152(발급 15) · :142(삭제 15) · :196(청구 65) · :213(조회 15) · billing_charge.py:93(영수 메일 await) · org_subscription_checkout.py:199,206'),
  /** 요금제 변경 — 청구 65 (+ 중복 조회 15) + 부분 환불 15 + 영수 메일. */
  billingChangeTier: route(95_000, 'toss_adapter.py:196(청구 65) · :213(조회 15) · :258(환불 15) · org_subscription_tier_change.py:211,253,283'),
  /** 채널 즉시 발행(story #4336) — 요청은 공급자 호출 전 검사(DB)와 대기열 넣기뿐 · «발행 중»으로 곧바로 답한다. 공급자 호출(예전 최악:
   * 텍스트 80초 · X 스레드 ≈ 400초 · YouTube 상한 없음)은 발행 명령 워커가 하고, 화면은 초안을 다시 읽어 결과를 본다. */
  channelPublishNow: dbOnlyRoute('routers/channel_posts.py publish → services/channel_posts.py preflight_channel_post_publish(DB 읽기뿐 · 네트워크 0, test_4287 전송 층 덫) → publication_command.py requeue_for_human_publish → 200 processing · 공급자 호출은 process_due_publication_commands(워커)'),
  /** 초안 제출 — 레시피 게이트가 자동 충족돼도 발행은 대기열에만(story #4336 · publish_outcome=publishing). */
  channelDraftSubmit: dbOnlyRoute('services/channel_posts.py publish_recipe_approved_draft — 명령을 대기열에만(publish_outcome=publishing) · 발행과 레시피 published 이벤트는 워커'),
  /** 게이트 전이 · 대신 결재 — 레시피 external_publish 게이트 승인이어도 발행은 대기열에만(story #4336). */
  gateTransition: dbOnlyRoute('gates.py transition · override → gate_service.py transition_gate → publish_recipe_approved_draft — 대기열에만(publish_outcome=publishing) · 발행은 워커'),
  /** 첨부 변환(story #4336 PR2 ②) — 요청 안 예산 40초(작은 파일 · 캐시 적중은 바로). 넘으면 202 + 작업 — 받기 30 · Gotenberg 120 · 올리기 30은 워커. */
  attachmentConvert: route(40_000, 'routers/attachments.py convert_attachment(asyncio.timeout CONVERT_REQUEST_BUDGET_SECONDS 40 · 넘으면 202 작업 attachment_convert)'),
  /** 루프 컨텍스트 팩(story #4336 PR2 ②) — 요청 안은 임베드(10) · 검색 · 캐시 확인까지. 캐시 미스(LLM 25 × 2)는 202 + 작업(loop_context_pack). */
  loopContextPack: route(10_000, 'context_pack_items.py build_loop_context_pack(generate_on_miss=False) · embedding_client.py:26(10)'),
  /** 회고 종합(story #4336 PR2 ②) — 늘 작업(retro_synthesis): 요청은 권한 · 409 확인 · 작업 넣기(DB만) · 202. LLM은 워커. */
  retroSynthesis: dbOnlyRoute('routers/retros.py _queue_retro_generation'),
  /** 채널 게시물 이미지 확정(story #4336 PR2 · PO 04:32Z 요청 안 유지) — 요청 총 예산 40초(`IMAGE_REQUEST_BUDGET_SECONDS`) · 스토리지 호출마다
   * 시한(HEAD 10 · 받기 20 · 올리기 20 · `with_storage_deadline`) · 넘으면 504 CHANNEL_ASSET_STORAGE_TIMEOUT. 근거 dev 14일 349건 최대 9.3초. */
  channelAssetConfirm: route(40_000, 'routers/channel_posts.py _confirm_image_upload_or_raise(asyncio.timeout 40) · channel_post_images.py IMAGE_*_SECONDS'),
  /** 채널 게시물 영상 확정(story #4336 PR2) — 작업화: 요청은 DB + HEAD 한 번(15초)까지 하고 202 · 받기 · MP4 파싱 · 새 버전은 워커(background_jobs). */
  channelVideoConfirm: route(15_000, 'channel_post_videos.py precheck_channel_post_video_confirm(VIDEO_HEAD_SECONDS 15) → enqueue_background_job · 나머지는 워커'),
  /** 공용 작업 상태 보기(story #4336 PR2) — DB 읽기뿐(끝난 영상이면 서명 URL 하나). */
  backgroundJobStatus: dbOnlyRoute('routers/background_jobs.py get_background_job → render_background_job(DB 읽기 · 서명 URL)'),
  /** 외부 호출 사슬(OAuth 콜백) — 채널 최대 3 × 15 · 로그인 코드 교환 + 사용자 정보 2 × 15. */
  externalChain: route(45_000, 'channel_connections.py:746,812,883(15 each) · auth.py:1522,1686(15 each)'),
} as const satisfies Record<string, LongRoute>;

export type LongRouteKey = keyof typeof LONG_ROUTES;
