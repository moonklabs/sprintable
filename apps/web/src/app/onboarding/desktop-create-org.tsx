'use client';

// story 4427 (PO 2026-09-30 01:04Z · grounding doc 382d7915 option (가) · Yuna design f6cfda19 — its copy table is canonical).
// A new user who signed in from the desktop app and has no organization yet sees this one screen instead of the four-step
// onboarding: organization and first project names are filled in, one «만들기» creates both, and they go straight back to the
// desktop setup page (`next`). The organization's slug is made by the server (no slug field). The agent and connect steps
// are not shown — the setup page's «시작» and the desktop app do that part.
// Sign-ups that did not come from the desktop keep the usual onboarding (page.tsx picks this only with a valid `next`).

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { OperatorInput } from '@/components/ui/operator-control';
import { SectionCard } from '@/components/ui/section-card';
import { fetchWithAuth } from '@/lib/db/client';
import { withProjectParam } from '@/hooks/use-flat-href';

/** A display name longer than this is not used in the default (Yuna f6cfda19: «40자 넘으면 «내 조직»»). */
export const DEFAULT_NAME_MAX = 40;

/** The default organization name: «{name}의 조직» from the profile display name, or «내 조직» — never the e-mail's local part. */
export function defaultOrgName(displayName: string | null | undefined, withName: (name: string) => string, fallback: string): string {
  const name = (displayName ?? '').trim();
  return name && name.length <= DEFAULT_NAME_MAX ? withName(name) : fallback;
}

interface DesktopCreateOrgProps {
  /** Where to go once both exist — only ever `/desktop/setup` (page.tsx checks it). */
  next: string;
}

export function DesktopCreateOrg({ next }: DesktopCreateOrgProps) {
  const t = useTranslations('desktopOnboarding');
  const to = useTranslations('onboarding');
  const [orgName, setOrgName] = useState('');
  const [projectName, setProjectName] = useState(() => t('defaultProjectName'));
  const orgTouchedRef = useRef(false);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // The default organization name needs the display name, which only /api/auth/me knows; until it answers the field shows
  // «내 조직». A name the person already typed is never replaced.
  useEffect(() => {
    let cancelled = false;
    const fallback = t('defaultOrgName');
    setOrgName((prev) => prev || fallback);
    fetchWithAuth('/api/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { data?: { display_name?: string | null } } | null) => {
        if (cancelled || orgTouchedRef.current) return;
        setOrgName(defaultOrgName(json?.data?.display_name, (name) => t('defaultOrgNameWithName', { name }), fallback));
      })
      .catch(() => { /* keep «내 조직» */ });
    return () => { cancelled = true; };
  }, [t]);
  const orgMissing = !orgName.trim();
  const projectMissing = !projectName.trim();
  const canCreate = !loading && !orgMissing && !projectMissing;

  const handleCreate = async () => {
    if (!canCreate) return;
    setLoading(true);
    setError('');
    try {
      // The organization first — once it exists a retry only makes the project (never a second organization).
      let createdOrgId = orgId;
      if (!createdOrgId) {
        const res = await fetchWithAuth('/api/organizations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: orgName.trim() }), // no slug: the server derives it (story 4427)
        });
        const json = await res.json();
        if (!res.ok) {
          // the same messages as the usual onboarding (Yuna: «같은 오류는 같은 말»)
          if (json?.error?.code === 'EMAIL_VERIFICATION_REQUIRED') setError(to('emailVerifyRequiredError'));
          else if (json?.error?.code === 'PLAN_LIMIT_EXCEEDED') setError(to('orgLimitExceededError', { limit: json.error.limit ?? 1 }));
          else setError(to('createOrgFailed'));
          return;
        }
        createdOrgId = json.data.id as string;
        setOrgId(createdOrgId);
        // the new JWT must carry the organization before the project call (same as the usual onboarding)
        await fetchWithAuth('/api/auth/refresh', { method: 'POST' }).catch(() => null);
      }

      const res = await fetchWithAuth('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: createdOrgId, name: projectName.trim(), description: null }),
      });
      const json = await res.json();
      if (!res.ok || !json?.data) {
        if (json?.error?.code === 'PLAN_LIMIT_EXCEEDED') setError(to('projectLimitExceededError', { limit: json.error.limit ?? 1 }));
        else setError(to('createProjectFailed'));
        return;
      }
      await fetchWithAuth('/api/current-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: json.data.id }),
      }).catch(() => null);
      // refresh again so the setup page's confirm (get_verified_org_id) sees the organization, then back to it
      await fetchWithAuth('/api/auth/refresh', { method: 'POST' }).catch(() => null);
      // back to the setup page carrying the new project (same as the usual onboarding's first landing · flat-link ratchet)
      window.location.href = withProjectParam(next, json.data.id);
    } catch {
      setError(to('networkError'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <SectionCard className="w-full max-w-md space-y-6 p-6 sm:p-8" aria-labelledby="desktop-create-org-title">
        <header>
          <p className="text-xs text-muted-foreground">{t('eyebrow')}</p>
          <h1 id="desktop-create-org-title" className="mt-1 text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('lead')}</p>
        </header>

        {error && (
          <div role="alert" aria-live="assertive" aria-atomic="true" className="rounded-lg border border-destructive/20 bg-destructive-tint p-3 text-sm text-foreground">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="desktop-org-name" className="text-sm font-medium text-foreground">{t('orgLabel')}</label>
            <OperatorInput
              id="desktop-org-name"
              type="text"
              value={orgName}
              onChange={(e) => { orgTouchedRef.current = true; setOrgName(e.target.value); }}
              disabled={loading || orgId !== null}
            />
            {orgMissing && <p className="text-xs text-muted-foreground">{t('orgRequired')}</p>}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="desktop-project-name" className="text-sm font-medium text-foreground">{t('projectLabel')}</label>
            <OperatorInput
              id="desktop-project-name"
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              disabled={loading}
            />
            {projectMissing && <p className="text-xs text-muted-foreground">{t('projectRequired')}</p>}
          </div>
        </div>

        <div>
          <Button type="button" className="w-full" disabled={!canCreate} onClick={() => void handleCreate()}>
            {loading ? t('creating') : t('create')}
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">{t('returnNote')}</p>
        </div>

        <p className="border-t border-border pt-3 text-xs text-muted-foreground">{t('inviteNote')}</p>
      </SectionCard>
    </div>
  );
}

