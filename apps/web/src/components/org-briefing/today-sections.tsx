'use client';

import Link from 'next/link';
import { FileText, HelpCircle, PenLine } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { formatCount } from '@/components/content/generation-budget-indicator';
import {
  hrefForNeedsMeItem,
  type NeedsMeState,
  type TodayAgentProgressItem,
  type TodayNeedsMeItem,
  type TodayPublished,
  type TodayUsage,
} from './derive-today';

// story #3831(UX-v3·FE 3·오늘) — 낱말 표 §① 상태 3어(PO 確定 2026-09-13 09:43Z) 매핑.
// 돈·외부 발송 구분은 pill로 안 가른다(API가 그 축을 모른다, gap3 판정 그대로) — 필요하면
// reason/title 줄이 이미 그 맥락을 담는다.
const STATE_META: Record<NeedsMeState, { pillKey: string; actionKey: string; icon: typeof FileText }> = {
  approval: { pillKey: 'stateAwaitingApproval', actionKey: 'actionApproveOnly', icon: FileText },
  signature: { pillKey: 'stateAwaitingSignature', actionKey: 'actionApproveAndSign', icon: PenLine },
  answer: { pillKey: 'stateAwaitingAnswer', actionKey: 'actionAnswerNow', icon: HelpCircle },
};

const AGENT_STATUS_KEY: Record<string, string> = {
  queued: 'agentStatusQueued',
  held: 'agentStatusHeld',
  running: 'agentStatusRunning',
  hitl_pending: 'agentStatusHitlPending',
};

function NeedsMeRow({ item }: { item: TodayNeedsMeItem }) {
  const t = useTranslations('orgBriefing');
  const meta = STATE_META[item.state];
  const Icon = meta.icon;
  const href = hrefForNeedsMeItem(item);
  return (
    <div className="flex items-start gap-3 border-t border-border px-3 py-3 first:border-t-0">
      <Icon className="mt-0.5 size-[18px] shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="min-w-0 truncate text-[13.5px] font-medium text-foreground">{item.workItemTitle}</span>
          <Badge variant="info" className="shrink-0">{t(meta.pillKey)}</Badge>
        </div>
        {item.reason ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{item.reason}</p>
        ) : item.requestedByName ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{t('needsMeMetaRequestedBy', { name: item.requestedByName })}</p>
        ) : null}
        {/* story #3831 AC1 무엇⑤ — 위험 문구는 서명 대기 상태에서만(돈·외부 발송 공통). */}
        {item.state === 'signature' ? (
          <p className="mt-0.5 text-[11px] text-muted-foreground">{t('signatureRiskNotice')}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <Link
          href={href}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          {t(meta.actionKey)}
        </Link>
        {/* story #3831 AC4 — conversation_id 있는 행만 「대화 열기」(3828 develop 착지,
            라이브 dev-app은 배포 86 뒤 반영). 있으면 짓지 않고 실 id로만 연다. */}
        {item.conversationId ? (
          <Link href={`/chats/${item.conversationId}`} className="text-[11px] text-primary hover:underline">
            {t('conversationOpenLink')}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export function NeedsMeSection({ items, count }: { items: TodayNeedsMeItem[]; count: number }) {
  const t = useTranslations('orgBriefing');
  return (
    <section aria-label={t('needsMeSectionTitle', { count })}>
      <div className="mb-2.5 flex items-baseline gap-2.5">
        <h2 className="text-sm font-semibold text-foreground">{t('needsMeSectionTitle', { count })}</h2>
        {items.length > 0 ? <span className="text-[11px] text-muted-foreground">{t('needsMeHint')}</span> : null}
      </div>
      {items.length === 0 ? (
        <Card className="flex flex-col items-center gap-1.5 px-5 py-10 text-center">
          <p className="text-sm font-medium text-foreground">{t('needsMeEmptyTitle')}</p>
        </Card>
      ) : (
        <Card>{items.map((item) => <NeedsMeRow key={item.id} item={item} />)}</Card>
      )}
    </section>
  );
}

function AgentProgressRow({ item }: { item: TodayAgentProgressItem }) {
  const t = useTranslations('orgBriefing');
  const statusKey = AGENT_STATUS_KEY[item.status] ?? 'agentStatusRunning';
  return (
    <div className="flex items-center gap-3 border-t border-border px-3 py-3 first:border-t-0">
      <span className="size-2 shrink-0 rounded-full bg-info" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium text-foreground">
          {item.workItemTitle ?? item.agentName}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {item.agentName} · {t(statusKey)}
        </span>
      </div>
    </div>
  );
}

export function AgentProgressSection({ items }: { items: TodayAgentProgressItem[] }) {
  const t = useTranslations('orgBriefing');
  return (
    <section aria-label={t('agentProgressSectionTitle')}>
      <div className="mb-2.5 flex items-baseline gap-2.5">
        <h2 className="text-sm font-semibold text-foreground">{t('agentProgressSectionTitle')}</h2>
        {items.length > 0 ? (
          <span className="text-[11px] text-muted-foreground">{t('agentProgressInProgressBadge', { count: items.length })}</span>
        ) : null}
      </div>
      {items.length === 0 ? (
        <Card className="flex flex-col items-center gap-1.5 px-5 py-10 text-center">
          <p className="text-sm font-medium text-foreground">{t('agentProgressEmptyTitle')}</p>
        </Card>
      ) : (
        <Card>{items.map((item) => <AgentProgressRow key={item.runId} item={item} />)}</Card>
      )}
    </section>
  );
}

export function PublishedSection({ published, usage }: { published: TodayPublished; usage: TodayUsage }) {
  const t = useTranslations('orgBriefing');
  const locale = useLocale();
  const isEmpty = published.count === 0 && usage.platform.length === 0;
  return (
    <section aria-label={t('sectionPublishedTitle')}>
      <div className="mb-2.5 flex items-baseline gap-2.5">
        <h2 className="text-sm font-semibold text-foreground">{t('sectionPublishedTitle')}</h2>
        <span className="text-[11px] text-muted-foreground">{t('publishedHint')}</span>
      </div>
      {isEmpty ? (
        <Card className="flex flex-col items-center gap-1.5 px-5 py-10 text-center">
          <p className="text-sm font-medium text-foreground">{t('publishedEmptyTitle')}</p>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {published.count > 0 ? (
            <Card className="p-3.5">
              <p className="text-[11px] text-muted-foreground">{t('publishedCountLabel')}</p>
              <p className="mt-1 text-lg font-semibold text-foreground">{formatCount(published.count, locale)}</p>
              {published.byChannel.length > 0 ? (
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {published.byChannel.map((c) => `${c.channelKind} ${formatCount(c.count, locale)}`).join(' · ')}
                </p>
              ) : null}
            </Card>
          ) : null}
          {usage.platform.map((p) => (
            <Card key={p.connectionId} className="p-3.5">
              <p className="text-[11px] text-muted-foreground">{p.channelKind}</p>
              <p className="mt-1 text-lg font-semibold text-foreground">
                {formatCount(p.used, locale)}/{formatCount(p.limit, locale)}
              </p>
            </Card>
          ))}
          {!usage.adSpendMeasured ? (
            <Card className="p-3.5">
              <p className="text-[11px] text-muted-foreground">{t('adSpendLabel')}</p>
              <p className="mt-1 text-lg font-semibold text-foreground">{t('adSpendNotMeasured')}</p>
            </Card>
          ) : null}
        </div>
      )}
    </section>
  );
}
