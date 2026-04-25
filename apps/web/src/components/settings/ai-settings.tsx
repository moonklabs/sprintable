'use client';

import { useEffect, useMemo, useState } from 'react';
import { OperatorDropdownSelect } from '@/components/ui/operator-dropdown-select';
import { useTranslations } from 'next-intl';
import {
  ANTHROPIC_MODELS,
  GOOGLE_MODELS,
  GROQ_MODELS,
  OPENAI_MODELS,
  providerSwitchRequiresNewApiKey,
  type AnthropicModel,
  type GoogleModel,
  type GroqModel,
  type LLMProvider,
  type OpenAIModel,
  type PersistedLLMConfig,
} from '@/lib/llm/types';

interface AiSettings {
  provider: LLMProvider;
  api_key: string;
  llm_config: PersistedLLMConfig;
}

const PROVIDER_LABELS: Record<LLMProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  groq: 'Groq',
  'openai-compatible': 'OpenAI-compatible',
};

const PRESET_MODEL_OPTIONS: Record<Exclude<LLMProvider, 'openai-compatible'>, string[]> = {
  openai: OPENAI_MODELS,
  anthropic: ANTHROPIC_MODELS,
  google: GOOGLE_MODELS,
  groq: GROQ_MODELS,
};

function getDefaultModel(provider: LLMProvider) {
  if (provider === 'anthropic') return 'claude-sonnet-4';
  if (provider === 'google') return 'gemini-2.5-flash';
  if (provider === 'groq') return 'llama-3.1-8b-instant';
  return 'gpt-4o-mini';
}

export function AiSettingsSection({ projectId }: { projectId: string }) {
  const t = useTranslations('settings');
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [provider, setProvider] = useState<LLMProvider>('openai');
  const [model, setModel] = useState<OpenAIModel | AnthropicModel | GoogleModel | GroqModel | string>('gpt-4o-mini');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [timeoutMs, setTimeoutMs] = useState('30000');
  const [maxRetries, setMaxRetries] = useState('3');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const modelOptions = useMemo(
    () => (provider === 'openai-compatible' ? [] : PRESET_MODEL_OPTIONS[provider]),
    [provider],
  );
  const requiresNewApiKey = providerSwitchRequiresNewApiKey(settings?.provider, provider);

  useEffect(() => {
    fetch(`/api/projects/${projectId}/ai-settings`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (json?.data) {
          const data = json.data as AiSettings;
          setSettings(data);
          setProvider(data.provider ?? 'openai');
          setModel(data.llm_config?.model ?? getDefaultModel(data.provider ?? 'openai'));
          setBaseUrl(data.llm_config?.baseUrl ?? '');
          setTimeoutMs(String(data.llm_config?.timeoutMs ?? 30000));
          setMaxRetries(String(data.llm_config?.maxRetries ?? 3));
        }
      })
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    if (provider === 'openai-compatible') {
      if (!model.trim()) setModel(getDefaultModel(provider));
      return;
    }

    setModel((current) => (modelOptions.includes(current as never) ? current : getDefaultModel(provider)));
  }, [provider, modelOptions, model]);

  const handleSave = async () => {
    if (!apiKey.trim() && !settings) return;
    if (requiresNewApiKey && !apiKey.trim()) {
      setError(t('aiApiKeyProviderChangeRequired'));
      return;
    }

    setSaving(true);
    setError(null);
    setSaved(false);

    try {
      const res = await fetch(`/api/projects/${projectId}/ai-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          api_key: apiKey.trim() || undefined,
          llm_config: {
            model,
            baseUrl: baseUrl.trim() || undefined,
            timeoutMs: Number(timeoutMs),
            maxRetries: Number(maxRetries),
          },
        }),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json?.error?.message ?? json?.message ?? 'Save failed');
      }

      const llmConfig = json?.data?.llm_config ?? {
        model,
        baseUrl: baseUrl.trim() || undefined,
        timeoutMs: Number(timeoutMs),
        maxRetries: Number(maxRetries),
      };

      setSettings({
        provider,
        api_key: apiKey.trim() ? `****${apiKey.slice(-4)}` : settings?.api_key ?? '',
        llm_config: llmConfig,
      });
      setApiKey('');
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-lg border p-4">
      <h3 className="mb-3 text-sm font-semibold text-foreground">{t('aiSettings')}</h3>

      {settings && (
        <div className="mb-3 space-y-1 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <span>{t('currentProvider')}: <strong>{PROVIDER_LABELS[settings.provider]}</strong></span>
            <span>·</span>
            <span>{t('apiKeyMasked')}: <code>{settings.api_key}</code></span>
          </div>
          <div>{t('aiModel')}: <strong>{settings.llm_config?.model ?? getDefaultModel(settings.provider)}</strong></div>
          <div>{t('aiTimeoutMs')}: <strong>{settings.llm_config?.timeoutMs ?? 30000}</strong></div>
          <div>{t('aiMaxRetries')}: <strong>{settings.llm_config?.maxRetries ?? 3}</strong></div>
          {settings.llm_config?.baseUrl && (
            <div>{t('aiBaseUrl')}: <code>{settings.llm_config.baseUrl}</code></div>
          )}
        </div>
      )}

      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('aiProvider')}</label>
          <OperatorDropdownSelect
            value={provider}
            onValueChange={(v) => setProvider(v as LLMProvider)}
            options={Object.entries(PROVIDER_LABELS).map(([v, label]) => ({ value: v, label }))}
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('aiModel')}</label>
          {provider === 'openai-compatible' ? (
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="gpt-4o-mini"
              className="w-full rounded border px-3 py-2 text-sm"
            />
          ) : (
            <OperatorDropdownSelect
              value={model as string}
              onValueChange={(v) => setModel(v)}
              options={modelOptions.map((o) => ({ value: o, label: o }))}
            />
          )}
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('aiApiKey')}</label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={requiresNewApiKey ? t('aiApiKeyProviderChangePlaceholder') : settings ? t('aiApiKeyUpdatePlaceholder') : t('aiApiKeyPlaceholder')}
            className="w-full rounded border px-3 py-2 text-sm"
          />
          {requiresNewApiKey && (
            <p className="mt-1 text-xs text-amber-600">{t('aiApiKeyProviderChangeRequired')}</p>
          )}
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('aiBaseUrl')}</label>
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={provider === 'openai-compatible' ? 'https://your-endpoint.example.com/v1' : t('aiBaseUrlPlaceholder')}
            className="w-full rounded border px-3 py-2 text-sm"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('aiTimeoutMs')}</label>
            <input
              type="number"
              min={1}
              max={120000}
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(e.target.value)}
              className="w-full rounded border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('aiMaxRetries')}</label>
            <input
              type="number"
              min={0}
              max={3}
              value={maxRetries}
              onChange={(e) => setMaxRetries(e.target.value)}
              className="w-full rounded border px-3 py-2 text-sm"
            />
          </div>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}
        {saved && <p className="text-xs text-green-500">{t('aiSettingsSaved')}</p>}

        <button
          onClick={handleSave}
          disabled={saving || (!apiKey.trim() && (!settings || requiresNewApiKey))}
          className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? '...' : t('saveAiSettings')}
        </button>
      </div>
    </section>
  );
}
