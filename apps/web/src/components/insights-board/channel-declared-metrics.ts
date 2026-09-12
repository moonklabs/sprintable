import type { BoardMetric } from './types';

// story #3697(Phase2·FE, 유나 § 確定 2026-09-08) — backend/app/services/channel_adapters.py::
// ChannelAdapterConfig.insight_metrics의 FE측 사본이다(nav-config.ts류 BE-계약-미러 관례).
// 유나 § 그대로: "선언 안 함 = 항상 null(0으로 안 지어냄 — 어댑터 주석이 「이 스토리의
// 척추」라 부른 규율)". 이 맵이 소비 화면(story-insights-compare-section.tsx)에서
// "선언 안 한 지표는 행 자체를 안 그린다"는 규칙의 근거다 — BE가 실제로 null을 주는
// 자리를 화면이 «빈 값»이 아니라 «그 매체가 원래 안 가진 지표»로 미리 안다.
//
// ⚠️동기화 — 아래 값이 channel_adapters.py의 insight_metrics 튜플과 갈리면 이 화면이
// 실제로 채워질 수 있는 지표를 놓치거나(과소) 항상 빈 행을 그린다(과다). BE 값이 바뀌면
// 이 맵도 같이 고칠 것(BE PR 리뷰에서 이 파일이 걸리는지 확認).
export const CHANNEL_DECLARED_METRICS: Record<string, readonly BoardMetric[]> = {
  // channel_adapters.py:177
  threads: ['views', 'engagements'],
  // channel_adapters.py:237
  instagram: ['views', 'reach', 'engagements'],
  // channel_adapters.py:326
  facebook: ['impressions', 'reach', 'engagements', 'clicks', 'views'],
  // channel_adapters.py:374(facebook과 동형)
  facebook_sandbox: ['impressions', 'reach', 'engagements', 'clicks', 'views'],
  // channel_adapters.py:403 — GA4 연결 시 inflow_sessions/inflow_users도 채워지지만
  // "선언"은 채널 어댑터 고정값이 아니라 org의 GA4 연결 여부에 달렸다(row별 실측 —
  // bucket.normalized.inflow_*가 null이면 §21-6-1 "GA4 미연결" 사유가 이미 그 사실을
  // 말한다). 그래서 이 맵엔 안 넣는다 — 넣으면 GA4 미연결 org에서도 항상 그 행이
  // 그려지고 매번 "GA4 미연결"만 보여 §22-18(선언 안 한 지표는 행 자체를 안 그린다)
  // 정신에 어긋난다. views/clicks만 이 채널의 «고정» 선언이다.
  hosted_site: ['views', 'clicks'],
  // channel_adapters.py:529(instagram과 동형 정정 — impressions 폐기, views로 대체)
  instagram_sandbox: ['views', 'reach', 'engagements'],
  // channel_adapters.py:486~488 — dev 전용 테스트 채널, 7키 전부 결정적 합성값.
  sandbox: ['impressions', 'reach', 'views', 'engagements', 'clicks', 'spend', 'conversions'],
  // channel_adapters.py:507(story #3808 PR4) — X public_metrics(impression_count·
  // like/retweet/reply/quote_count 합산)만 declare. reach/views/clicks/spend/
  // conversions는 X가 안 준다(null 유지).
  x: ['impressions', 'engagements'],
  // channel_adapters.py:523(x와 동형)
  x_sandbox: ['impressions', 'engagements'],
  // channel_adapters.py — wordpress·webhook은 insight_metrics 미선언(dataclass 기본값
  // 빈 튜플). 이 맵에 키 자체를 안 넣는다 — declaredMetricsForChannel()의 "모르는
  // 채널=빈 배열" 폴백이 그대로 옳은 값이다(원문 그대로 폴백, 지어내지 않는다 —
  // channel-label.ts의 관례와 동형).
  //
  // story #3813(Phase3·3-4 PR5-b, 페드루 PO 確定 2026-09-12) — channel_adapters.py의
  // 실 "stibee"(sandbox 아님) 선언과 동형(3키). 실제로 값이 차는 건 delivered뿐
  // (opens/clicks는 실 actionName 미확認이라 fetch가 항상 null — PR1 당시 빈
  // 배열이던 게 여기서 stibee_sandbox와 같은 모양으로 승격).
  stibee: ['opens', 'delivered', 'clicks'],
  // story #3813(Phase3·3-4 PR3, 페드루 PO 確定 2026-09-12) — channel_adapters.py:657
  // 실 등재값과 동형. opens/delivered는 METRIC_KEYS엔 있으나 선택기(SELECTABLE_
  // METRIC_KEYS)엔 아직 없다(PR4 몫) — 이 맵은 "선택기 노출"이 아니라 "이 채널이
  // 이 지표를 declare하는가"의 BE 미러라 선택기 상태와 무관하게 실값 그대로 채운다.
  stibee_sandbox: ['opens', 'delivered', 'clicks'],
};

/** 이 채널이 declare한 지표 목록. 등록되지 않은 채널(모르는 값·wordpress·webhook 등)은
 * 빈 배열 — "이 채널은 아무 지표도 선언 안 함"으로 안전하게 읽힌다(공통 축 views 행조차
 * 안 그려질 수 있다는 뜻, 지어내지 않는다). */
export function declaredMetricsForChannel(channel: string): readonly BoardMetric[] {
  return CHANNEL_DECLARED_METRICS[channel] ?? [];
}
