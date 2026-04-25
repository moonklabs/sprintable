'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { OperatorInput } from '@/components/ui/operator-control';
import { OperatorDropdownSelect } from '@/components/ui/operator-dropdown-select';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { Badge } from '@/components/ui/badge';
import type { LLMProvider } from '@/lib/llm';

interface SavedKeyInfo {
  provider: LLMProvider;
  maskedKey: string;
  baseUrl?: string;
  model?: string;
  updatedAt?: string;
}

const PROVIDER_LABELS: Record<LLMProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  groq: 'Groq',
  'openai-compatible': 'OpenAI-compatible',
};

export function ByomKeyManagement({ projectId }: { projectId: string }) {
  const t = useTranslations('settings.byomKeys');
  const tc = useTranslations('common');

  // Saved key state
  const [savedKey, setSavedKey] = useState<SavedKeyInfo | null>(null);
  const [loading, setLoading] = useState(true);

  // Input form state
  const [provider, setProvider] = useState<LLMProvider>('openai');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [showKey, setShowKey] = useState(false);

  // Action states
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<'success' | 'error' | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<'success' | 'error' | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Delete flow
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState<string | null>(null);

  const fetchSavedKey = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/ai-settings`);
      if (!res.ok) return;
      const json = await res.json();
      if (json?.data) {
        setSavedKey({
          provider: json.data.provider,
          maskedKey: json.data.api_key ?? '',
          baseUrl: json.data.llm_config?.baseUrl,
          model: json.data.llm_config?.model,
          updatedAt: json.data.updated_at,
        });
        setProvider(json.data.provider);
        setBaseUrl(json.data.llm_config?.baseUrl ?? '');
      }
    } catch {
      // noop
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void fetchSavedKey();
  }, [fetchSavedKey]);

  const requiresBaseUrl = provider === 'openai-compatible';
  const canValidate = Boolean(apiKey.trim()) && (!requiresBaseUrl || Boolean(baseUrl.trim()));
  const requiresApiKeyForSave = !savedKey || savedKey.provider !== provider;
  const canSave = (!requiresBaseUrl || Boolean(baseUrl.trim())) && (Boolean(apiKey.trim()) || !requiresApiKeyForSave);

  const handleValidate = async () => {
    if (!canValidate) return;
    setValidating(true);
    setValidationResult(null);

    try {
      const res = await fetch(`/api/projects/${projectId}/ai-settings/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          api_key: apiKey.trim(),
          base_url: requiresBaseUrl ? baseUrl.trim() : undefined,
        }),
      });
      const json = await res.json();
      setValidationResult(json?.data?.valid ? 'success' : 'error');
    } catch {
      setValidationResult('error');
    } finally {
      setValidating(false);
    }
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveResult(null);
    setSaveError(null);

    try {
      const res = await fetch(`/api/projects/${projectId}/ai-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          api_key: apiKey.trim() || undefined,
          llm_config: {
            baseUrl: requiresBaseUrl ? baseUrl.trim() : undefined,
          },
        }),
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.error?.message ?? 'Save failed');
      }

      setSavedKey({
        provider,
        maskedKey: apiKey.trim() ? `****${apiKey.slice(-4)}` : (savedKey?.maskedKey ?? ''),
        baseUrl: requiresBaseUrl ? baseUrl.trim() : undefined,
        updatedAt: new Date().toISOString(),
      });
      setApiKey('');
      setShowKey(false);
      setValidationResult(null);
      setDeleteMessage(null);
      setSaveResult('success');
      setTimeout(() => setSaveResult(null), 3000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
      setSaveResult('error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/ai-settings`, {
        method: 'DELETE',
      });
      if (res.ok) {
        const json = await res.json().catch(() => null);
        setSavedKey(null);
        setApiKey('');
        setBaseUrl('');
        setShowKey(false);
        setValidationResult(null);
        setSaveResult(null);
        setDeleteMessage(json?.data?.kms_rotation?.requested ? t('deleteSuccessWithRotation') : t('deleteSuccess'));
        setShowDeleteConfirm(false);
      }
    } catch {
      // noop
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <SectionCard>
        <SectionCardHeader>
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-[color:var(--operator-foreground)]">{t('title')}</h2>
          </div>
        </SectionCardHeader>
        <SectionCardBody>
          <div className="h-24 animate-pulse rounded-2xl bg-[color:var(--operator-surface-soft)]" />
        </SectionCardBody>
      </SectionCard>
    );
  }

  return (
    <>
      <SectionCard>
        <SectionCardHeader>
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-[color:var(--operator-foreground)]">{t('title')}</h2>
            <p className="text-sm text-[color:var(--operator-muted)]">{t('description')}</p>
          </div>
        </SectionCardHeader>
        <SectionCardBody className="space-y-4">
          {/* Saved key summary */}
          {savedKey ? (
            <div className="flex items-center justify-between rounded-2xl border border-white/8 bg-[color:var(--operator-surface-soft)]/55 px-4 py-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Badge variant="info">{PROVIDER_LABELS[savedKey.provider]}</Badge>
                  {savedKey.model ? <Badge variant="outline">{savedKey.model}</Badge> : null}
                </div>
                <div className="flex items-center gap-2 text-xs text-[color:var(--operator-muted)]">
                  <span>{t('savedKeyLabel')}</span>
                  <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[color:var(--operator-foreground)]">
                    {savedKey.maskedKey}
                  </code>
                </div>
                {savedKey.baseUrl ? (
                  <div className="text-xs text-[color:var(--operator-muted)]">
                    {t('baseUrlSavedLabel')} <code className="rounded bg-white/5 px-1.5 py-0.5">{savedKey.baseUrl}</code>
                  </div>
                ) : null}
              </div>
              <Button
                variant="glass"
                size="sm"
                onClick={() => setShowDeleteConfirm(true)}
              >
                {tc('delete')}
              </Button>
            </div>
          ) : null}

          {/* Key input form */}
          <div className="space-y-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">
                {t('providerLabel')}
              </label>
              <OperatorDropdownSelect
                value={provider}
                onValueChange={(v) => {
                  setProvider(v as LLMProvider);
                  setValidationResult(null);
                  setSaveResult(null);
                  setDeleteMessage(null);
                }}
                options={Object.entries(PROVIDER_LABELS).map(([v, label]) => ({ value: v, label }))}
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">
                {t('apiKeyLabel')}
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <OperatorInput
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setValidationResult(null);
                      setSaveResult(null);
                      setDeleteMessage(null);
                    }}
                    placeholder={savedKey ? t('apiKeyUpdatePlaceholder') : t('apiKeyPlaceholder')}
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((prev) => !prev)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[color:var(--operator-muted)] hover:text-[color:var(--operator-foreground)] transition"
                    aria-label={showKey ? t('hideKey') : t('showKey')}
                  >
                    {showKey ? t('hideKey') : t('showKey')}
                  </button>
                </div>
              </div>
            </div>

            {requiresBaseUrl ? (
              <div>
                <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">
                  {t('baseUrlLabel')}
                </label>
                <OperatorInput
                  type="url"
                  value={baseUrl}
                  onChange={(e) => {
                    setBaseUrl(e.target.value);
                    setValidationResult(null);
                    setSaveResult(null);
                    setDeleteMessage(null);
                  }}
                  placeholder={t('baseUrlPlaceholder')}
                />
                <p className="mt-1 text-xs text-[color:var(--operator-muted)]">{t('baseUrlHint')}</p>
              </div>
            ) : null}

            {/* Validation result */}
            {validationResult === 'success' ? (
              <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-200">
                {t('validationSuccess')}
              </div>
            ) : null}
            {validationResult === 'error' ? (
              <div className="rounded-2xl border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                {t('validationError')}
              </div>
            ) : null}

            {/* Save result */}
            {saveResult === 'success' ? (
              <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-200">
                {t('saveSuccess')}
              </div>
            ) : null}
            {deleteMessage ? (
              <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-200">
                {deleteMessage}
              </div>
            ) : null}
            {saveResult === 'error' && saveError ? (
              <div className="rounded-2xl border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                {saveError}
              </div>
            ) : null}

            {/* Action buttons */}
            <div className="flex gap-2">
              <Button
                variant="glass"
                size="lg"
                onClick={handleValidate}
                disabled={!canValidate || validating}
              >
                {validating ? t('validating') : t('validateCta')}
              </Button>
              <Button
                variant="hero"
                size="lg"
                onClick={handleSave}
                disabled={!canSave || saving}
              >
                {saving ? '...' : t('saveCta')}
              </Button>
            </div>
          </div>
        </SectionCardBody>
      </SectionCard>

      {/* Delete confirmation dialog */}
      {showDeleteConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-[color:var(--operator-panel)] p-6 shadow-xl backdrop-blur-xl">
            <h3 className="text-lg font-semibold text-rose-100">{t('deleteConfirmTitle')}</h3>
            <p className="mt-2 text-sm text-[color:var(--operator-muted)]">{t('deleteConfirmDesc')}</p>
            <div className="mt-6 flex gap-3">
              <Button variant="glass" className="flex-1" onClick={() => setShowDeleteConfirm(false)}>
                {tc('cancel')}
              </Button>
              <Button
                variant="destructive"
                className="flex-1"
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? '...' : t('confirmDelete')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
