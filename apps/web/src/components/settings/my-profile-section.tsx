'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { OperatorInput } from '@/components/ui/operator-control';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';

interface MyProfile {
  id: string;
  name: string;
  email: string | null;
  type: string;
  role: string;
}

export function MyProfileSection() {
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
        setError('저장 실패인. 다시 시도 바라는.');
        return;
      }
      const json = await res.json() as { data: MyProfile };
      setProfile(json.data);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  if (!profile) return <div className="text-sm text-muted-foreground">Loading...</div>;

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <h2 className="text-base font-semibold">My Profile</h2>
          <p className="text-sm text-muted-foreground">내 계정 정보인.</p>
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-4">
        <div className="grid gap-3 text-sm">
          <div className="flex items-center gap-4">
            <span className="w-20 shrink-0 text-muted-foreground">이름</span>
            {editing ? (
              <div className="flex items-center gap-2">
                <OperatorInput
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="h-8 text-sm"
                  autoFocus
                />
                <Button size="sm" disabled={saving} onClick={() => void handleSave()}>
                  {saving ? '...' : '저장'}
                </Button>
                <Button size="sm" variant="ghost" disabled={saving} onClick={() => { setEditing(false); setEditName(profile.name); }}>
                  취소
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span>{profile.name}</span>
                <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setEditing(true)}>
                  편집
                </Button>
              </div>
            )}
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex items-center gap-4">
            <span className="w-20 shrink-0 text-muted-foreground">이메일</span>
            <span className="text-muted-foreground">{profile.email ?? '—'}</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="w-20 shrink-0 text-muted-foreground">역할</span>
            <span>{profile.role}</span>
          </div>
        </div>
      </SectionCardBody>
    </SectionCard>
  );
}
