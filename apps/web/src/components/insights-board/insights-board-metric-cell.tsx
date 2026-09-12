'use client';

import type { useTranslations } from 'next-intl';
import type { Ga4ConnectionStatus, InsightSnapshotBucketView } from './types';

// story #3503 — insight-snapshot-block.tsx(story #3499)의 패턴을 「표 셀 하나」 크기로
// 축소한 신규 컴포넌트(PO 브리프 — 그 컴포넌트를 통째로 재사용하지 않는다, due_at·source
// 등 히스토리 전용 필드가 이 버킷엔 없다). 재사용하는 것은 다음 세 원칙뿐:
//   ① i18n 키 재사용 — pending/in_progress/captured/failed/unsupported/superseded 상태
//      «라벨»은 content 네임스페이스 기존 키를 그대로 부른다(같은 개념을 두 벌로 안 쓴다).
//   ② captured→값만(배지 없음) 원칙.
//   ③ failed만 destructive 톤, 나머지 중립.
//
// doc a0da40c9 §21-2(유나 2026-09-05, 정정) — 표 칸은 «문장이 아니라 명사구»다(6열
// 표에서 문장은 행 높이를 무너뜨린다). §17-19가 이미 "배지·API·툴팁=문장, 자리가
// 좁으면 명사구"로 갈라 뒀다 — 표 칸이 그 좁은 자리다. 그래서:
//   - unsupported 사유는 insight-snapshot-block.tsx가 쓰는 문장(insightSnapshotUnsupported)이
//     아니라 되살린 명사구 키 insightStatusUnsupported("채널 미제공")를 쓴다 — §21-2가
//     "PR#3846에서 죽은 키라 지운 것을 판단 조건(닿는 자리 유무)이 바뀌어 되살린다"고
//     명시한 바로 그 키.
//   - captured인데 지표 값이 null인 사유도 문장(insightMetricUnavailableReason)이 아니라
//     이 보드 전용 명사구 insightsBoardMetricUnavailable("지표 미제공")를 쓴다.
//   - 버킷 자체가 null인 사유는 insightsBoardBucketUnscheduled 자체를 명사구
//     ("집계 예정 없음")로 바꿔 그대로 재사용한다.
//
// story #3746(유나 v5, 2026-09-09) — 「수집 상태 × 통 표」 재정정. dead_letter는
// `InsightSnapshot.status`(BE)의 실 값이 아니었다(BE 서비스 전수 0건 — 유령 표면,
// 걷는다). in_progress·superseded는 실사용 값인데 이 맵이 빠뜨렸었다 — `Partial<Record>`
// +`!`가 그 구멍을 컴파일러에게 숨겨서 실제로 오면 `tContent(undefined!)`가 됐을
// 자리(카디르 QA가 CI에서 못 잡는 클래스). `Record`(비-Partial)로 바꿔 여섯 값 중
// 하나라도 또 빠지면 이제 빌드가 막는다. pending·in_progress는 같은 통(「아직」 —
// 다음 발이 같다, 축은 다음 발로 가른다) — insightStatusWaiting 신규 키(유나 定).
//
// story #3746(유나 design gate 적기만, 2026-09-09) — 같은 pending/in_progress 통이
// 자리마다 다른 낱말로 선다: 필터="수집 대기"(statusFilterPending, 선택지 명사) ·
// 이 표 칸="아직"(insightStatusWaiting, §21-2 명사구) · 상세 블록="대기 중"
// (insightStatusPending, 문장). 하나로 안 맞춘 건 실수가 아니다 — 자리마다 폭이
// 다르다(선택지·6열 좁은 칸·문장 블록)는 §17-19/§21-2 규율 그대로. 낱말 자체를
// 하나로 맞추는 판단은 PO 손.
const STATUS_LABEL_KEYS: Record<InsightSnapshotBucketView['status'], string> = {
  pending: 'insightStatusWaiting',
  in_progress: 'insightStatusWaiting',
  captured: 'insightStatusCaptured',
  failed: 'insightStatusFailed',
  unsupported: 'insightStatusUnsupported',
  // superseded 행은 BE가 기본 목록에서 배제한다(story #3746 §11) — 이 셀에 사실상
  // 안 온다. 그래도 맵을 비-Partial로 하려면 빠짐없이 채워야 하니 방어적으로 정직한
  // 라벨을 둔다(지어낸 값이 아니라 "왜 안 온다" 그 자체를 말".
  superseded: 'insightStatusSuperseded',
  // story #3808(Phase3·3-3 PR4, 페드루 PO CHANGES 2026-09-12) — X 종량 read 상한
  // 도달. unsupported와 동형(명사구, §21-2 좁은 칸 규율) — 기존 insightStatusSkipped
  // 재사용(신규 낱말 0).
  skipped: 'insightStatusSkipped',
};

const DESTRUCTIVE_STATUSES: ReadonlySet<InsightSnapshotBucketView['status']> = new Set(['failed']);

// story #3583(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06 정정 2026-09-10) — captured인데
// 값이 null인 사유 3갈래 중 이 지표 2개만 새 낱말 — 나머지 5지표는 기존
// insightsBoardMetricUnavailable 그대로. **정정(2026-09-10)**: 이전 주석 "붙었는데 값만
// 없는 경우는 여기 안 온다"는 거짓이었다 — insight_snapshots.py::_fetch_ga4_inflow_
// metrics(`if inflow and …`)는 연결이 살아 있어도(GA4 처리 지연으로 rows=[]·해당 창
// 유입 0·일시 OAuthError) null을 그대로 둔다. 그래서 원인을 지표 키 이름이 아니라
// 응답의 `ga4_connection_status`(org당 1값)로 가른다 — 아래 참고.
const GA4_INFLOW_METRICS = new Set(['inflow_sessions', 'inflow_users']);

export interface InsightsBoardMetricCellProps {
  bucket: InsightSnapshotBucketView | null;
  metric: keyof NonNullable<InsightSnapshotBucketView['normalized']>;
  /** content 네임스페이스 t — 상태/지표 라벨 재사용원. */
  tContent: ReturnType<typeof useTranslations>;
  /** insightsBoard 네임스페이스 t — 이 보드 전용 신규 문구(미스케줄 사유)만. */
  tBoard: ReturnType<typeof useTranslations>;
  /** story #3583(정정, 2026-09-10) — needs_reauth 갈래가 채널 연결 화면의 기존 낱말
   * `channelStatusReauthRequired`(channelConnect 네임스페이스)를 재사용한다 — 새
   * 낱말을 만들지 않는다(PO 確定). */
  tChannelConnect: ReturnType<typeof useTranslations>;
  /** story #3583(정정, 2026-09-10) — GA4_INFLOW_METRICS가 null일 때 사유를 가르는 축.
   * org당 1값(InsightsBoardResponse.ga4_connection_status)이라 호출부가 그대로 넘긴다
   * (이 컴포넌트가 다시 조회하지 않는다). GA4 아닌 지표엔 안 쓰인다. */
  ga4ConnectionStatus: Ga4ConnectionStatus;
}

export function InsightsBoardMetricCell({ bucket, metric, tContent, tBoard, tChannelConnect, ga4ConnectionStatus }: InsightsBoardMetricCellProps) {
  // (i) 버킷 자체가 없음 — 아직 스케줄되지 않음/존재하지 않음.
  if (bucket === null) {
    return (
      <span data-testid="insights-board-cell-unscheduled">
        <span>{tContent('insightMetricUnavailableDash')}</span>
        <span className="ml-1 text-xs text-muted-foreground">{tBoard('insightsBoardBucketUnscheduled')}</span>
      </span>
    );
  }

  // (ii) 버킷은 있지만 아직 수집 완료 전(또는 실패/미지원) — 상태 라벨만(명사구).
  if (bucket.status !== 'captured') {
    const toneClass = DESTRUCTIVE_STATUSES.has(bucket.status) ? 'text-destructive' : 'text-muted-foreground';
    return <span className={toneClass} data-testid="insights-board-cell-status">{tContent(STATUS_LABEL_KEYS[bucket.status])}</span>;
  }

  // (iii) captured — 선택 지표 값. normalized 자체가 없거나(방어적, 계약상 이례) 해당
  // 지표 키가 null이면(이 채널이 이 지표를 안 줌) §18-2 null↔0 구분 그대로 대시+사유
  // (§21-2 — 사유는 명사구 insightsBoardMetricUnavailable, 문장 아님).
  const value = bucket.normalized?.[metric] ?? null;
  if (value === null) {
    // story #3583(정정, 2026-09-10) — GA4 두 지표는 이제 「키 이름」이 아니라 org의
    // 실 연결 상태로 사유를 가른다(위 GA4_INFLOW_METRICS 주석 참고). connected인데
    // null인 경우는 "미연결"이 아니라 "아직 안 왔다" — 신설 낱말 「집계 대기」로
    // 구분한다(insightsBoardMetricUnavailable "지표 미제공"과 뜻이 다르다: 저건
    // 채널 자체가 이 지표를 영원히 안 준다는 뜻, 이건 곧 올 수 있다는 뜻).
    const reasonNode = GA4_INFLOW_METRICS.has(metric)
      ? ga4ConnectionStatus === 'not_connected'
        ? tBoard('insightsBoardGa4NotConnected')
        : ga4ConnectionStatus === 'needs_reauth'
          ? tChannelConnect('channelStatusReauthRequired')
          : tBoard('insightsBoardGa4AggregationPending')
      : tBoard('insightsBoardMetricUnavailable');
    return (
      <span data-testid="insights-board-cell-value-dash">
        <span>{tContent('insightMetricUnavailableDash')}</span>
        <span className="ml-1 text-xs text-muted-foreground">{reasonNode}</span>
      </span>
    );
  }
  return <span data-testid="insights-board-cell-value">{value}</span>;
}
