'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ExternalLink, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/**
 * E-GHAPP 연동 카드 — GitHub App(canonical·slack 옛 loud 스타일 미러 금지). 재사용(slack/mcp follow-up).
 * status=GET /api/integrations/github/status(Bot-L.2·{connected,account_login,repository_selection,suspended}).
 * connect=/api/integrations/github/connect→install/start 302. 해제 BE 부재 → GitHub 설정 링크 안내(후속).
 */

interface GithubStatus {
  connected: boolean;
  account_login?: string | null;
  repository_selection?: string | null; // 'all' | 'selected'
  suspended?: boolean;
}

// GitHub mark(브랜드 아이콘 lucide 미export → 정확 mark inline SVG). muted 박스.
function GithubMark() {
  return (
    <svg viewBox="0 0 16 16" className="size-5 text-foreground" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function IntegrationCard() {
  const t = useTranslations('settings');
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void fetch('/api/integrations/github/status')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((json) => {
        if (!alive) return;
        const s = ((json as { data?: GithubStatus } | null)?.data ?? json) as GithubStatus | null;
        setStatus(s ?? { connected: false });
        setLoading(false);
      });
    return () => { alive = false; };
  }, []);

  const connected = status?.connected === true;
  const repoLabel = status?.repository_selection === 'all' ? t('ghRepoAll')
    : status?.repository_selection === 'selected' ? t('ghRepoSelected') : null;

  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
        <GithubMark />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{t('ghAppTitle')}</span>
          {loading ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          ) : connected ? (
            <Badge variant="success">{t('ghStatusConnected')}</Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">{t('ghStatusDisconnected')}</Badge>
          )}
          {connected && status?.suspended ? (
            <Badge variant="warning">{t('ghStatusSuspended')}</Badge>
          ) : null}
        </div>
        {connected ? (
          <p className="text-xs text-muted-foreground">
            {status?.account_login ? <span className="text-foreground">@{status.account_login}</span> : null}
            {repoLabel ? <span> · {repoLabel}</span> : null}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{t('ghConnectDesc')}</p>
        )}
      </div>
      <div className="shrink-0">
        {loading ? null : connected ? (
          // 해제 BE 부재 → GitHub 설치 설정서 관리(후속 BE 시 인앱 [해제]).
          <a
            href="https://github.com/settings/installations"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground"
          >
            {t('ghManageOnGithub')}<ExternalLink className="size-3" />
          </a>
        ) : (
          <Button size="sm" onClick={() => { window.location.href = '/api/integrations/github/connect'; }}>
            {t('ghConnectCta')}
          </Button>
        )}
      </div>
    </div>
  );
}
