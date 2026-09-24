'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { buildGateTransitionBody, classifyGateTransitionErrorCode } from '@/lib/gate-decision-payload';
import { fetchWithAuth } from '@/lib/db/client';
import { ChatV3ReasonDialog } from './chat-v3-reason-dialog';
import { toPlainPreview } from '@/components/chat/entity-ref';
import { useFlatHref } from '@/hooks/use-flat-href';

/**
 * story #3972 AC1 그라운딩(페드루 PO 확認 2026-09-16 17:07Z) — 이 카드는 옛
 * `approval-request-card.tsx`의 인라인 승인을 재사용하지 않는다: 시안 ② 원칙
 * 「서명은 「오늘」 한 곳에서만」 — 이 카드는 배지·제목·메타 + 버튼 2뿐이다.
 * 「「오늘」에서 서명」은 인라인 승인 0(항상 링크), 「변경 요청」만 인라인(4367의
 * `buildGateTransitionBody`+사유 다이얼로그 재사용). 옛 카드 컴포넌트는 무접촉.
 *
 * 이 카드는 메시지의 `approval_target`이 있을 때만 렌더된다(그라운딩 ①: 발행
 * 승인류 게이트는 지금 이 필드 자체를 안 받는다 — 정직한 상태, 가짜 placeholder
 * 0. `dispatch_approval_request_cards`를 타는 gate_type만 이 필드를 가진다).
 */
export function ChatV3EventCard({ approvalTarget, content, isInTodayQueue, todayV3Enabled, todayHref, onDone }: {
  approvalTarget: { work_item_type: string; work_item_id: string; gate_id: string; actions?: string[] };
  // BE가 이 카드 전용으로 지은 설명 문장(dispatch_approval_request_cards가 채운
  // message.content) — 제목을 새로 지어내지 않고 그대로 옮긴다(work_item 제목은
  // approval_target에 없어 추가 콜 없이는 못 얻는다, no-fiction).
  content: string;
  // 페드루 PO 지시(2026-09-17 00:08Z, PR #4370 CHANGES) — 서명은 「오늘」 한 곳에서만
  // (시안 SSOT) → 링크는 `/today`(게이트 상세 아님). 이 게이트가 보는 사람의 오늘
  // 큐(needsMe)에 없으면 눌러도 거기 없는 막다른 길이라 서명 버튼 자체를 숨긴다.
  isInTodayQueue: boolean;
  // story #3972 CHANGES(페드루 PO 2026-09-17 01:54Z, 실결함) — TODAY_V3_ENABLED
  // OFF면 `/today` 자체가 404 — 옛 게이트 상세(`/gates/{id}`, 이 카드가 v3
  // 원칙으로 걷기 前 서명 자리)로 되돌린다.
  todayV3Enabled: boolean;
  // story #4004 CHANGES 1 — ChatV3Screen이 실 flags로 구한 값을 그대로 받는다(가짜
  // flags 조합으로 다시 조립 0).
  todayHref: string;
  onDone: () => void;
}) {
  const flatHref = useFlatHref(); // story #4231 — flat 링크 `?p=`
  const t = useTranslations('chatV3');
  const tc = useTranslations('common');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (reason: string) => {
    setBusy(true);
    setError(null);
    const res = await fetchWithAuth(`/api/gates/${approvalTarget.gate_id}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildGateTransitionBody({ status: 'rejected', note: reason })),
    });
    if (res.ok) { setBusy(false); setDialogOpen(false); onDone(); return; }
    // 페드루 PO CHANGES C3(2026-09-17 00:04Z, PR #4370) — gate_already_resolved(남이
    // 먼저 처리)는 실패가 아니라 재조회로 흡수한다(#3964/#3970과 같은 결).
    const body = await res.json().catch(() => null) as { error?: { code?: string } } | null;
    setBusy(false);
    if (classifyGateTransitionErrorCode(body?.error?.code) === 'already_resolved') {
      setDialogOpen(false);
      onDone();
    } else {
      setError(t('eventCardActionFailed'));
    }
  };

  return (
    <Card className="max-w-md border-warning-border bg-warning-tint p-3.5" data-testid="chat-v3-event-card">
      <Badge variant="warning" className="mb-1.5">{t('eventCardBadge')}</Badge>
      {/* story #4187 — 카드 제목 자리(메시지 원문을 옮긴 한 줄 요약)도 미리보기 변환을 거친다 — 내부 HTML 주석·
          마크다운 링크 문법이 제목에 새지 않게(스레드 레일 미리보기와 같은 규칙, entity-ref.ts SSOT). */}
      <p className="text-sm font-medium text-foreground">{toPlainPreview(content)}</p>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {isInTodayQueue ? (
          <Button asChild size="sm">
            {/* story #4004 — OFF 폴백(/gates/{id})은 이 카드 고유 맥락(v3 걷기 前
                서명 자리)이라 목적지 모듈이 정할 대상이 아니다 — 그대로 유지. */}
            <Link
              href={todayV3Enabled ? todayHref : flatHref(`/gates/${approvalTarget.gate_id}`)}
              data-testid="chat-v3-event-card-sign"
            >
              {t('eventCardSignAction')}
            </Link>
          </Button>
        ) : null}
        <Button
          size="sm" variant="outline" disabled={busy}
          onClick={() => setDialogOpen(true)}
          data-testid="chat-v3-event-card-request-changes"
        >
          {t('eventCardRequestChangesAction')}
        </Button>
      </div>
      <ChatV3ReasonDialog
        open={dialogOpen}
        onOpenChange={(next) => { if (!next) { setDialogOpen(false); setError(null); } }}
        title={t('reasonDialogRequestChangesTitle')}
        placeholder={t('reasonDialogRequestChangesPlaceholder')}
        submitLabel={t('eventCardRequestChangesAction')}
        cancelLabel={tc('cancel')}
        reasonRequired
        submitting={busy}
        error={error}
        onSubmit={submit}
      />
    </Card>
  );
}
