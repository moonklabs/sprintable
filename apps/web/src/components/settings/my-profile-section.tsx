'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { Input } from '@/components/ds/input';
import { SettingsSection } from './settings-section';
import { TrustScoreCard } from '@/components/cage/trust-score-card';
import { AvatarEditCard } from '@/components/shared/avatar-edit-card';

import { fetchWithAuth } from '@/lib/db/client';
import { fetchMe } from '@/lib/me-client';
import { orgRoleLabel } from '@/lib/org-member-role';
import { memberDisplayLabel } from '@/lib/member-display';

interface MyProfile {
  id: string;
  // story #3791 — BE(app/schemas/me.py MeResponse)가 display_name 없는 휴먼을 정직하게
  // name=null로 돌린다(story #3755/#3758) — 이 인터페이스가 그걸 안 반영해(non-null
  // string으로 거짓말) Avatar의 name.trim()이 그대로 죽었다(로컬 타입 동기화 결함 클래스).
  name: string | null;
  email: string | null;
  type: string;
  role: string;
}

/** story #2887(S2g) — /api/v2/me는 avatar_url을 안 싣는다(BE 갭·이 세션 범위 밖). team-members
 * GET은 이미 avatar_url을 반환하므로(_build_org_human_response) profile.id로 별도 조회. */
async function fetchAvatarUrl(memberId: string): Promise<string | null> {
  const res = await fetchWithAuth(`/api/team-members/${memberId}`);
  if (!res.ok) return null;
  const json = await res.json() as { data: { avatar_url?: string | null } };
  return json.data.avatar_url ?? null;
}

export interface MyProfileSectionProps {
  // story #3772 — /api/me 초기 로드 실패를 탭 컨테이너에 알린다(섹션 자체는 여전히
  // 조용히 「모름」으로 안 그린다·배너는 탭이 한 곳에서 낸다, 같은 사실 네 번 금지).
  onLoadError?: () => void;
}

export function MyProfileSection({ onLoadError }: MyProfileSectionProps = {}) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // story #3772 CHANGES(페드루 PO 픽셀 지적 2026-09-10 — #4126 캡처①/② 실측) — `!profile`
  // 하나로 "아직 로딩 중"과 "로드 실패"를 같이 가리던 게 문제였다: 탭이 상단 배너로
  // 실패를 이미 말하는데 이 섹션은 여전히 `tc('loading')`("로딩 중...")를 그려, 같은
  // 화면에 "불러오지 못했습니다"와 "로딩 중"이 나란히 서는 모순이 생겼다(실 캡처로
  // 확認). loadFailed로 두 상태를 가른다 — 실패면 이 섹션도 조용히 null(나머지 세
  // 섹션과 동형, linked-accounts-section.tsx:104/two-factor-section.tsx:151 참고).
  const [loadFailed, setLoadFailed] = useState(false);

  const fetchProfile = useCallback(async () => {
    // story #3762 CHANGES(카디르 QA — /api/me reject 경로 테스트 中 발견, 페드루 PO
    // 정정 — verify:no-fetch-response-without-ok-check(#3688) 가드가 읽는 try/catch+
    // res.ok 형으로) — 네트워크 자체가 죽어 fetchWithAuth가 reject하면(HTTP 에러 응답이
    // 아니라) 이 아래 await가 그대로 throw해 `void fetchProfile()`(:49) 밖으로
    // unhandled rejection이 샜다. 최소 방어만(빈 폴백, 별도 에러 배너는 이 섹션 범위 밖).
    let res: Response;
    try { res = await fetchMe(); } catch { setLoadFailed(true); onLoadError?.(); return; }
    if (!res.ok) { setLoadFailed(true); onLoadError?.(); return; }
    const json = await res.json() as { data: MyProfile };
    setProfile(json.data);
    // story #3791 — 편집 입력창은 "빈 채로 새로 타이핑" 시작이 맞다(memberDisplayLabel의
    // 「이름 없는 구성원」 표시-문구를 편집 가능한 값인 척 입력창에 넣지 않는다).
    setEditName(json.data.name ?? '');
    setAvatarUrl(await fetchAvatarUrl(json.data.id));
  }, [onLoadError]);

  useEffect(() => { void fetchProfile(); }, [fetchProfile]);

  const handleSave = async () => {
    if (!editName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetchWithAuth('/api/me', {
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

  if (!profile) {
    if (loadFailed) return null;
    return <div className="text-ds-body text-ds-ink-3">{tc('loading')}</div>;
  }

  // story 4891 (UI-8 · settings › profile · piece ①): the card stands on the ds frame (SettingsSection) with ds Input / Button — a phone press is ≥ 44 (the ds Button's touch floor; the field is 44 on touch),
  // the rows read as «name · value» lines on ds tokens. Same fields, same PATCH, same words.
  const rowCls = 'flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-ds-line py-2.5 text-ds-body last:border-b-0';
  return (
    <SettingsSection title={t('profileTitle')} description={t('profileDescription')}>
      <AvatarEditCard
        memberId={profile.id}
        name={profile.name}
        label={memberDisplayLabel(profile.name, tc)}
        avatarUrl={avatarUrl}
        actorType="human"
        onUpdated={setAvatarUrl}
      />

      <div>
        <div className={rowCls}>
          <span className="w-20 shrink-0 text-ds-ink-3">{t('profileName')}</span>
          {editing ? (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="min-w-0 flex-1 touch:h-11"
                aria-label={t('profileName')}
                autoFocus
              />
              <Button variant="primary" disabled={saving} onClick={() => void handleSave()}>
                {saving ? tc('loading') : tc('save')}
              </Button>
              <Button variant="quiet" disabled={saving} onClick={() => { setEditing(false); setEditName(profile.name ?? ''); }}>
                {tc('cancel')}
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-ds-ink">{memberDisplayLabel(profile.name, tc)}</span>
              <Button variant="quiet" onClick={() => setEditing(true)}>
                {t('profileEdit')}
              </Button>
            </div>
          )}
        </div>
        {/* story #2105 2차 — handleSave가 재시도 전 setError(null)을 먼저 호출해(위 정의) 매 시도마다 언마운트→리마운트된다. */}
        {error && <p role="alert" aria-live="assertive" aria-atomic="true" className="text-ds-small text-ds-failed">{error}</p>}
        <div className={rowCls}>
          <span className="w-20 shrink-0 text-ds-ink-3">{t('profileEmail')}</span>
          <span className="min-w-0 break-all text-ds-ink-2">{profile.email ?? '—'}</span>
        </div>
        <div className={rowCls}>
          <span className="w-20 shrink-0 text-ds-ink-3">{t('profileRole')}</span>
          <span className="text-ds-ink">{orgRoleLabel(profile.role, t)}</span>
        </div>
      </div>

      {/* 신뢰점수 카드 */}
      <div>
        <p className="mb-2 text-ds-small font-semibold text-ds-ink-3">{t('profileTrustScore')}</p>
        <TrustScoreCard memberId={profile.id} />
      </div>
    </SettingsSection>
  );
}
