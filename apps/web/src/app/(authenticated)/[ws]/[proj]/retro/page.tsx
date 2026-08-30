'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { History, Plus, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { OperatorSelect } from '@/components/ui/operator-control';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { useRetroRoute } from './retro-context';
import { RETRO_PHASE_TO_STAGE, RETRO_STAGE_VARIANTS, type RetroSessionPhase } from '@/services/retro-session';
import { isRetroStale, daysStale } from './retro-staleness';
import { fetchWithAuth } from '@/lib/db/client';

interface RetroSession {
  id: string;
  title: string;
  phase: string;
  created_at: string;
  updated_at: string;
}

interface RetroSprintOption {
  id: string;
  title: string;
  status: 'planning' | 'active' | 'closed';
}

export default function RetroPage() {
  const t = useTranslations('retro');
  const tc = useTranslations('common');
  const shellT = useTranslations('shell');
  // story a539c649 S3a: projectId 는 URL 경로(retro-context.tsx, layout.tsx가 헤더 경유 주입)
  // 가 SSOT — useDashboardContext()(전역 "현재 프로젝트")가 아니다. orgId 는 경로 무관 그대로.
  const { projectId, wsSlug, projSlug } = useRetroRoute();
  const { orgId } = useDashboardContext();
  // story #2413 — 마운트 시점 1회 고정("페이지를 연 시점 기준 얼마나 멈췄는가").
  const now = useMemo(() => new Date(), []);
  const [sessions, setSessions] = useState<RetroSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // B5(9f27af8f): 생성 시 스프린트 연결(옵셔널)
  const [sprints, setSprints] = useState<RetroSprintOption[]>([]);
  const [selectedSprintId, setSelectedSprintId] = useState('');

  useEffect(() => {
    if (!projectId) { setSprints([]); return; }
    let cancelled = false;
    void (async () => {
      const res = await fetchWithAuth(`/api/sprints?project_id=${projectId}&status=active`);
      if (!res.ok || cancelled) return;
      const json = await res.json().catch(() => null) as { data?: RetroSprintOption[] } | null;
      if (json?.data && !cancelled) setSprints(json.data);
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!projectId) {
        if (!cancelled) {
          setSessions([]);
          setLoading(false);
        }
        return;
      }
      setLoading(true);
      setLoadError(null);
      try {
        const res = await fetchWithAuth(`/api/retro-sessions?project_id=${projectId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!cancelled) setSessions(json.data ?? []);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [projectId]);

  const handleCreate = async () => {
    if (!title.trim() || !projectId || !orgId) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch('/api/retro-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          project_id: projectId,
          org_id: orgId,
          sprint_id: selectedSprintId || null,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setSessions((prev) => [json.data, ...prev]);
      setTitle('');
      setSelectedSprintId('');
      setShowCreateForm(false);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create session');
    } finally {
      setCreating(false);
    }
  };

  // B1(9f27af8f): 리스트 배지도 상세 페이지와 동일한 3단계(+closed) 표시로 통일.
  // 유나 가디언 should-fix: 스테퍼/배지 전용 de-emoji 라벨(phaseCollect/Action/Closed는 다른 소비부 없어 그대로 둠).
  const STAGE_KEYS: Record<string, 'stageCollect' | 'stagePriority' | 'stageAction' | 'stageClosed'> = {
    collect: 'stageCollect',
    priority: 'stagePriority',
    action: 'stageAction',
    closed: 'stageClosed',
  };

  if (!projectId) {
    return (
      <>
        <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} showContextChip />
        <div className="flex h-64 items-center justify-center p-6">
          <EmptyState title={shellT('projectSelectPrompt')} description={shellT('projectSelectDescription')} />
        </div>
      </>
    );
  }

  return (
    <>
      <TopBarSlot
        title={<h1 className="text-sm font-medium">{t('title')}</h1>}
        actions={
          <Button size="sm" variant="outline" onClick={() => setShowCreateForm((v) => !v)}>
            {showCreateForm ? (
              <><X className="mr-1.5 h-3.5 w-3.5" />{tc('cancel')}</>
            ) : (
              <><Plus className="mr-1.5 h-3.5 w-3.5" />{t('newSession')}</>
            )}
          </Button>
        }
        showContextChip
      />

      <div className="focus-inset flex min-h-0 flex-1 flex-col gap-0 overflow-y-auto">
        {/* Create new session — toggle via TopBar button */}
        {showCreateForm && (
          <div className="flex-shrink-0 border-b border-border/80 px-6 py-4">
            <div className="flex flex-wrap gap-2">
              <Input
                id="retro-title-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
                placeholder={t('newSessionPlaceholder')}
                className="flex-1"
                autoFocus
              />
              {sprints.length > 0 ? (
                <OperatorSelect value={selectedSprintId} onChange={(e) => setSelectedSprintId(e.target.value)} className="w-auto">
                  <option value="">{t('noSprintLink')}</option>
                  {sprints.map((sprint) => (
                    <option key={sprint.id} value={sprint.id}>{sprint.title}</option>
                  ))}
                </OperatorSelect>
              ) : null}
              <Button variant="default" onClick={handleCreate} disabled={!title.trim() || !orgId || creating}>
                {creating ? t('creating') : t('create')}
              </Button>
            </div>
            {createError ? (
              <p className="mt-2 text-xs text-destructive" role="alert" aria-live="assertive" aria-atomic="true">{createError}</p>
            ) : null}
          </div>
        )}

        {/* Session list */}
        <div className="flex-1 px-6 py-4">
          <p className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            {t('sessionList')}
          </p>

          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-16 animate-pulse rounded-xl bg-muted/50" />
              ))}
            </div>
          ) : loadError ? (
            <EmptyState title={loadError} description={t('surfaceDescription')} />
          ) : sessions.length === 0 ? (
            // story #3230 — 형제 빈상태(목표=Flag+CTA·실험실=Lightbulb+CTA)와 규범 일치:
            // 아이콘(History)·전용 warm 설명(범용 surfaceDescription 재사용 대신)·중앙 CTA로
            // 다음 행동을 빈상태 중심에 둔다. 컨테이너 bg는 공유 EmptyState 기본(형제와 동일)이라
            // 손대지 않는다(다크 blend는 EmptyState 공통 축·retro 특정 아님).
            <EmptyState
              icon={<History className="size-8" />}
              title={t('noSessions')}
              description={t('noSessionsDescription')}
              action={
                <Button size="sm" onClick={() => setShowCreateForm(true)}>
                  <Plus className="size-4" />
                  {t('noSessionsCta')}
                </Button>
              }
            />
          ) : (
            <div className="space-y-2">
              {sessions.map((session) => (
                <Link
                  key={session.id}
                  href={`/${wsSlug}/${projSlug}/retro/${session.id}`}
                  className="flex items-center justify-between gap-4 rounded-xl border border-border bg-background px-4 py-3 transition hover:bg-muted/40"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{session.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(session.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {(() => {
                      const stage = RETRO_PHASE_TO_STAGE[session.phase as RetroSessionPhase];
                      return (
                        <Badge variant={stage ? RETRO_STAGE_VARIANTS[stage] : 'outline'}>
                          {stage ? t(STAGE_KEYS[stage]) : session.phase}
                        </Badge>
                      );
                    })()}
                    {isRetroStale(session, now) ? (
                      // 유나 규격(2026-08-02, #2791 design:changes) — Badge variant="warning"의
                      // 계열색 텍스트(text-warning)는 light에서 2.06(AA 4.5의 절반 이하). 명도를
                      // 낮추면 통과하지만 노랑이 갈색이 되어 "경고" 의미가 사라진다 — 문제는
                      // 배경이 아니라 글자가 밝은 것. tint 배경 위에서는 foreground로 덮는다.
                      // 이 오버라이드는 이 배지(#2413) 한정 — badge.tsx의 warning variant
                      // 자체는 다른 색 계열과 함께 #2420에서 다룬다.
                      <Badge variant="warning" className="text-foreground">{t('staleBadge', { days: daysStale(session.updated_at, now) })}</Badge>
                    ) : null}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
