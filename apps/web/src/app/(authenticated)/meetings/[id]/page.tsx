'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import ReactMarkdown from 'react-markdown';
import { AudioRecorder } from '@/components/meetings/audio-recorder';
import { AiSummarizeButton } from '@/components/meetings/ai-summarize-button';
import { ChevronLeft } from 'lucide-react';
import { RouteErrorState } from '@/components/ui/route-error-state';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
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
  if (!meeting) return <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">{t('noMeetings')}</div>;

  return (
    <>
      <TopBarSlot
        title={
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => router.push('/meetings')}
              className="flex items-center text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="size-4" />
            </button>
            <h1 className="text-sm font-medium truncate max-w-xs">{meeting.title}</h1>
          </div>
        }
      />
      <div className="flex min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
      {/* 메타 */}
      <div className="mb-6">
        <p className="text-sm text-muted-foreground">
          {new Date(meeting.date).toLocaleDateString()} · {t(meeting.meeting_type as 'standup' | 'retro' | 'general' | 'review')}
          {meeting.duration_min ? ` · ${meeting.duration_min}${t('minuteAbbrev')}` : ''}
        </p>
        {meeting.participants.length > 0 && (
          <div className="mt-2 flex gap-1">
            {meeting.participants.map((p, i) => (
              <span key={i} className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{p.name ?? '?'}</span>
            ))}
          </div>
        )}
      </div>

      {actionError ? (
        <div className="mb-6 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <span>{actionError}</span>
          <button onClick={() => void loadMeeting()} className="shrink-0 rounded bg-background border border-border px-3 py-1 text-xs font-medium text-destructive">
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
        <section className="mb-6 rounded-lg border bg-primary/5 p-4">
          <div className="flex items-center justify-between">
            <h2 className="mb-2 text-sm font-semibold text-primary">{t('summary')}</h2>
            {!editingSummary && (
              <button onClick={() => { setSummaryDraft(meeting.ai_summary ?? ''); setEditingSummary(true); }} className="text-xs text-primary hover:text-primary">{t('editSummary')}</button>
            )}
          </div>
          {editingSummary ? (
            <div className="space-y-2">
              <textarea value={summaryDraft} onChange={e => setSummaryDraft(e.target.value)} rows={6} className="w-full rounded border bg-background px-3 py-2 text-xs" />
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
                  className="rounded bg-primary px-3 py-1 text-xs text-white"
                >
                  {savingSummary ? '...' : t('save')}
                </button>
                <button onClick={() => setEditingSummary(false)} className="rounded border px-3 py-1 text-xs">{tc('cancel')}</button>
              </div>
            </div>
          ) : (
            <div className="prose prose-sm max-w-none text-foreground"><ReactMarkdown>{meeting.ai_summary}</ReactMarkdown></div>
          )}
        </section>
      )}

      {/* 결정사항 (AC5: 편집/삭제/추가) */}
      <section className="mb-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">{t('decisions')}</h2>
          <button onClick={() => {
            const newD = { id: `d${Date.now()}`, text: '', owner: '' };
            setMeeting(prev => prev ? { ...prev, decisions: [...prev.decisions, newD] } : null);
          }} className="text-xs text-primary hover:text-primary">+ {t('addDecision')}</button>
        </div>
        <div className="space-y-2">
          {meeting.decisions.map((d) => (
            <div key={d.id} className="flex items-start gap-2 rounded-lg border p-3">
              <span className="text-sm">📌</span>
              <div className="flex-1 space-y-1">
                <input value={d.text} onChange={e => { setMeeting(prev => prev ? { ...prev, decisions: prev.decisions.map(item => item.id === d.id ? { ...item, text: e.target.value } : item) } : null); }} className="w-full rounded border-0 bg-transparent px-0 text-sm text-foreground focus:outline-none focus:ring-0" placeholder={t('decisions')} />
                <input value={d.owner ?? ''} onChange={e => { setMeeting(prev => prev ? { ...prev, decisions: prev.decisions.map(item => item.id === d.id ? { ...item, owner: e.target.value } : item) } : null); }} className="w-full rounded border-0 bg-transparent px-0 text-[10px] text-muted-foreground focus:outline-none" placeholder="Owner" />
              </div>
              <button onClick={async () => { const arr = meeting.decisions.filter(item => item.id !== d.id); setMeeting(prev => prev ? { ...prev, decisions: arr } : null); await fetch(`/api/meetings/${meetingId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decisions: arr }) }); }} className="text-xs text-muted-foreground hover:text-destructive">✕</button>
              <button onClick={async () => { await fetch(`/api/meetings/${meetingId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decisions: meeting.decisions }) }); }} className="rounded bg-muted px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted/70">{t('save')}</button>
            </div>
          ))}
        </div>
      </section>

      {/* 액션아이템 (AC5: 편집/삭제/추가) */}
      <section className="mb-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">{t('actionItems')}</h2>
          <button onClick={() => {
            const newAi = { id: `a${Date.now()}`, text: '', assignee: '', due_date: '', status: 'todo' };
            setMeeting(prev => prev ? { ...prev, action_items: [...prev.action_items, newAi] } : null);
          }} className="text-xs text-primary hover:text-primary">+ {t('addActionItem')}</button>
        </div>
        <div className="space-y-2">
          {meeting.action_items.map((ai) => (
            <div key={ai.id} className="flex items-center gap-2 rounded-lg border p-3">
              <span className={`h-2 w-2 shrink-0 rounded-full ${ai.status === 'done' ? 'bg-green-500' : 'bg-yellow-500'}`} />
              <div className="flex-1 space-y-1">
                <input value={ai.text} onChange={e => { setMeeting(prev => prev ? { ...prev, action_items: prev.action_items.map(item => item.id === ai.id ? { ...item, text: e.target.value } : item) } : null); }} className="w-full rounded border-0 bg-transparent px-0 text-sm text-foreground focus:outline-none" placeholder={t('actionItems')} />
                <div className="flex gap-2">
                  <input value={ai.assignee ?? ''} onChange={e => { setMeeting(prev => prev ? { ...prev, action_items: prev.action_items.map(item => item.id === ai.id ? { ...item, assignee: e.target.value } : item) } : null); }} className="w-24 rounded border-0 bg-transparent px-0 text-[10px] text-muted-foreground focus:outline-none" placeholder={t('assigneeLabel')} />
                  <input type="date" value={ai.due_date ?? ''} onChange={e => { setMeeting(prev => prev ? { ...prev, action_items: prev.action_items.map(item => item.id === ai.id ? { ...item, due_date: e.target.value } : item) } : null); }} className="rounded border-0 bg-transparent px-0 text-[10px] text-muted-foreground focus:outline-none" />
                </div>
              </div>
              <button onClick={async () => { const arr = meeting.action_items.filter(item => item.id !== ai.id); setMeeting(prev => prev ? { ...prev, action_items: arr } : null); await fetch(`/api/meetings/${meetingId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action_items: arr }) }); }} className="text-xs text-muted-foreground hover:text-destructive">✕</button>
              <button onClick={async () => { await fetch(`/api/meetings/${meetingId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action_items: meeting.action_items }) }); }} className="rounded bg-muted px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted/70">{t('save')}</button>
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
                className="rounded bg-primary/5 px-2 py-1 text-[10px] text-blue-600 hover:bg-blue-100 disabled:opacity-50"
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
            <button onClick={() => setShowTranscript(!showTranscript)} className="text-xs text-muted-foreground hover:text-foreground">
              {showTranscript ? t('hideTranscript') : t('viewTranscript')}
            </button>
            {showTranscript && !editingTranscript && (
              <button onClick={() => { setTranscriptDraft(meeting.raw_transcript ?? ''); setEditingTranscript(true); }} className="text-xs text-primary">{t('editTranscript')}</button>
            )}
          </div>
          {showTranscript && (
            <div className="mt-2 rounded-lg border bg-gray-50 p-4">
              {editingTranscript ? (
                <div className="space-y-2">
                  <textarea value={transcriptDraft} onChange={e => setTranscriptDraft(e.target.value)} rows={8} className="w-full rounded border bg-background px-3 py-2 text-xs" />
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
                      className="rounded bg-primary px-3 py-1 text-xs text-white"
                    >
                      {savingTranscript ? '...' : t('save')}
                    </button>
                    <button onClick={() => setEditingTranscript(false)} className="rounded border px-3 py-1 text-xs">{tc('cancel')}</button>
                  </div>
                </div>
              ) : (
                <pre className="whitespace-pre-wrap text-xs text-muted-foreground">{meeting.raw_transcript}</pre>
              )}
            </div>
          )}
        </section>
      )}
    </div>
    </div>
    </>
  );
}
