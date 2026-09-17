'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { hrefForNeedsMeItem, type TodayNeedsMeItem } from '@/components/org-briefing/derive-today';

/**
 * story #3962 CHANGES-2(페드루 PO C2, 2026-09-16 16:08Z) — 시안 ①이 요구하는 위험
 * 등급 태그·「저위험 모아 승인」 자리는 옛 `today-sections.tsx::NeedsMeSection`에
 * 없다(그 컴포넌트는 무접촉 — org-briefing이 그대로 쓴다). v3 전용 새 컴포넌트로
 * 짓는다: risk==='high'(또는 kind==='answer')는 개별 카드, risk==='low'는 한 줄로
 * 묶는다(시안 ①의 `.lowrow` — 「모아 승인」은 자리만, 실제 벌크 승인 API는 스코프
 * 밖).
 *
 * 태그 낱말은 BE가 실제로 주는 축(risk high/low·kind answer)만 쓴다 — 시안의
 * 「외부 발송」·「광고비」같은 구체 카테고리 텍스트는 API에 대응 필드가 없어
 * 지어내지 않는다(no-fiction).
 */

const ACTION_KEY: Record<TodayNeedsMeItem['state'], string> = {
  approval: 'actionApproveOnly',
  signature: 'actionApproveAndSign',
  answer: 'actionAnswerNow',
};

function DecisionCard({ item }: { item: TodayNeedsMeItem }) {
  const t = useTranslations('todayV3');
  const tOrg = useTranslations('orgBriefing');
  const href = hrefForNeedsMeItem(item);
  return (
    <Card className="p-3.5" data-testid="today-v3-decision-card">
      <div className="mb-1.5 flex items-center gap-2">
        {item.state === 'answer' ? (
          <Badge variant="info" data-testid="today-v3-decision-tag">{t('tagQuestion')}</Badge>
        ) : item.risk === 'high' ? (
          <Badge variant="warning" data-testid="today-v3-decision-tag">{t('tagHighRisk')}</Badge>
        ) : null}
      </div>
      <p className="text-[14.5px] font-medium text-foreground">{item.workItemTitle}</p>
      {item.reason ? (
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{item.reason}</p>
      ) : item.requestedByName ? (
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{tOrg('needsMeMetaRequestedBy', { name: item.requestedByName })}</p>
      ) : null}
      <div className="mt-2.5 flex gap-1.5">
        <Button asChild size="sm">
          <Link href={href}>{tOrg(ACTION_KEY[item.state])}</Link>
        </Button>
      </div>
    </Card>
  );
}

export function TodayV3Decisions({ items, count }: { items: TodayNeedsMeItem[]; count: number }) {
  const t = useTranslations('todayV3');
  const highOrAnswer = items.filter((i) => i.risk === 'high' || i.state === 'answer');
  const lowRisk = items.filter((i) => i.risk === 'low' && i.state !== 'answer');

  return (
    <section aria-label={t('decisionsSectionTitle', { count })} data-testid="today-v3-decisions-section">
      <div className="mb-2.5 flex items-baseline gap-2.5">
        <h2 className="text-sm font-semibold text-foreground">{t('decisionsSectionTitle', { count })}</h2>
      </div>
      {items.length === 0 ? (
        <Card className="flex flex-col items-center gap-1.5 px-5 py-10 text-center">
          <p className="text-sm font-medium text-foreground">{t('decisionsEmptyTitle')}</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {highOrAnswer.map((item) => <DecisionCard key={item.id} item={item} />)}
          {lowRisk.length > 0 ? (
            <div className="flex items-center gap-2.5 rounded-md border border-border bg-muted/50 px-3.5 py-2.5" data-testid="today-v3-low-risk-row">
              <span className="text-[13px] text-foreground">{t('lowRiskGroupedLine', { count: lowRisk.length })}</span>
              {/* story #3962 CHANGES-2 — 「모아 승인」은 자리만(카드 明示 — 벌크 승인 API는
                  스코프 밖). 클릭해도 아무 일도 안 일어난다(disabled). */}
              <Button size="sm" variant="outline" className="ml-auto" disabled data-testid="today-v3-bulk-approve-action">
                {t('bulkApproveAction')}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
