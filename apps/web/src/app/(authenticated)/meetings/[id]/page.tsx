'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import ReactMarkdown from 'react-markdown';
import { AudioRecorder } from '@/components/meetings/audio-recorder';
import { AiSummarizeButton } from '@/components/meetings/ai-summarize-button';
import { RouteErrorState } from '@/components/ui/route-error-state';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { useUpgradeGuard } from '@/hooks/use-upgrade-guard';
import { readApiClientError } from '@/lib/api-client-error';

interface Decision { id: string; text: string; owner?: string; linked_story_id?: string | null }
interface ActionItem { id: string; text: string; assignee?: string; due_date?: string; status?: string }

interface MeetingDetail {
  id: string;
  title: string;
  meeting_type: string;
  date: string;
  duration_min: number | null;
  participants: Array<{ name?: string }>;
  raw_transcript: string | null;
  ai_summary: string | null;
  decisions: Decision[];
  action_items: ActionItem[];
  recording_url?: string | null;
}

export default function MeetingDetailPage() {
  const t = useTranslations('meeting');
  const tc = useTranslations('common');
  const params = useParams();
  const router = useRouter();
  const meetingId = params.id as string;

  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const [creatingStoryId, setCreatingStoryId] = useState<string | null>(null);
  const [editingTranscript, setEditingTranscript] = useState(false);
  const [transcriptDraft, setTranscriptDraft] = useState('');
  const [savingTranscript, setSavingTranscript] = useState(false);
  const [editingSummary, setEditingSummary] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState('');
  const [savingSummary, setSavingSummary] = useState(false);
  const { guardedFetch, triggerUpgrade } = useUpgradeGuard();

  const updateMeeting = useCallback(async (patch: Partial<MeetingDetail>, fallbackMessage: string) => {
    const response = await fetch(`/api/meetings/${meetingId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });

    if (!response.ok) {
      const payload = await readApiClientError(response, fallbackMessage);
      throw new Error(payload.message);
    }

    const json = await response.json().catch(() => null);
    return (json?.data ?? null) as MeetingDetail | null;
  }, [meetingId]);

  const loadMeeting = useCallback(async () => {
    setLoading(true);
    setLoadError(null);

    try {
      const response = await fetch(`/api/meetings/${meetingId}`, { cache: 'no-store' });
      if (!response.ok) {
        if (response.status === 404) {
          setMeeting(null);
          return;
        }
        const payload = await readApiClientError(response, t('loadFailed'));
        throw new Error(payload.message);
      }

      const json = await response.json().catch(() => null);
      setMeeting((json?.data ?? null) as MeetingDetail | null);
    } catch (error) {
      setMeeting(null);
      setLoadError(error instanceof Error ? error.message : t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [meetingId, t]);

  const runMeetingAction = useCallback(async (task: () => Promise<void>, fallbackMessage: string) => {
    setActionError(null);
    try {
      await task();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : fallbackMessage);
    }
  }, []);

  // AC1/AC4: AI 결과 반영 (useCallback으로 참조 안정화 → effect loop 방지)
  const handleAiResult = useCallback((result: {
    summary: string;
    decisions: Array<{ id: string; text: string; owner?: string }>;
    action_items: Array<{ id: string; text: string; assignee?: string; due_date?: string; status?: string }>;
  }) => {
    setMeeting((prev) => prev ? {
      ...prev,
      ai_summary: result.summary,
      decisions: result.decisions as Decision[],
      action_items: result.action_items as ActionItem[],
    } : null);
  }, []);

  useEffect(() => {
    void loadMeeting();
  }, [loadMeeting]);

  if (loading) return <PageSkeleton />;
  if (loadError) {
    return (
      <RouteErrorState
        reset={() => void loadMeeting()}
        compact
        title={tc('error')}
        description={loadError}
        secondaryHref="/meetings"
        secondaryLabel={t('meetings')}
      />
    );
  }
  if (!meeting) return <div className="p-6 text-sm text-gray-400">{t('noMeetings')}</div>;

  return (
    <div className="mx-auto max-w-4xl px-3 py-4 sm:p-6">
      {/* 헤더 */}
      <div className="mb-6">
        <button onClick={() => router.push('/meetings')} className="mb-2 text-xs text-gray-400 hover:text-gray-600">← {t('meetings')}</button>
        <h1 className="text-xl font-bold text-gray-900">{meeting.title}</h1>
        <p className="mt-1 text-sm text-gray-500">
          {new Date(meeting.date).toLocaleDateString()} · {t(meeting.meeting_type as 'standup' | 'retro' | 'general' | 'review')}
          {meeting.duration_min ? ` · ${meeting.duration_min}${t('minuteAbbrev')}` : ''}
        </p>
        {meeting.participants.length > 0 && (
          <div className="mt-2 flex gap-1">
            {meeting.participants.map((p, i) => (
              <span key={i} className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-600">{p.name ?? '?'}</span>
            ))}
          </div>
        )}
      </div>

      {actionError ? (
        <div className="mb-6 flex items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <span>{actionError}</span>
          <button onClick={() => void loadMeeting()} className="shrink-0 rounded bg-white px-3 py-1 text-xs font-medium text-rose-700">
            {tc('retry')}
          </button>
        </div>
      ) : null}

      {/* AC1-AC3: 녹음 + 업로드 */}
      <section className="mb-6">
        <AudioRecorder
          sttApiKey={process.env.NEXT_PUBLIC_STT_API_KEY}
          meetingId={meetingId}
          onUpgradeRequired={triggerUpgrade}
          onTranscript={async (text) => {
            setMeeting((prev) => prev ? { ...prev, raw_transcript: text } : null);
            await runMeetingAction(async () => {
              const nextMeeting = await updateMeeting({ raw_transcript: text }, t('saveFailed'));
              if (nextMeeting) setMeeting(nextMeeting);
            }, t('saveFailed'));
          }}
          onAudioBlob={async (blob) => {
            await runMeetingAction(async () => {
              const form = new FormData();
              form.append('audio', blob, 'recording.webm');
              const response = await fetch(`/api/meetings/${meetingId}/recording`, { method: 'POST', body: form });
              if (!response.ok) {
                const payload = await readApiClientError(response, t('uploadRecordingFailed'));
                throw new Error(payload.message);
              }
              const json = await response.json().catch(() => null);
              const publicUrl = json?.data?.publicUrl as string | undefined;
              if (publicUrl) {
                setMeeting((prev) => prev ? { ...prev, recording_url: publicUrl } : null);
              }
            }, t('uploadRecordingFailed'));
          }}
        />
      </section>

      {/* 녹음 파일 재생 */}
      {meeting.recording_url && (
        <section className="mb-6">
          <audio controls src={meeting.recording_url} className="w-full rounded" />
        </section>
      )}

      {/* SID:377 AC1: AI Summarize 버튼 */}
      {meeting.raw_transcript && (
        <section className="mb-6">
          <AiSummarizeButton
            meetingId={meeting.id}
            hasTranscript={!!meeting.raw_transcript}
            guardedFetch={guardedFetch}
            onResult={handleAiResult}
          />
        </section>
      )}

      {/* AI 요약 (AC5: 편집 가능) */}
      {meeting.ai_summary && (
        <section className="mb-6 rounded-lg border bg-blue-50 p-4">
          <div className="flex items-center justify-between">
            <h2 className="mb-2 text-sm font-semibold text-blue-700">{t('summary')}</h2>
            {!editingSummary && (
              <button onClick={() => { setSummaryDraft(meeting.ai_summary ?? ''); setEditingSummary(true); }} className="text-xs text-blue-500 hover:text-blue-700">{t('editSummary')}</button>
            )}
          </div>
          {editingSummary ? (
            <div className="space-y-2">
              <textarea value={summaryDraft} onChange={e => setSummaryDraft(e.target.value)} rows={6} className="w-full rounded border bg-white px-3 py-2 text-xs" />
              <div className="flex gap-2">
                <button
                  disabled={savingSummary}
                  onClick={async () => {
                    setSavingSummary(true);
                    await runMeetingAction(async () => {
                      const nextMeeting = await updateMeeting({ ai_summary: summaryDraft }, t('saveFailed'));
                      setMeeting((prev) => nextMeeting ?? (prev ? { ...prev, ai_summary: summaryDraft } : null));
                      setEditingSummary(false);
                    }, t('saveFailed'));
                    setSavingSummary(false);
                  }}
                  className="rounded bg-blue-600 px-3 py-1 text-xs text-white"
                >
                  {savingSummary ? '...' : t('save')}
                </button>
                <button onClick={() => setEditingSummary(false)} className="rounded border px-3 py-1 text-xs">{tc('cancel')}</button>
              </div>
            </div>
          ) : (
            <div className="prose prose-sm max-w-none text-gray-700"><ReactMarkdown>{meeting.ai_summary}</ReactMarkdown></div>
          )}
        </section>
      )}

      {/* 결정사항 (AC5: 편집/삭제/추가) */}
      <section className="mb-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700">{t('decisions')}</h2>
          <button onClick={() => {
            const newD = { id: `d${Date.now()}`, text: '', owner: '' };
            setMeeting(prev => prev ? { ...prev, decisions: [...prev.decisions, newD] } : null);
          }} className="text-xs text-blue-500 hover:text-blue-700">+ {t('addDecision')}</button>
        </div>
        <div className="space-y-2">
          {meeting.decisions.map((d, i) => (
            <div key={d.id} className="flex items-start gap-2 rounded-lg border p-3">
              <span className="text-sm">📌</span>
              <div className="flex-1 space-y-1">
                <input value={d.text} onChange={e => { const arr = [...meeting.decisions]; arr[i] = { ...arr[i], text: e.target.value }; setMeeting(prev => prev ? { ...prev, decisions: arr } : null); }} className="w-full rounded border-0 bg-transparent px-0 text-sm text-gray-800 focus:outline-none focus:ring-0" placeholder={t('decisions')} />
                <input value={d.owner ?? ''} onChange={e => { const arr = [...meeting.decisions]; arr[i] = { ...arr[i], owner: e.target.value }; setMeeting(prev => prev ? { ...prev, decisions: arr } : null); }} className="w-full rounded border-0 bg-transparent px-0 text-[10px] text-gray-400 focus:outline-none" placeholder="Owner" />
              </div>
              <button onClick={async () => { const arr = meeting.decisions.filter((_, j) => j !== i); setMeeting(prev => prev ? { ...prev, decisions: arr } : null); await fetch(`/api/meetings/${meetingId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decisions: arr }) }); }} className="text-xs text-red-400 hover:text-red-600">✕</button>
              <button onClick={async () => { await fetch(`/api/meetings/${meetingId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decisions: meeting.decisions }) }); }} className="rounded bg-gray-100 px-2 py-1 text-[10px] text-gray-500 hover:bg-gray-200">{t('save')}</button>
            </div>
          ))}
        </div>
      </section>

      {/* 액션아이템 (AC5: 편집/삭제/추가) */}
      <section className="mb-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700">{t('actionItems')}</h2>
          <button onClick={() => {
            const newAi = { id: `a${Date.now()}`, text: '', assignee: '', due_date: '', status: 'todo' };
            setMeeting(prev => prev ? { ...prev, action_items: [...prev.action_items, newAi] } : null);
          }} className="text-xs text-blue-500 hover:text-blue-700">+ {t('addActionItem')}</button>
        </div>
        <div className="space-y-2">
          {meeting.action_items.map((ai, i) => (
            <div key={ai.id} className="flex items-center gap-2 rounded-lg border p-3">
              <span className={`h-2 w-2 shrink-0 rounded-full ${ai.status === 'done' ? 'bg-green-500' : 'bg-yellow-500'}`} />
              <div className="flex-1 space-y-1">
                <input value={ai.text} onChange={e => { const arr = [...meeting.action_items]; arr[i] = { ...arr[i], text: e.target.value }; setMeeting(prev => prev ? { ...prev, action_items: arr } : null); }} className="w-full rounded border-0 bg-transparent px-0 text-sm text-gray-800 focus:outline-none" placeholder={t('actionItems')} />
                <div className="flex gap-2">
                  <input value={ai.assignee ?? ''} onChange={e => { const arr = [...meeting.action_items]; arr[i] = { ...arr[i], assignee: e.target.value }; setMeeting(prev => prev ? { ...prev, action_items: arr } : null); }} className="w-24 rounded border-0 bg-transparent px-0 text-[10px] text-gray-400 focus:outline-none" placeholder={t('assigneeLabel')} />
                  <input type="date" value={ai.due_date ?? ''} onChange={e => { const arr = [...meeting.action_items]; arr[i] = { ...arr[i], due_date: e.target.value }; setMeeting(prev => prev ? { ...prev, action_items: arr } : null); }} className="rounded border-0 bg-transparent px-0 text-[10px] text-gray-400 focus:outline-none" />
                </div>
              </div>
              <button onClick={async () => { const arr = meeting.action_items.filter((_, j) => j !== i); setMeeting(prev => prev ? { ...prev, action_items: arr } : null); await fetch(`/api/meetings/${meetingId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action_items: arr }) }); }} className="text-xs text-red-400 hover:text-red-600">✕</button>
              <button onClick={async () => { await fetch(`/api/meetings/${meetingId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action_items: meeting.action_items }) }); }} className="rounded bg-gray-100 px-2 py-1 text-[10px] text-gray-500 hover:bg-gray-200">{t('save')}</button>
              <button
                disabled={creatingStoryId === ai.id}
                onClick={async () => {
                  setCreatingStoryId(ai.id);
                  await runMeetingAction(async () => {
                    const res = await fetch('/api/stories', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        title: ai.text,
                        description: `${t('fromMeeting')}: ${meeting.title}\n${t('assigneeLabel')}: ${ai.assignee ?? t('notApplicable')}\n${t('dueLabel')}: ${ai.due_date ?? t('notApplicable')}`,
                        meeting_id: meeting.id,
                      }),
                    });

                    if (!res.ok) {
                      const payload = await readApiClientError(res, t('createStoryFailed'));
                      throw new Error(payload.message);
                    }

                    router.push('/board');
                  }, t('createStoryFailed'));
                  setCreatingStoryId(null);
                }}
                className="rounded bg-blue-50 px-2 py-1 text-[10px] text-blue-600 hover:bg-blue-100 disabled:opacity-50"
              >
                {creatingStoryId === ai.id ? '...' : t('createStory')}
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* 원문 전사 토글 + 편집 */}
      {meeting.raw_transcript !== null && (
        <section className="mb-6">
          <div className="flex items-center gap-2">
            <button onClick={() => setShowTranscript(!showTranscript)} className="text-xs text-gray-500 hover:text-gray-700">
              {showTranscript ? t('hideTranscript') : t('viewTranscript')}
            </button>
            {showTranscript && !editingTranscript && (
              <button onClick={() => { setTranscriptDraft(meeting.raw_transcript ?? ''); setEditingTranscript(true); }} className="text-xs text-blue-500">{t('editTranscript')}</button>
            )}
          </div>
          {showTranscript && (
            <div className="mt-2 rounded-lg border bg-gray-50 p-4">
              {editingTranscript ? (
                <div className="space-y-2">
                  <textarea value={transcriptDraft} onChange={e => setTranscriptDraft(e.target.value)} rows={8} className="w-full rounded border bg-white px-3 py-2 text-xs" />
                  <div className="flex gap-2">
                    <button
                      disabled={savingTranscript}
                      onClick={async () => {
                        setSavingTranscript(true);
                        await runMeetingAction(async () => {
                          const nextMeeting = await updateMeeting({ raw_transcript: transcriptDraft }, t('saveFailed'));
                          setMeeting((prev) => nextMeeting ?? (prev ? { ...prev, raw_transcript: transcriptDraft } : null));
                          setEditingTranscript(false);
                        }, t('saveFailed'));
                        setSavingTranscript(false);
                      }}
                      className="rounded bg-blue-600 px-3 py-1 text-xs text-white"
                    >
                      {savingTranscript ? '...' : t('save')}
                    </button>
                    <button onClick={() => setEditingTranscript(false)} className="rounded border px-3 py-1 text-xs">{tc('cancel')}</button>
                  </div>
                </div>
              ) : (
                <pre className="whitespace-pre-wrap text-xs text-gray-600">{meeting.raw_transcript}</pre>
              )}
            </div>
          )}
        </section>
      )}

    </div>
  );
}
