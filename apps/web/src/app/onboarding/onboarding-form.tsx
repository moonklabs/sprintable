'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { UpgradeModal } from '@/components/ui/upgrade-modal';
import { useTranslations } from 'next-intl';

type Step = 'org' | 'project';

export function OnboardingForm() {
  const router = useRouter();
  const supabase = createSupabaseBrowserClient();
  const t = useTranslations('onboarding');

  const [step, setStep] = useState<Step>('org');
  const [orgName, setOrgName] = useState('');
  const [orgSlug, setOrgSlug] = useState('');
  const [projectName, setProjectName] = useState('');
  const [projectDesc, setProjectDesc] = useState('');
  const [orgId, setOrgId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [upgradeReason, setUpgradeReason] = useState('');

  const handleOrgNameChange = (name: string) => {
    setOrgName(name);
    setOrgSlug(
      name
        .toLowerCase()
        .replace(/[^a-z0-9가-힣\s-]/g, '')
        .replace(/\s+/g, '-')
        .slice(0, 50),
    );
  };

  const handleCreateOrg = async () => {
    if (!orgName.trim() || !orgSlug.trim()) return;
    setLoading(true);
    setError('');

    const res = await fetch('/api/organizations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: orgName.trim(), slug: orgSlug.trim() }),
    });
    const json = await res.json();

    if (!res.ok) {
      setError(json?.error?.message ?? t('createOrgFailed'));
      setLoading(false);
      return;
    }

    setOrgId(json.data.id);
    setStep('project');
    setLoading(false);
  };

  const handleCreateProject = async () => {
    if (!projectName.trim() || !orgId) return;
    setLoading(true);
    setError('');

    // 서버 API 경유 프로젝트 생성 (Feature Gating: max_projects 서버 enforcement)
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: orgId, name: projectName.trim(), description: projectDesc.trim() || null }),
    });
    const json = await res.json();

    if (!res.ok) {
      if (json?.error?.code === 'UPGRADE_REQUIRED') {
        setUpgradeReason(json.error.message);
        setShowUpgrade(true);
        setLoading(false);
        return;
      }
      setError(json?.error?.message ?? t('createProjectFailed'));
      setLoading(false);
      return;
    }

    const project = json.data;
    if (!project) {
      setError(t('createProjectFailed'));
      setLoading(false);
      return;
    }

    // team_member 자동 생성 (type=human)
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const name = user.user_metadata?.name
        || user.user_metadata?.full_name
        || user.email
        || t('unknownUser');

      // 중복 방지: 이미 존재하면 스킵
      const { data: existingMember } = await supabase
        .from('team_members')
        .select('id')
        .eq('user_id', user.id)
        .eq('project_id', project.id)
        .eq('type', 'human')
        .maybeSingle();

      if (!existingMember) {
        await supabase
          .from('team_members')
          .insert({
            org_id: orgId,
            project_id: project.id,
            type: 'human',
            user_id: user.id,
            name,
            role: 'member',
          });
      }
    }

    await fetch('/api/current-project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: project.id }),
    }).catch(() => null);

    router.push('/dashboard');
    router.refresh();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md space-y-6 rounded-2xl bg-white p-4 shadow-lg sm:p-8">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">
            {step === 'org' ? t('createOrg') : t('createProject')}
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            {step === 'org'
              ? t('welcome')
              : t('projectSubtitle', { orgName })}
          </p>
        </div>

        {error && (
          <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">
            {error}
          </div>
        )}

        {step === 'org' ? (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">
                {t('orgName')}
              </label>
              <input
                type="text"
                value={orgName}
                onChange={(e) => handleOrgNameChange(e.target.value)}
                placeholder={t('orgNamePlaceholder')}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">
                {t('slug')}
              </label>
              <input
                type="text"
                value={orgSlug}
                onChange={(e) => setOrgSlug(e.target.value)}
                placeholder={t('slugPlaceholder')}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <p className="mt-1 text-xs text-gray-400">
                sprintable.app/{orgSlug || '...'}
              </p>
            </div>
            <button
              onClick={handleCreateOrg}
              disabled={!orgName.trim() || !orgSlug.trim() || loading}
              className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? t('creating') : t('createOrg')}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">
                {t('projectName')}
              </label>
              <input
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder={t('projectNamePlaceholder')}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">
                {t('projectDesc')}
              </label>
              <textarea
                value={projectDesc}
                onChange={(e) => setProjectDesc(e.target.value)}
                placeholder={t('projectDescPlaceholder')}
                rows={3}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <button
              onClick={handleCreateProject}
              disabled={!projectName.trim() || loading}
              className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? t('creating') : t('createProjectAction')}
            </button>
          </div>
        )}
      </div>
      {showUpgrade && <UpgradeModal message={upgradeReason} onClose={() => setShowUpgrade(false)} />}
    </div>
  );
}
