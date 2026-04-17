'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

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
      // AC8: feature gating error
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
    <div className="mx-auto max-w-lg p-6">
      <h1 className="mb-6 text-xl font-bold text-gray-900">{t('createMeeting')}</h1>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="text-xs font-medium text-gray-500">{t('title')}</label>
          <input type="text" value={title} onChange={e => setTitle(e.target.value)} required className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500">{t('filter')}</label>
          <select value={meetingType} onChange={e => setMeetingType(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm">
            <option value="standup">{t('standup')}</option>
            <option value="retro">{t('retro')}</option>
            <option value="general">{t('general')}</option>
            <option value="review">{t('review')}</option>
          </select>
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="text-xs font-medium text-gray-500">{t('dateRange')}</label>
            <input type="datetime-local" value={date} onChange={e => setDate(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" />
          </div>
          <div className="w-24">
            <label className="text-xs font-medium text-gray-500">min</label>
            <input type="number" value={durationMin} onChange={e => setDurationMin(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" />
          </div>
        </div>
        {/* AC6: 참석자 입력 */}
        <div>
          <label className="text-xs font-medium text-gray-500">{t('participants')}</label>
          <div className="mt-1 flex gap-2">
            <input type="text" value={participantInput} onChange={e => setParticipantInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); const name = participantInput.trim(); if (name) { setParticipants(prev => [...prev, { name }]); setParticipantInput(''); } } }}
              placeholder="Enter name + Enter" className="flex-1 rounded-lg border px-3 py-2 text-sm" />
          </div>
          {participants.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {participants.map((p, i) => (<span key={i} className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs">{p.name}<button onClick={() => setParticipants(prev => prev.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-500">✕</button></span>))}
            </div>
          )}
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <button type="submit" disabled={saving || !title} className="w-full rounded-lg bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          {saving ? '...' : t('createMeeting')}
        </button>
      </form>
    </div>
  );
}
