'use client';

import Link from 'next/link';
import type { useTranslations } from 'next-intl';
import type { InsightsBoardRow } from './types';

/**
 * story #3517(BE #3867 조각②, 유나 §22-11 재정정 → §13·§22-11 최종, PO 確定
 * 2026-09-05) — 댓글 칸. InsightsBoardMetricCell과 같은 관례("네 갈래를 하나도 안
 * 숨긴다" — §21-2, 좁은 칸은 명사구로) 그대로 재사용.
 *
 * 네 갈래(BE #3867 REQUIRED — comments_supported·comments_last_collected_at 신호
 * 도착으로 이제 구분 가능해졌다, §22-11이 막았던 "0의 뜻이 안 갈린다" 문제 해소):
 *   ① site_post 행 — 댓글 축 자체가 없다("해당 없음", comments_supported 항상 false).
 *   ② channel_publication인데 그 채널 어댑터가 supports_fetch_replies=False —
 *      "채널 미제공"(①과 문구를 다르게 한다 — "이 콘텐츠 종류엔 없음"과 "이 채널은
 *      지원 안 함"은 다른 사실이다, 섞으면 오귀인).
 *   ③ comments_supported=true인데 comments_last_collected_at===null — "아직 수집
 *      전"(0건이 아니라 «모른다»).
 *   ④ 수집됨(last_collected_at 있음) — comments_count 그대로(0 포함, 이제 «수집됐는데
 *      0건»과 «미수집»이 신호로 갈리므로 §22-7 "0이면 0으로 적는다" 원칙이 선다).
 *      draft_id가 있으면 링크(§13 "이름·가는 곳·세는 것" — kind로 목적지가 갈린다),
 *      없으면(BE가 아직 그 필드를 이 행에 안 실은 예외 케이스) 수만.
 */
export function InsightsBoardCommentsCell({
  row, t,
}: {
  row: InsightsBoardRow;
  t: ReturnType<typeof useTranslations>;
}) {
  // story #3517 조각②-b(페드루 PO 지적, 유나 프로브 오계수 2026-09-06) — 두 갈래가
  // 같은 data-testid를 써 유나의 실픽셀 프로브가 "해당 없음"과 "채널 미제공"을 한
  // 갈래로 세었다. 갈래별로 나눈다(문구는 이미 §21-2대로 달랐다 — testid만 못 갈렸다).
  if (row.kind === 'site_post') {
    return <span className="text-muted-foreground" data-testid="insights-board-comments-not-applicable">{t('insightsBoardCommentsNotApplicable')}</span>;
  }
  if (!row.comments_supported) {
    return <span className="text-muted-foreground" data-testid="insights-board-comments-channel-unsupported">{t('insightsBoardCommentsChannelUnsupported')}</span>;
  }

  if (row.comments_last_collected_at === null) {
    return <span className="text-muted-foreground" data-testid="insights-board-comments-uncollected">{t('insightsBoardCommentsUncollected')}</span>;
  }

  const label = t('commentsCountLink', { count: row.comments_count ?? 0 });
  if (row.channel_post_draft_id) {
    // row.kind==='site_post'는 위에서 이미 갈라졌다(댓글 축 자체가 없어 이 지점에
    // 도달하지 않는다) — 여기 남는 row는 항상 channel_publication.
    return (
      <Link href={`/content/channel-posts/${row.channel_post_draft_id}`} className="hover:underline" data-testid="insights-board-comments-link">
        {label}
      </Link>
    );
  }
  return <span data-testid="insights-board-comments-text">{label}</span>;
}
