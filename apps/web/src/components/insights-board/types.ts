// story #3503(성과 보드 화면) — BE #3502(PR 아직 develop 미착지, origin/feat/3502-insights-board-api
// 브랜치 fd57310d4 기준)의 InsightsBoardRow/InsightSnapshotBucketView 계약을 FE 쪼갤 없이
// 그대로 옮긴 타입. BE 코드를 직접 import하지 않는다(스택 브랜치 아님, develop 기준 빌드) —
// 이 파일이 그 계약의 FE측 사본(fixture 기반 검증 축)이다.
//
// insight-snapshot-block.tsx(story #3499)의 InsightSnapshot과 형태가 비슷하지만 이 보드의
// d1/d7 버킷은 그 스냅샷 히스토리 항목과 다른 모양이다(due_at·source 필드가 없다 — 이
// 보드는 "지금 이 버킷이 어디 있나"만 보여주는 요약 뷰다, 히스토리 목록이 아니다).
// story #3660(2026-09-07, 페드루 PO CHANGES) — 'in_progress'가 누락돼 있었고(BE가
// due 도래분을 pending→in_progress로 전이해 실제로 쓰는 값), 재발행 자가회수가 옛
// 사이클 pending/in_progress 행을 superseded로 회수하는 값을 새로 추가했다.
//
// story #3746(유나 v5, 2026-09-09) — 'dead_letter'는 이 축(`InsightSnapshot.status`,
// backend/app/models/insight_snapshot.py:52)의 실 값이 아니었다(BE 서비스 전수 0건 —
// #3720/#3721이 걷은 것과 같은 유령 표면 클래스). 걷는다 — BE 모델의 실 여섯 값과
// 정확히 일치시킨다(pending/in_progress/captured/unsupported/failed/superseded).
//
// story #3746(유나 design gate CHANGES, 2026-09-09) — 이 유니온의 «유일한» 정본이다.
// `insight-snapshot-block.tsx`가 한때 같은 값을 별도로 재정의했었다 — 값이 같아도
// 정의가 둘이면 한쪽만 고쳤을 때 다른 쪽 `Record<InsightSnapshotStatus, …>` 가드가
// 조용히 안 걸린다(이 스토리가 닫으려던 결함 그대로 재발). 그 파일은 이제 여기서
// import만 한다 — 새 소비처를 추가할 때도 재정의 대신 이 export를 쓸 것.
//
// story #3808(Phase3·3-3 PR4, 페드루 PO CHANGES 2026-09-12) — 'skipped' 추가
// (backend/app/models/insight_snapshot.py는 여전히 Text·CHECK 없음 — 마이그
// 0건, BE `insight_snapshots.py::process_due_insight_snapshots`가 X 종량 read
// 상한 도달 시 쓰는 새 값). 이 유니온 하나만 고치면 아래 모든 `Record<
// InsightSnapshotStatus, …>` 소비처가 tsc에서 즉시 막힌다(값 하나 빠짐=컴파일
// 에러) — #4049류 "같은 화면 두 세계" 드리프트를 구조적으로 막는 자리.
export type InsightSnapshotStatus =
  | 'pending'
  | 'in_progress'
  | 'captured'
  | 'unsupported'
  | 'failed'
  | 'superseded'
  | 'skipped';

export interface InsightNormalizedMetrics {
  impressions: number | null;
  reach: number | null;
  views: number | null;
  engagements: number | null;
  clicks: number | null;
  spend: number | null;
  conversions: number | null;
  // story #3583(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06 · 유나 §13-9/§21-6-1) —
  // GA4 「고객 소유」 연결의 유입 지표. 열 추가가 아니라 이 그리드(지표×D1/D7)의
  // 지표 축에 2개를 더한 것 — DEFAULT_METRIC(views)은 그대로.
  inflow_sessions: number | null;
  inflow_users: number | null;
  // story #3813(Phase3·3-4 PR3, 페드루 PO 確定 2026-09-12) — 뉴스레터 발송결과
  // 캡처 축(BE `NORMALIZED_KEYS` 12키 확장과 동형 미러). 선언 안 한 채널(뉴스레터
  // 외 전부)은 BE가 이미 null로 채워 보낸다(declare-to-populate 관례 그대로).
  opens: number | null;
  delivered: number | null;
}

// NULL(이 값 전체) — 이 버킷 자체가 아직 스케줄되지 않았음/존재하지 않음. bucket.normalized가
// null인 것(캡처됐지만 이 특정 지표를 못 줌)과는 다른 축 — 셀 컴포넌트가 이 둘을 분리해서 다룬다.
export interface InsightSnapshotBucketView {
  status: InsightSnapshotStatus;
  normalized: InsightNormalizedMetrics | null;
  captured_at: string | null;
}

export interface InsightsBoardRow {
  publication_id: string;
  kind: 'site_post' | 'channel_publication';
  channel: string;
  work_item_id: string;
  title: string;
  published_at: string;
  external_url: string | null;
  connection_id: string | null;
  d1: InsightSnapshotBucketView | null;
  d7: InsightSnapshotBucketView | null;
  // story #3517(BE #3865 REQUIRED 2, 유나 §22-11 재정정, PO 確定 2026-09-05) —
  // null=site_post(댓글 축 자체가 없다) · 정수=channel_publication의 active 댓글
  // 수(0 포함 — comments_last_collected_at이 값 있으면 "수집됐는데 0건"이 확定,
  // §22-7 "0이면 0으로 적는다" 원칙이 이제 선다).
  comments_count: number | null;
  // story #3517(BE #3867 조각② REQUIRED, PO 確定 2026-09-05) — §22-11이 막았던
  // "0의 뜻이 안 갈린다" 문제를 푸는 신호 둘. site_post는 항상 null/false.
  channel_post_draft_id: string | null;
  comments_last_collected_at: string | null;
  comments_supported: boolean;
  // story #3656(Phase2·FE+BE, 페드루 PO 確定 2026-09-07) — 3645(#4002)의
  // `_resolve_channel_publication_asset_evidence`를 list_insights_board가 재사용해
  // 「지금」 값을 싣는다(evidence 조인이 아니다 — version 행 불변 전제로 보드의
  // 「지금」과 evidence의 「스냅샷 시점」이 같다는 것이 BE 측 전제, BE PR에서 주석
  // 확定). site_post(hosted_site)·이미지/영상 0건·hook_key 미태깅 발행물은 각각
  // null — 소급 백필 없음(신규 발행부터만 채워진다).
  asset_sha256s: string[] | null;
  hook_key: string | null;
  // story #3766(별건 ⑩, 3746 §3 유나 定) — 「사람 차례」 발행 명령 축. 채널 포스트
  // 목록의 CommandStatus(failure-action.ts)와 같은 값 집합·같은 뜻(같은
  // PublicationCommand 행) — 새 낱말 0. 수집 상태 축(d1/d7·comments_*)과는 다른
  // 축이라 필터 대상이 아니라 행 배지 전용. site_post 행은 항상 null.
  command_status: string | null;
  // story #3806(Phase3·3-2 PR5 조각⑥, 유나 §절 §3 「성과 보드 «광고비» 분리 칸」) —
  // 이 publication에 홍보 요청이 없으면 null(「해당 없음」 원천 — 지어내지 않는다).
  ads_boost: AdsBoostSummaryView | null;
}

export interface AdsBoostSummaryView {
  gate_id: string;
  gate_status: string;
  sealed_budget_minor: number | null;
  sealed_currency: string | null;
  captured_spend_minor: number;
  remaining_minor: number;
  // AdsBoostRun 행이 아직 없으면(시작 前) null.
  run_status: 'pending' | 'running' | 'paused' | 'failed' | null;
}

export type Ga4ConnectionStatus = 'not_connected' | 'needs_reauth' | 'connected';

export interface InsightsBoardResponse {
  rows: InsightsBoardRow[];
  has_more: boolean;
  next_cursor: string | null;
  // story #3746(3734 §4-C) — 초안 1개 보관이 언어별 발행 행 N개를 한꺼번에 숨길 수
  // 있다(work_item_id 기준 join, lang은 그 유니크 밖). 셀 수 있을 때만 정수, 모르면
  // null(지어내지 않는다) — 기본(include_deleted=false) 뷰에서만 뜻이 있다.
  hidden_count: number | null;
  // story #3583(2026-09-10, 페드루 PO 確定) — org당 GA4 연결 1값(ga4_connections
  // unique 제약, 행마다가 아니다). InsightsBoardMetricCell이 inflow_* 지표 null의
  // 원인을 이 값으로 가른다 — 「지표 키 이름」만으로 «GA4 미연결»을 단정하던 결함의
  // 처방(insight_snapshots.py::_fetch_ga4_inflow_metrics는 연결이 살아 있어도
  // 처리 지연·해당 창 유입 0·일시 OAuthError로 null을 그대로 둘 수 있다).
  ga4_connection_status: Ga4ConnectionStatus;
}

export type InsightsBoardWindow = '7d' | '30d' | '90d';

// PO REQUEST(2026-09-05, PR#3853 리뷰) — 대표 지표를 impressions로 고정했더니
// hosted_site(블로그 beacon)는 views만 채우고 impressions는 늘 null이라 고객
// 1호(블로그+Threads)의 블로그 행이 전부 대시로 섰다. 지표를 «선택기»로 바꾼다 —
// 기본값 views, URL 파라미터 `metric`(기본값이면 생략). 7키 순서는 insight-
// snapshot-block.tsx(story #3499) METRIC_KEYS와 동일(그 파일의 i18n 라벨 재사용).
// story #3583 — inflow_sessions/inflow_users 2개 추가(유나 §13-9 確定 — 열 추가가
// 아니라 이 선택기의 지표 축 확장). DEFAULT_METRIC은 그대로 views.
// story #3813(Phase3·3-4 PR3, 페드루 PO 確定 2026-09-12) — 뉴스레터 발송결과
// 캡처 축(opens·delivered) 추가. `CHANNEL_DECLARED_METRICS`(BE↔FE 드리프트 가드,
// test_3697 짝)의 원소 타입이 BoardMetric이라 stibee_sandbox 실값 등재에
// 필요 — 단 이 두 키는 아직 화면 선택기(아래 SELECTABLE_METRIC_KEYS)엔 안 연다
// (PR4가 카드/선택기에 실제로 노출할 몫, 지금은 눌러도 항상 빈 화면일 옵션을
// 미리 보여주지 않는다는 PO 판단).
export const METRIC_KEYS = [
  'views', 'impressions', 'reach', 'engagements', 'clicks', 'spend', 'conversions',
  'inflow_sessions', 'inflow_users', 'opens', 'delivered',
] as const;
export type BoardMetric = (typeof METRIC_KEYS)[number];
export const DEFAULT_METRIC: BoardMetric = 'views';

// story #3813(PR3) — 지표 선택기(insights-board/page.tsx 상단 드롭다운)가 실제로
// 노출하는 부분집합. METRIC_KEYS 전체가 아니라 이 목록만 렌더한다.
export const SELECTABLE_METRIC_KEYS: readonly BoardMetric[] = [
  'views', 'impressions', 'reach', 'engagements', 'clicks', 'spend', 'conversions',
  'inflow_sessions', 'inflow_users',
];
// story #3813(PR3) — 선택기에서 "아직" 뺀 키의 명시 목록(묵시 누락과 구분하는
// 자리 — 새 METRIC_KEYS를 추가했는데 SELECTABLE_METRIC_KEYS에도 여기에도 안
// 넣으면 아래 완전성 테스트가 RED). PR4가 opens/delivered를 선택기에 열 때
// 이 배열에서 빼고 SELECTABLE_METRIC_KEYS로 옮긴다.
export const PENDING_SELECTOR_KEYS: readonly BoardMetric[] = ['opens', 'delivered'];

export type FollowUpKind = 'republish' | 'edit' | 'stop';

export interface FollowUpCreateResponse {
  story_id: string;
}
