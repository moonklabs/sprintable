'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { GitPullRequest, ExternalLink, X, Plus, AlertTriangle, Check, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/**
 * E-GHAPP Bot-L.2 — in-app PR↔story 명시연결 관리 UI(story 상세 = 관리 홈). 2-tier 강한 분리:
 *   · 연결됨(canonical·confidence=high·explicit/sid-exact): close-on-merge 대상·solid 행.
 *   · 추천 후보(suggestion·med/low): dashed 분리·기본 비활성·명시 confirm해야 explicit 승격(POST).
 * anti-IDOR(산티아고 findings): repo owner=org installation account 강제(BE 2층·generic 404)·
 *   중립 에러 카피(존재/oracle 누설 0)·repo owner는 account_login으로 고정(임의 owner 불가).
 *
 * BE 계약(grounded): status=GET /api/integrations/github/status{connected,account_login}.
 *   POST /api/integrations/github/links{story_id,repo_full_name,pr_number}→{id,...,link_source,confidence}.
 *   GET ?story_id= 리스트·DELETE /{id}=Bot-L.2-BE #1672(design-first·POST 응답형 미러 가정).
 */

interface PrLink {
  id: string;
  story_id?: string;
  repo_full_name: string;
  pr_number: number;
  link_source: string; // 'explicit' | 'auto' | 'sid'
  confidence: string; // 'high' | 'med' | 'low'
}

interface GithubStatus {
  connected: boolean;
  account_login?: string | null;
}

const prUrl = (repo: string, pr: number) => `https://github.com/${repo}/pull/${pr}`;

export function PrLinkSection({ storyId }: { storyId: string }) {
  const t = useTranslations('githubLinks');
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [links, setLinks] = useState<PrLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null); // unlink/promote 중인 link id
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repoName, setRepoName] = useState('');
  const [prNum, setPrNum] = useState('');

  const loadLinks = useCallback(async () => {
    const res = await fetch(`/api/integrations/github/links?story_id=${storyId}`)
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .catch(() => ({ data: [] }));
    // 방어적 언랩(가디언 ②·[[envelope-boundary]]): 프록시가 apiSuccess로 1회 감싸므로 res.data.
    // BE GET이 bare array면 res.data=array, 이미 {data:[]} enveloped면 res.data.data=array — 둘 다 커버.
    const payload = (res?.data ?? res) as unknown;
    const rows = Array.isArray(payload)
      ? (payload as PrLink[])
      : Array.isArray((payload as { data?: unknown })?.data)
        ? ((payload as { data: PrLink[] }).data)
        : [];
    setLinks(rows);
  }, [storyId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const st = await fetch('/api/integrations/github/status')
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      const s = (st?.data ?? st) as GithubStatus | null;
      setStatus(s ?? { connected: false });
      if (s?.connected) await loadLinks();
    } finally {
      setLoading(false);
    }
  }, [loadLinks]);

  useEffect(() => { void load(); }, [load]);

  const addLink = async (repoFullName: string, prNumber: number) => {
    setError(null);
    const res = await fetch('/api/integrations/github/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ story_id: storyId, repo_full_name: repoFullName, pr_number: prNumber }),
    }).catch(() => null);
    if (!res || !res.ok) {
      setError(t('errorAddGeneric')); // 중립(존재/권한 누설 0)
      return false;
    }
    await loadLinks();
    return true;
  };

  const onAddSubmit = async () => {
    const owner = status?.account_login?.trim();
    const repo = repoName.trim();
    const pr = Number.parseInt(prNum, 10);
    if (!owner || !repo || !Number.isInteger(pr) || pr <= 0) return;
    setAdding(true);
    try {
      const ok = await addLink(`${owner}/${repo}`, pr);
      if (ok) { setRepoName(''); setPrNum(''); }
    } finally {
      setAdding(false);
    }
  };

  const promote = async (link: PrLink) => {
    setBusyId(link.id);
    try {
      // 추천 후보 → 명시 연결 승격(explicit/high). BE upsert가 동일 (repo,pr,story)를 explicit로 갱신.
      await addLink(link.repo_full_name, link.pr_number);
    } finally {
      setBusyId(null);
    }
  };

  const unlink = async (link: PrLink) => {
    setBusyId(link.id);
    setError(null);
    try {
      const res = await fetch(`/api/integrations/github/links/${link.id}`, { method: 'DELETE' }).catch(() => null);
      if (!res || !res.ok) {
        setError(t('errorUnlinkGeneric')); // oracle 방지
        return;
      }
      await loadLinks();
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        {t('loading')}
      </div>
    );
  }

  // ── connect-prompt(installation 0): 링크 UI 대신 warning-tint 박스 + [연결하기](Bot-S 설치 flow)
  if (!status?.connected) {
    return (
      <section aria-label={t('sectionLabel')} className="space-y-2">
        <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <GitPullRequest className="size-3.5" />
          {t('sectionLabel')}
        </h3>
        {/* 중립 tint(가디언 ④): GitHub=옵셔널 통합·미연결은 "문제" 아님 → amber 금지(비-GitHub org 노이즈 차단). */}
        <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-xs font-medium text-foreground">{t('connectPromptTitle')}</p>
          <p className="text-[11px] text-muted-foreground">{t('connectPromptBody')}</p>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1"
            onClick={() => { window.location.href = '/api/integrations/github/connect'; }}
          >
            <GitPullRequest className="size-3.5" />
            {t('connectCta')}
          </Button>
        </div>
      </section>
    );
  }

  const canonical = links.filter((l) => l.confidence === 'high');
  const suggestions = links.filter((l) => l.confidence !== 'high');

  return (
    <section aria-label={t('sectionLabel')} className="space-y-2">
      <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground">
        <GitPullRequest className="size-3.5" />
        {t('sectionLabel')}
      </h3>

      {/* 연결됨(canonical) — close-on-merge 대상 */}
      {canonical.length > 0 ? (
        <ul className="space-y-1.5">
          {canonical.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/20 p-2 text-[11px]">
              <a
                href={prUrl(l.repo_full_name, l.pr_number)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-w-0 items-center gap-1 font-medium text-foreground hover:underline"
              >
                <GitPullRequest className="size-3 shrink-0" />
                <span className="truncate">{l.repo_full_name} #{l.pr_number}</span>
                <ExternalLink className="size-2.5 shrink-0 text-muted-foreground" />
              </a>
              {l.link_source === 'explicit' ? (
                <Badge variant="default" className="shrink-0">{t('sourceExplicit')}</Badge>
              ) : (
                <Badge variant="outline" className="shrink-0">{t('sourceAuto')}</Badge>
              )}
              <span className="inline-flex shrink-0 items-center gap-0.5 text-success">
                <Check className="size-3" />
                {t('confidenceConfirmed')}
              </span>
              <button
                type="button"
                onClick={() => void unlink(l)}
                disabled={busyId === l.id}
                aria-label={t('unlinkAria')}
                className="ml-auto inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
              >
                {busyId === l.id ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {/* 추천 후보(suggestion·med/low) — 강하게 분리·기본 비활성·명시 confirm해야 승격 */}
      {suggestions.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">{t('suggestionLabel')}</p>
          <ul className="space-y-1.5">
            {suggestions.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border bg-muted/10 p-2 text-[11px]">
                <a
                  href={prUrl(l.repo_full_name, l.pr_number)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-w-0 items-center gap-1 text-muted-foreground hover:underline"
                >
                  <GitPullRequest className="size-3 shrink-0" />
                  <span className="truncate">{l.repo_full_name} #{l.pr_number}</span>
                  <ExternalLink className="size-2.5 shrink-0" />
                </a>
                <span className="inline-flex shrink-0 items-center gap-1 text-warning">
                  <span aria-hidden className="size-1.5 rounded-full bg-warning" />
                  {t('estimated', { confidence: l.confidence })}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto h-6 shrink-0 gap-1 text-[11px]"
                  disabled={busyId === l.id}
                  onClick={() => void promote(l)}
                >
                  {busyId === l.id ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
                  {t('promoteCta')}
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-muted-foreground/70">{t('promoteHint')}</p>
        </div>
      ) : null}

      {canonical.length === 0 && suggestions.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t('empty')}</p>
      ) : null}

      {/* 추가 — owner는 installation account(account_login)로 고정(타owner 불가·anti-IDOR), repo명+PR# 입력 */}
      <div className="flex flex-wrap items-end gap-2 pt-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 rounded-lg border border-border bg-background px-2 py-1 text-[11px]">
          <span className="shrink-0 font-mono text-muted-foreground">{status.account_login}/</span>
          <input
            value={repoName}
            onChange={(e) => setRepoName(e.target.value)}
            placeholder={t('repoPlaceholder')}
            aria-label={t('repoAria')}
            className="min-w-0 flex-1 bg-transparent font-mono text-foreground outline-none placeholder:text-muted-foreground/50"
          />
        </div>
        <div className="flex shrink-0 items-center gap-1 rounded-lg border border-border bg-background px-2 py-1 text-[11px]">
          <span className="shrink-0 text-muted-foreground">#</span>
          <input
            value={prNum}
            onChange={(e) => setPrNum(e.target.value.replace(/[^0-9]/g, ''))}
            inputMode="numeric"
            placeholder={t('prPlaceholder')}
            aria-label={t('prAria')}
            className="w-16 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/50"
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 gap-1"
          disabled={adding || !repoName.trim() || !prNum.trim()}
          onClick={() => void onAddSubmit()}
        >
          {adding ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
          {t('addCta')}
        </Button>
      </div>

      <p className="text-[10px] text-muted-foreground/70">{t('riskHint')}</p>
      {error ? (
        <p className="inline-flex items-center gap-1 text-[11px] text-destructive">
          <AlertTriangle className="size-3 shrink-0" />
          {error}
        </p>
      ) : null}
    </section>
  );
}
