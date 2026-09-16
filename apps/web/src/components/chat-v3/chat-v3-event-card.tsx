'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { buildGateTransitionBody } from '@/lib/gate-decision-payload';
import { ChatV3ReasonDialog } from './chat-v3-reason-dialog';

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
export function ChatV3EventCard({ approvalTarget, content, onDone }: {
  approvalTarget: { work_item_type: string; work_item_id: string; gate_id: string; actions?: string[] };
  // BE가 이 카드 전용으로 지은 설명 문장(dispatch_approval_request_cards가 채운
  // message.content) — 제목을 새로 지어내지 않고 그대로 옮긴다(work_item 제목은
  // approval_target에 없어 추가 콜 없이는 못 얻는다, no-fiction).
  content: string;
  onDone: () => void;
}) {
  const t = useTranslations('chatV3');
  const tc = useTranslations('common');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (reason: string) => {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/gates/${approvalTarget.gate_id}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildGateTransitionBody({ status: 'rejected', note: reason })),
    });
    setBusy(false);
    if (res.ok) { setDialogOpen(false); onDone(); } else { setError(t('eventCardActionFailed')); }
  };

  return (
    <Card className="max-w-md border-amber-200 bg-amber-50 p-3.5" data-testid="chat-v3-event-card">
      <Badge variant="warning" className="mb-1.5">{t('eventCardBadge')}</Badge>
      <p className="text-sm font-medium text-foreground">{content}</p>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <Button asChild size="sm">
          <Link href={`/gates/${approvalTarget.gate_id}`}>{t('eventCardSignAction')}</Link>
        </Button>
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
