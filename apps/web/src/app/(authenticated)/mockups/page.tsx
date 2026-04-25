'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { OperatorInput } from '@/components/ui/operator-control';
import { EmptyState } from '@/components/ui/empty-state';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { UpgradeModal } from '@/components/ui/upgrade-modal';

interface MockupPage {
  id: string;
  slug: string;
  title: string;
  category: string;
  viewport: string;
  version: number;
  created_at: string;
}

export default function MockupsPage() {
  const t = useTranslations('mockup');
  const tc = useTranslations('common');
  const router = useRouter();
  const [mockups, setMockups] = useState<MockupPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [newViewport, setNewViewport] = useState<'desktop' | 'mobile'>('desktop');
  const [creating, setCreating] = useState(false);
  const [upgradeMsg, setUpgradeMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/mockups').then((r) => r.ok ? r.json() : null).then((json) => {
      if (json?.data) setMockups(json.data);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const handleCreate = async () => {
    if (!newTitle.trim() || !newSlug.trim()) return;
    setCreating(true);
    const res = await fetch('/api/mockups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle.trim(), slug: newSlug.trim(), viewport: newViewport }),
    });
    if (res.ok) {
      const json = await res.json();
      setMockups((prev) => [json.data, ...prev]);
      setNewTitle('');
      setNewSlug('');
      setShowCreate(false);
    } else {
      const errJson = await res.json().catch(() => null);
      if (errJson?.error?.code === 'UPGRADE_REQUIRED') {
        setUpgradeMsg(errJson.error.message);
      }
    }
    setCreating(false);
  };

  if (loading) return <PageSkeleton />;

  return (
    <>
      <TopBarSlot
        title={<h1 className="text-sm font-medium">{t('title')}</h1>}
        actions={
          <Button variant="outline" size="sm" onClick={() => setShowCreate(true)}>
            {t('newMockup')}
          </Button>
        }
      />

      {showCreate ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-3xl border border-white/10 bg-[color:var(--operator-panel)] p-6 shadow-xl backdrop-blur-xl">
            <h3 className="mb-4 text-lg font-semibold text-[color:var(--operator-foreground)]">{t('createMockup')}</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('titlePlaceholder')}</label>
                <OperatorInput
                  type="text"
                  value={newTitle}
                  onChange={(e) => {
                    setNewTitle(e.target.value);
                    setNewSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50));
                  }}
                  className="mt-1"
                  placeholder={t('titlePlaceholder')}
                />
              </div>
              <div>
                <label className="text-xs font-medium uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('slug')}</label>
                <OperatorInput
                  type="text"
                  value={newSlug}
                  onChange={(e) => setNewSlug(e.target.value)}
                  className="mt-1"
                  placeholder={t('slugPlaceholder')}
                />
              </div>
              <div>
                <label className="text-xs font-medium uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('viewport')}</label>
                <div className="mt-1 flex gap-2">
                  <Button variant={newViewport === 'desktop' ? 'hero' : 'glass'} size="sm" onClick={() => setNewViewport('desktop')}>🖥 {t('desktop')}</Button>
                  <Button variant={newViewport === 'mobile' ? 'hero' : 'glass'} size="sm" onClick={() => setNewViewport('mobile')}>📱 {t('mobile')}</Button>
                </div>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="glass" onClick={() => setShowCreate(false)}>{tc('cancel')}</Button>
              <Button variant="hero" onClick={handleCreate} disabled={creating || !newTitle.trim()}>
                {creating ? t('saving') : t('createMockup')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 overflow-y-auto p-6">
        {mockups.length === 0 ? (
          <EmptyState title={t('noMockups')} />
        ) : (
          <div className="grid w-full grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {mockups.map((mockup) => (
              <button
                key={mockup.id}
                type="button"
                className="group rounded-3xl border border-white/8 bg-[color:var(--operator-surface-soft)]/55 p-4 text-left transition hover:border-[color:var(--operator-primary)]/18 hover:bg-white/8"
                onClick={() => router.push(`/mockups/${mockup.id}`)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-[color:var(--operator-foreground)]">{mockup.title}</h3>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{mockup.category}</Badge>
                      <Badge variant="info">v{mockup.version}</Badge>
                    </div>
                  </div>
                  <span className="text-lg">{mockup.viewport === 'mobile' ? '📱' : '🖥'}</span>
                </div>
                <div className="mt-3 text-xs text-[color:var(--operator-muted)]">{new Date(mockup.created_at).toLocaleDateString()}</div>
                <div className="mt-3 opacity-0 transition group-hover:opacity-100">
                  <Button
                    variant="glass"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      router.push(`/mockups/${mockup.id}/edit`);
                    }}
                  >
                    {t('editMockup')}
                  </Button>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {upgradeMsg ? <UpgradeModal message={upgradeMsg} onClose={() => setUpgradeMsg(null)} /> : null}
    </>
  );
}
