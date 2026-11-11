'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { Button } from '@/components/ds/button';
import { Field } from '@/components/ds/field';
import { Input } from '@/components/ds/input';
import { SettingsSection } from './settings-section';
import { fetchWithAuth } from '@/lib/db/client';

interface Props {
  projectId?: string;
}

export function StandupDeadlineSection({ projectId }: Props) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const [deadline, setDeadline] = useState('09:00');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    void fetchWithAuth(`/api/project-settings?project_id=${projectId}`)
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
      <SettingsSection title={t('standupSettings')} description={t('standupSettingsDesc')}>
        {/* story 4891: the deadline is a ds Field + Input (a phone press ≥ 44: the field is 44 on touch), the save is the ds Button — same value, same PATCH, same «saved» word */}
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('standupDeadline')} className="w-40">
            {(control) => <Input {...control} type="time" value={deadline} onChange={(e) => setDeadline(e.target.value)} className="touch:h-11" />}
          </Field>
          <Button variant="primary" size="lg" onClick={handleSave} disabled={saving || !projectId}>
            {saved ? <><Check className="size-4" />{tc('saved')}</> : saving ? tc('saving') : t('save')}
          </Button>
        </div>
      </SettingsSection>
    </section>
  );
}
