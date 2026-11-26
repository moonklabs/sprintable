'use client';

// story 5036 (C6 · step ① of the onboarding's straight line): the first project — only its name is asked (the description was a second field nobody needed to
// start; it is edited in the project's own settings). It used to be the first of a three-screen wizard that only `?step=project` reached; now it is the screen a person
// lands on right after the organization is made (4715 makes that one itself, with a made name). The name starts as «첫 프로젝트» — one press moves on, and a person
// who wants another name types it. The same screen is `?step=project` (an organization exists: a new project from elsewhere) — `onCreated`
// is the page's: there it ends at home, here it goes on to step ②.

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { Field } from '@/components/ds/field';
import { Input } from '@/components/ds/input';
import { fetchWithAuth } from '@/lib/db/client';
import { isImeComposing } from '@/lib/ime-composition';
import { useAdoptPrehydrationValues } from '@/hooks/use-adopt-prehydration-values';

interface ProjectStepProps {
  orgId: string;
  /** the organization's name when this page made it (or read it) — null: not known here, the line says «첫 프로젝트» alone (never made up) */
  orgName: string | null;
  /** the project exists (made now) — the page puts it on the session and goes on */
  onCreated: (projectId: string) => void | Promise<void>;
  /** the plan's project limit answered: the page's upgrade window says it */
  onLimit: (limit: number | null) => void;
}

export function ProjectStep({ orgId, orgName, onCreated, onLimit }: ProjectStepProps) {
  const t = useTranslations('onboarding');
  const tl = useTranslations('onboarding.line');
  const tc = useTranslations('common');
  const defaultName = tl('defaultProjectName');
  const [name, setName] = useState(defaultName);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  // story 4937 — the screen the server draws (`?step=project`) shows the field before React is alive: what was typed in that window is taken into the state once
  useAdoptPrehydrationValues([{ ref: nameRef, initial: defaultName, set: setName }]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId, name: trimmed, description: null }),
      });
      const json = await res.json().catch(() => null) as { data?: { id?: string }; error?: { code?: string; limit?: number } } | null;
      if (!res.ok) {
        // story #2484 — backend projects.py create_project() answers 'PLAN_LIMIT_EXCEEDED' (resource: "project"); no other code is read, the raw message is never shown
        if (json?.error?.code === 'PLAN_LIMIT_EXCEEDED') { onLimit(json.error.limit ?? null); return; }
        setError(t('createProjectFailed'));
        return;
      }
      const id = json?.data?.id;
      if (!id) { setError(t('createProjectFailed')); return; }
      await onCreated(id);
    } catch {
      setError(t('networkError'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="onboarding-project-step">
      <div className="space-y-2 text-center">
        <h1 id="onboarding-step-title" className="break-keep text-ds-title font-semibold text-ds-ink">{t('createProject')}</h1>
        <p className="break-keep text-ds-body text-ds-ink-2">{orgName ? t('projectSubtitle', { orgName }) : t('projectSubtitleNoOrg')}</p>
      </div>
      <Field label={t('projectName')} error={error}>
        {(control) => (
          <Input
            {...control}
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              // a syllable still being composed is confirmed by Enter — that is not a press of the button (the register screen's rule)
              if (isImeComposing(e)) return;
              if (e.key === 'Enter') void submit();
            }}
            placeholder={t('projectNamePlaceholder')}
            disabled={loading}
            data-testid="onboarding-project-name"
          />
        )}
      </Field>
      <Button variant="primary" size="lg" className="w-full" loading={loading} disabled={!name.trim()} onClick={() => void submit()} data-testid="onboarding-project-create">
        {loading ? tc('creating') : t('createProjectAction')}
      </Button>
    </div>
  );
}
