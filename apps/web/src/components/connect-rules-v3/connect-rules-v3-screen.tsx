'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/db/client';
import { ConnectRulesV3Agents } from './connect-rules-v3-agents';
import { ConnectRulesV3Channels } from './connect-rules-v3-channels';
import { ConnectRulesV3Rules } from './connect-rules-v3-rules';

/**
 * story #3982(E-UX-OVERHAUL·「연결·규칙」 구현 2/N·FE) — 시안 ⑤ 그대로. 「오늘」(#3962)·
 * 「대화」(#3972) 선례와 같은 NAV_ITEMS 손 배열(공유 셸 컴포넌트가 아직 없다 — 「셸 변경은
 * 흡수 화면 착지 뒤」 원칙, 다른 v3 화면 링크는 아직 옛 화면을 가리킨다). A(외부 발행 일시
 * 중지) 절은 #4363(#3953) 착지 뒤 별도 rebase로 추가(AC7) — 이 PR엔 없음.
 *
 * org_id는 (authenticated) 밖이라 DashboardContext가 없다 — agent-management-tab.tsx가
 * 이미 하는 `fetchWithAuth('/api/me')` 1콜을 그대로 반복해 org_id만 뽑는다(새 BE 0).
 */
const NAV_ITEMS: { key: string; href: string; active?: boolean }[] = [
  { key: 'navToday', href: '/today' },
  { key: 'navChats', href: '/chats' },
  { key: 'navWork', href: '/flow' },
  { key: 'navResults', href: '/organization/insights-board' },
  { key: 'navConnectRules', href: '/connect-rules', active: true },
];

function ConnectRulesV3Nav() {
  const t = useTranslations('connectRulesV3');
  return (
    <aside className="flex w-[216px] shrink-0 flex-col border-r border-border bg-card p-3" data-testid="connect-rules-v3-nav">
      <nav className="mt-1 flex flex-col gap-0.5">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.key}
            href={item.href}
            data-testid={`connect-rules-v3-nav-${item.key}`}
            className={
              item.active
                ? 'flex items-center gap-2.5 rounded-md bg-primary/10 px-2.5 py-2 text-sm font-medium text-primary'
                : 'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted-foreground hover:bg-muted'
            }
          >
            <span className="min-w-0 flex-1 truncate">{t(item.key)}</span>
          </Link>
        ))}
      </nav>
    </aside>
  );
}

function ConnectRulesV3Topbar() {
  const t = useTranslations('connectRulesV3');
  return (
    <div className="flex h-14 shrink-0 items-center gap-4 border-b border-border bg-card px-5" data-testid="connect-rules-v3-topbar">
      <div className="flex h-[34px] max-w-[420px] flex-1 items-center gap-2 rounded-md border border-border bg-muted px-3 text-sm text-muted-foreground">
        <span>{t('searchPlaceholder')}</span>
      </div>
    </div>
  );
}

function useOrgId() {
  const [orgId, setOrgId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadError(false);
    fetchWithAuth('/api/me')
      .then((res) => (res.ok ? res.json() as Promise<{ data?: { org_id?: string } }> : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((json) => {
        if (cancelled) return;
        const id = json.data?.org_id;
        if (id) setOrgId(id); else setLoadError(true);
      })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, [retryNonce]);

  return { orgId, loadError, retry: () => setRetryNonce((n) => n + 1) };
}

export function ConnectRulesV3Screen() {
  const t = useTranslations('connectRulesV3');
  const tc = useTranslations('common');
  const { orgId, loadError, retry } = useOrgId();

  return (
    <div className="flex h-screen min-h-0 bg-muted/20" data-testid="connect-rules-v3-screen">
      <ConnectRulesV3Nav />
      <div className="flex min-w-0 flex-1 flex-col">
        <ConnectRulesV3Topbar />
        <div className="min-h-0 flex-1 overflow-auto p-6">
          <div className="mx-auto max-w-[720px] space-y-8">
            <div>
              <h1 className="mb-1 text-[22px] font-bold tracking-tight text-foreground">{t('pageTitle')}</h1>
              <p className="text-sm text-muted-foreground">{t('pageDescription')}</p>
            </div>

            {loadError ? (
              <div className="flex flex-col items-center gap-3 py-10 text-center">
                <p role="alert" className="text-sm text-destructive">{t('loadErrorTitle')}</p>
                <Button size="sm" variant="outline" onClick={retry}>{tc('retry')}</Button>
              </div>
            ) : !orgId ? (
              <div className="space-y-3" aria-hidden="true" data-testid="connect-rules-v3-loading">
                <div className="h-24 animate-pulse rounded-md bg-muted/30" />
                <div className="h-24 animate-pulse rounded-md bg-muted/30" />
              </div>
            ) : (
              <>
                <section aria-label={t('agentsSectionTitle')}>
                  <div className="mb-2.5 flex items-baseline gap-2.5">
                    <h2 className="text-sm font-semibold text-foreground">{t('agentsSectionTitle')}</h2>
                    <span className="text-[11px] text-muted-foreground">{t('agentsSectionHint')}</span>
                  </div>
                  <ConnectRulesV3Agents />
                </section>

                <section aria-label={t('channelsSectionTitle')}>
                  <div className="mb-2.5 flex items-baseline gap-2.5">
                    <h2 className="text-sm font-semibold text-foreground">{t('channelsSectionTitle')}</h2>
                    <span className="text-[11px] text-muted-foreground">{t('channelsSectionHint')}</span>
                  </div>
                  <ConnectRulesV3Channels orgId={orgId} />
                </section>

                <section aria-label={t('rulesSectionTitle')}>
                  <div className="mb-2.5 flex items-baseline gap-2.5">
                    <h2 className="text-sm font-semibold text-foreground">{t('rulesSectionTitle')}</h2>
                    <span className="text-[11px] text-muted-foreground">{t('rulesSectionHint')}</span>
                  </div>
                  <ConnectRulesV3Rules orgId={orgId} />
                </section>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
