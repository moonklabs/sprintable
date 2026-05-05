'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { UpgradeModal } from '@/components/ui/upgrade-modal';
import { useTranslations } from 'next-intl';

const MCP_SERVER_URL = 'https://app.sprintable.ai/api/v2/mcp';
const LLMS_PROMPT = 'Read this document and complete onboarding: https://app.sprintable.ai/llms.txt';
const AGENT_ROLES = ['developer', 'designer', 'pm', 'qa', 'devops'];

function buildMcpConfig(apiKey: string) {
  return JSON.stringify(
    {
      mcpServers: {
        sprintable: {
          type: 'streamable-http',
          url: MCP_SERVER_URL,
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      },
    },
    null,
    2,
  );
}

type Step = 'org' | 'project' | 'agent' | 'connect';
const STEPS: Step[] = ['org', 'project', 'agent', 'connect'];

export function OnboardingForm() {
  const router = useRouter();
  const t = useTranslations('onboarding');

  const [step, setStep] = useState<Step>('org');
  const [orgName, setOrgName] = useState('');
  const [orgSlug, setOrgSlug] = useState('');
  const [projectName, setProjectName] = useState('');
  const [projectDesc, setProjectDesc] = useState('');
  const [orgId, setOrgId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [agentName, setAgentName] = useState('My Agent');
  const [agentRole, setAgentRole] = useState('developer');
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [upgradeReason, setUpgradeReason] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const stepIndex = STEPS.indexOf(step);

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

  const handleCopy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // ignore
    }
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

    setProjectId(project.id);

    // team_member 자동 생성 (type=human)
    const meRes = await fetch('/api/me');
    if (meRes.ok) {
      const meJson = await meRes.json() as { data?: { name?: string } };
      const memberName = meJson.data?.name ?? t('unknownUser');
      await fetch('/api/team-members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_id: orgId,
          project_id: project.id,
          type: 'human',
          name: memberName,
          role: 'member',
        }),
      }).catch(() => null);
    }

    await fetch('/api/current-project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: project.id }),
    }).catch(() => null);

    setStep('agent');
    setLoading(false);
  };

  const handleCreateAgent = async () => {
    if (!agentName.trim() || !projectId || !orgId) return;
    setLoading(true);
    setError('');

    // 에이전트 팀원 생성
    const memberRes = await fetch('/api/team-members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        org_id: orgId,
        project_id: projectId,
        type: 'agent',
        name: agentName.trim(),
        role: agentRole,
      }),
    });
    const memberJson = await memberRes.json() as { data?: { id: string }; error?: { message?: string } };
    if (!memberRes.ok) {
      setError(memberJson?.error?.message ?? 'Failed to create agent');
      setLoading(false);
      return;
    }

    const agentId = memberJson.data?.id;
    if (!agentId) {
      setError('Failed to create agent');
      setLoading(false);
      return;
    }

    // API 키 자동 발급
    const keyRes = await fetch(`/api/agents/${agentId}/api-key`, { method: 'POST' });
    const keyJson = await keyRes.json() as { data?: { api_key: string } };
    if (keyRes.ok && keyJson.data?.api_key) {
      setNewApiKey(keyJson.data.api_key);
    }

    setStep('connect');
    setLoading(false);
  };

  const handleFinish = () => {
    router.push('/dashboard');
    router.refresh();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md space-y-6 rounded-2xl bg-white p-4 shadow-lg sm:p-8">
        {/* Progress bar */}
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-gray-400">
            <span>{t('stepOf', { current: stepIndex + 1, total: STEPS.length })}</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-gray-100">
            <div
              className="h-1.5 rounded-full bg-blue-600 transition-all duration-300"
              style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }}
            />
          </div>
        </div>

        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">
            {step === 'org' && t('createOrg')}
            {step === 'project' && t('createProject')}
            {step === 'agent' && t('createAgent')}
            {step === 'connect' && t('connectAgent')}
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            {step === 'org' && t('welcome')}
            {step === 'project' && t('projectSubtitle', { orgName })}
            {step === 'agent' && t('agentSubtitle')}
            {step === 'connect' && t('connectSubtitle')}
          </p>
        </div>

        {error && (
          <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">
            {error}
          </div>
        )}

        {step === 'org' && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">{t('orgName')}</label>
              <input
                type="text"
                value={orgName}
                onChange={(e) => handleOrgNameChange(e.target.value)}
                placeholder={t('orgNamePlaceholder')}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">{t('slug')}</label>
              <input
                type="text"
                value={orgSlug}
                onChange={(e) => setOrgSlug(e.target.value)}
                placeholder={t('slugPlaceholder')}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <p className="mt-1 text-xs text-gray-400">sprintable.app/{orgSlug || '...'}</p>
            </div>
            <button
              onClick={handleCreateOrg}
              disabled={!orgName.trim() || !orgSlug.trim() || loading}
              className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? t('creating') : t('createOrg')}
            </button>
          </div>
        )}

        {step === 'project' && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">{t('projectName')}</label>
              <input
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder={t('projectNamePlaceholder')}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">{t('projectDesc')}</label>
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

        {step === 'agent' && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">{t('agentName')}</label>
              <input
                type="text"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                placeholder={t('agentNamePlaceholder')}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">{t('agentRole')}</label>
              <select
                value={agentRole}
                onChange={(e) => setAgentRole(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {AGENT_ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            <button
              onClick={handleCreateAgent}
              disabled={!agentName.trim() || loading}
              className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? t('creating') : t('createAgentAction')}
            </button>
            <button
              onClick={handleFinish}
              className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-50"
            >
              {t('skip')}
            </button>
          </div>
        )}

        {step === 'connect' && (
          <div className="space-y-4">
            {newApiKey ? (
              <>
                <div className="rounded-md border border-gray-200 bg-gray-50 p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-gray-700">{t('mcpConfigTitle')}</p>
                    <button
                      onClick={() => void handleCopy(buildMcpConfig(newApiKey), 'mcp')}
                      className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 transition"
                    >
                      {copied === 'mcp' ? '✓ Copied' : 'Copy'}
                    </button>
                  </div>
                  <pre className="overflow-x-auto rounded bg-white border border-gray-100 p-2 text-xs text-gray-700">
                    {buildMcpConfig(newApiKey)}
                  </pre>
                </div>
              </>
            ) : (
              <div className="rounded-md border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
                API Key 발급에 실패했습니다. Settings → API Keys에서 수동으로 발급하세요.
              </div>
            )}

            <div className="rounded-md border border-gray-200 bg-gray-50 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-gray-700">{t('promptTitle')}</p>
                <button
                  onClick={() => void handleCopy(LLMS_PROMPT, 'prompt')}
                  className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 transition"
                >
                  {copied === 'prompt' ? '✓ Copied' : 'Copy'}
                </button>
              </div>
              <p className="break-all rounded bg-white border border-gray-100 p-2 text-xs text-gray-700">
                {LLMS_PROMPT}
              </p>
            </div>

            <button
              onClick={handleFinish}
              className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
            >
              {t('finish')}
            </button>
          </div>
        )}
      </div>
      {showUpgrade && <UpgradeModal message={upgradeReason} onClose={() => setShowUpgrade(false)} />}
    </div>
  );
}
