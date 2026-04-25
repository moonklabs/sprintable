'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';

interface Props {
  projectId?: string;
}

export function StandupDeadlineSection({ projectId }: Props) {
  const t = useTranslations('settings');
  const [deadline, setDeadline] = useState('09:00');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    void fetch(`/api/project-settings?project_id=${projectId}`)
      .then((r) => r.ok ? r.json() : null)
      .then((json) => { if (json?.data?.standup_deadline) setDeadline(json.data.standup_deadline as string); });
  }, [projectId]);

  const handleSave = async () => {
    if (!projectId) return;
    setSaving(true);
    try {
      await fetch('/api/project-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, standup_deadline: deadline }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id="standup-settings">
      <SectionCard>
        <SectionCardHeader>
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-foreground">{t('standupSettings')}</h2>
            <p className="text-sm text-muted-foreground">{t('standupSettingsDesc')}</p>
          </div>
        </SectionCardHeader>
        <SectionCardBody>
          <div className="flex items-center gap-4">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('standupDeadline')}</label>
              <input
                type="time"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
                className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <Button size="sm" className="mt-4" onClick={handleSave} disabled={saving || !projectId}>
              {saved ? '✓ 저장됨' : saving ? '저장 중...' : t('save')}
            </Button>
          </div>
        </SectionCardBody>
      </SectionCard>
    </section>
  );
}
