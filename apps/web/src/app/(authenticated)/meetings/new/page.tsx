'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { Button } from '@/components/ui/button';
import { OperatorInput } from '@/components/ui/operator-control';
import { OperatorDropdownSelect } from '@/components/ui/operator-dropdown-select';
import { Badge } from '@/components/ui/badge';

export default function NewMeetingPage() {
  const t = useTranslations('meeting');
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [meetingType, setMeetingType] = useState('general');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 16));
  const [durationMin, setDurationMin] = useState('30');
  const [participantInput, setParticipantInput] = useState('');
  const [participants, setParticipants] = useState<Array<{ name: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');

    const res = await fetch('/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        meeting_type: meetingType,
        date: new Date(date).toISOString(),
        duration_min: Number(durationMin) || undefined,
        participants,
      }),
    });

    if (!res.ok) {
      const json = await res.json().catch(() => null);
      setError(json?.error?.message ?? 'Failed');
      if (res.status === 403 && json?.error?.code === 'UPGRADE_REQUIRED') {
        setError(t('upgradeRequired'));
      }
      setSaving(false);
      return;
    }

    const json = await res.json();
    router.push(`/meetings/${json.data.id}`);
  }

  return (
    <>
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('createMeeting')}</h1>} />

      <div className="flex min-h-0 flex-1 overflow-y-auto p-6">
        <div className="w-full max-w-lg">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                {t('title')}
              </label>
              <OperatorInput
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                {t('filter')}
              </label>
              <OperatorDropdownSelect
                value={meetingType}
                onValueChange={setMeetingType}
                options={[
                  { value: 'standup', label: t('standup') },
                  { value: 'retro', label: t('retro') },
                  { value: 'general', label: t('general') },
                  { value: 'review', label: t('review') },
                ]}
              />
            </div>

            <div className="flex gap-3">
              <div className="flex-1">
                <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  {t('dateRange')}
                </label>
                <OperatorInput
                  type="datetime-local"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </div>
              <div className="w-24">
                <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  min
                </label>
                <OperatorInput
                  type="number"
                  value={durationMin}
                  onChange={(e) => setDurationMin(e.target.value)}
                />
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                {t('participants')}
              </label>
              <OperatorInput
                type="text"
                value={participantInput}
                onChange={(e) => setParticipantInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const name = participantInput.trim();
                    if (name) {
                      setParticipants((prev) => [...prev, { name }]);
                      setParticipantInput('');
                    }
                  }
                }}
                placeholder="이름 입력 후 Enter"
              />
              {participants.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {participants.map((p, i) => (
                    <Badge key={i} variant="chip" className="flex items-center gap-1">
                      {p.name}
                      <button
                        type="button"
                        onClick={() => setParticipants((prev) => prev.filter((_, j) => j !== i))}
                        className="ml-0.5 text-muted-foreground hover:text-destructive"
                      >
                        ✕
                      </button>
                    </Badge>
                  ))}
                </div>
              ) : null}
            </div>

            {error ? <p className="text-xs text-destructive">{error}</p> : null}

            <Button type="submit" disabled={saving || !title} className="w-full">
              {saving ? '...' : t('createMeeting')}
            </Button>
          </form>
        </div>
      </div>
    </>
  );
}
