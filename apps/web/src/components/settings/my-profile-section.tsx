'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { OperatorInput } from '@/components/ui/operator-control';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { TrustScoreCard } from '@/components/cage/trust-score-card';

interface MyProfile {
  id: string;
  name: string;
  email: string | null;
  type: string;
  role: string;
}

export function MyProfileSection() {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [editName, setEditName] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchProfile = useCallback(async () => {
    const res = await fetch('/api/me');
    if (!res.ok) return;
    const json = await res.json() as { data: MyProfile };
    setProfile(json.data);
    setEditName(json.data.name);
  }, []);

  useEffect(() => { void fetchProfile(); }, [fetchProfile]);

  const handleSave = async () => {
    if (!editName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName.trim() }),
      });
      if (!res.ok) {
        setError(t('profileSaveError'));
        return;
      }
      const json = await res.json() as { data: MyProfile };
      setProfile(json.data);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  if (!profile) return <div className="text-sm text-muted-foreground">{tc('loading')}</div>;

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{t('profileTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('profileDescription')}</p>
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-4">
        <div className="grid gap-3 text-sm">
          <div className="flex items-center gap-4">
            <span className="w-20 shrink-0 text-muted-foreground">{t('profileName')}</span>
            {editing ? (
              <div className="flex items-center gap-2">
                <OperatorInput
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="h-8 text-sm"
                  autoFocus
                />
                <Button size="sm" disabled={saving} onClick={() => void handleSave()}>
                  {saving ? tc('loading') : tc('save')}
                </Button>
                <Button size="sm" variant="ghost" disabled={saving} onClick={() => { setEditing(false); setEditName(profile.name); }}>
                  {tc('cancel')}
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span>{profile.name}</span>
                <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setEditing(true)}>
                  {t('profileEdit')}
                </Button>
              </div>
            )}
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex items-center gap-4">
            <span className="w-20 shrink-0 text-muted-foreground">{t('profileEmail')}</span>
            <span className="text-muted-foreground">{profile.email ?? '—'}</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="w-20 shrink-0 text-muted-foreground">{t('profileRole')}</span>
            <span>{profile.role}</span>
          </div>
        </div>

        {/* 신뢰점수 카드 */}
        <div className="pt-2">
          <p className="mb-2 text-xs font-medium text-muted-foreground">{t('profileTrustScore')}</p>
          <TrustScoreCard memberId={profile.id} />
        </div>
      </SectionCardBody>
    </SectionCard>
  );
}
