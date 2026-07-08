'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { ToolPermissionPicker } from '@/components/agents/tool-permission-picker';

interface ApiKey {
  id: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
  scope: string[] | null;
}

interface AgentApiKeyManagerProps {
  agentId: string;
  agentName: string;
  onNewKey?: (apiKey: string) => void;
}

export function AgentApiKeyManager({ agentId, agentName, onNewKey }: AgentApiKeyManagerProps) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [newKeyDialog, setNewKeyDialog] = useState(false);
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  // EF-S3: mcp_config is captured-at-creation (returned once with the plaintext key) so the
  // onboarding copy can bundle the agent's MCP server config alongside the key.
  const [generatedMcpConfig, setGeneratedMcpConfig] = useState<string | null>(null);
  // 툴 권한 = 그룹키 배열(=api-key.scope). picker가 카탈로그 로드 후 전체 비파괴로 기본 초기화.
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [copiedOnboarding, setCopiedOnboarding] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const [revokeConfirmDialog, setRevokeConfirmDialog] = useState(false);
  const { addToast } = useToast();

  // f44e2644: 랜딩 canonical 직지정(app.sprintable.ai CF 301 prod 미발동·앱 사본 onboarding-guide 깨짐).
  const LLMS_URL = 'https://sprintable.ai/llms.txt';

  const buildOnboardingMessage = (apiKey: string, mcpConfig?: string | null) =>
    t('agentApiKeyOnboardingMessageBase', { agentName, apiKey, llmsUrl: LLMS_URL }) +
    (mcpConfig ? t('agentApiKeyOnboardingMessageMcpSuffix', { mcpConfig }) : '');

  const loadApiKeys = useCallback(async () => {
    if (!agentId) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/agents/${agentId}/api-key`);
      if (!response.ok) throw new Error('Failed to load API keys');
      const result = await response.json() as { data?: ApiKey[] };
      setApiKeys(result.data ?? []);
    } catch (error) {
      addToast({
        type: 'error',
        title: 'Error',
        body: error instanceof Error ? error.message : 'Failed to load API keys',
      });
    } finally {
      setLoading(false);
    }
  }, [agentId, addToast]);

  // Load API keys on mount
  useEffect(() => {
    void loadApiKeys();
  }, [loadApiKeys]);

  const generateApiKey = async () => {
    if (!agentId) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/agents/${agentId}/api-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: selectedScopes }),
      });
      if (!response.ok) throw new Error('Failed to generate API key');
      const result = await response.json() as { data?: { api_key?: string; mcp_config?: unknown } };
      const rawKey = (result.data?.api_key ?? '') as string;
      const rawMcp = result.data?.mcp_config;
      setGeneratedKey(rawKey);
      setGeneratedMcpConfig(
        rawMcp == null ? null : typeof rawMcp === 'string' ? rawMcp : JSON.stringify(rawMcp, null, 2),
      );
      onNewKey?.(rawKey);
      await loadApiKeys();
    } catch (error) {
      addToast({
        type: 'error',
        title: 'Error',
        body: error instanceof Error ? error.message : 'Failed to generate API key',
      });
    } finally {
      setLoading(false);
    }
  };

  const revokeAllAndGenerate = async () => {
    if (!agentId) return;
    setRevokeConfirmDialog(false);
    setLoading(true);
    try {
      await Promise.all(
        activeKeys.map((key) =>
          fetch(`/api/agents/${agentId}/api-key/${key.id}`, { method: 'DELETE' })
        )
      );
    } catch {
      // 일부 revoke 실패해도 신규 발급은 진행
    } finally {
      setLoading(false);
    }
    setNewKeyDialog(true);
    void generateApiKey();
  };

  const revokeApiKey = async (keyId: string) => {
    if (!agentId) return;
    if (!confirm('Are you sure you want to revoke this API key?')) return;

    setLoading(true);
    try {
      const response = await fetch(`/api/agents/${agentId}/api-key/${keyId}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Failed to revoke API key');
      await loadApiKeys();
      addToast({
        type: 'success',
        title: 'Success',
        body: 'API key revoked successfully',
      });
    } catch (error) {
      addToast({
        type: 'error',
        title: 'Error',
        body: error instanceof Error ? error.message : 'Failed to revoke API key',
      });
    } finally {
      setLoading(false);
    }
  };

  const writeToClipboard = async (text: string): Promise<void> => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const prev = document.activeElement as HTMLElement | null;
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px';
    document.body.appendChild(el);
    el.focus();
    el.select();
    el.setSelectionRange(0, el.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    prev?.focus();
    if (!ok) throw new Error('execCommand copy failed');
  };

  const copyToClipboard = async (text: string) => {
    try {
      await writeToClipboard(text);
      setCopiedKey(true);
      addToast({ type: 'success', title: 'Copied', body: 'API key copied to clipboard' });
      window.setTimeout(() => setCopiedKey(false), 1500);
    } catch {
      addToast({ type: 'error', title: 'Copy failed', body: t('agentApiKeyClipboardFailBody') });
    }
  };

  const copyOnboardingMessage = async (apiKey: string, mcpConfig?: string | null) => {
    try {
      await writeToClipboard(buildOnboardingMessage(apiKey, mcpConfig));
      setCopiedOnboarding(true);
      addToast({ type: 'success', title: t('agentApiKeyOnboardingCopiedTitle') });
      window.setTimeout(() => setCopiedOnboarding(false), 1500);
    } catch {
      addToast({ type: 'error', title: t('agentApiKeyCopyFailTitle'), body: t('agentApiKeyClipboardFailBody') });
    }
  };

  const activeKeys = apiKeys.filter((k) => !k.revoked_at);
  const hasActiveKey = activeKeys.length > 0 || generatedKey !== null;

  return (
    <SectionCard className="p-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold">API Keys - {agentName}</h3>
          <p className="text-sm text-muted-foreground">
            Manage API keys for agent authentication
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-2">
            <Button variant="outline" onClick={loadApiKeys} disabled={loading}>
              Refresh
            </Button>
            <Button
              variant="outline"
              disabled={!hasActiveKey || copiedOnboarding}
              onClick={() => void copyOnboardingMessage(generatedKey ?? (activeKeys[0] ? `${activeKeys[0].key_prefix}...` : ''), generatedMcpConfig)}
              className="gap-1.5"
            >
              {copiedOnboarding ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
              {t('agentApiKeyCopyOnboardingCta')}
            </Button>
            <Button
              onClick={() => {
                if (activeKeys.length > 0) {
                  setRevokeConfirmDialog(true);
                } else {
                  setNewKeyDialog(true);
                  void generateApiKey();
                }
              }}
              disabled={loading}
            >
              Generate API Key
            </Button>
          </div>
        </div>
      </div>

      {/* 툴 권한 picker (2da32fbf) — 선택 그룹키가 신규 키의 scope로 바인딩된다. */}
      <div className="mb-4">
        <ToolPermissionPicker
          value={selectedScopes}
          onChange={setSelectedScopes}
          disabled={loading}
        />
      </div>

      {apiKeys.length === 0 ? (
        <p className="text-sm text-muted-foreground">No API keys generated yet</p>
      ) : (
        <div className="space-y-2">
          {apiKeys.map((key) => (
            <div
              key={key.id}
              className="flex items-center justify-between p-3 border rounded-md"
            >
              <div>
                <div className="flex items-center gap-2">
                  <p className="font-mono text-sm">{key.key_prefix}...</p>
                  {(key.scope ?? ['read', 'write']).map((s) => (
                    <span key={s} className={`text-xs px-1.5 py-0.5 rounded font-medium ${s === 'admin' ? 'bg-orange-100 text-orange-700' : 'bg-muted text-muted-foreground'}`}>{s}</span>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Created: {new Date(key.created_at).toLocaleDateString()}
                  {key.last_used_at &&
                    ` • Last used: ${new Date(key.last_used_at).toLocaleDateString()}`}
                  {key.revoked_at && ` • Revoked: ${new Date(key.revoked_at).toLocaleDateString()}`}
                </p>
                {key.expires_at && !key.revoked_at && (() => {
                  const expiresDate = new Date(key.expires_at);
                  const daysLeft = Math.ceil((expiresDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                  const isExpired = daysLeft <= 0;
                  const isWarning = daysLeft > 0 && daysLeft <= 7;
                  return (
                    <p className={`text-xs mt-0.5 ${isExpired ? 'text-destructive font-medium' : isWarning ? 'text-orange-500 font-medium' : 'text-muted-foreground'}`}>
                      {isExpired
                        ? `Expired ${expiresDate.toLocaleDateString()}`
                        : isWarning
                          ? `⚠ Expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (${expiresDate.toLocaleDateString()})`
                          : `Expires: ${expiresDate.toLocaleDateString()}`}
                    </p>
                  );
                })()}
              </div>
              {!key.revoked_at && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => revokeApiKey(key.id)}
                  disabled={loading}
                >
                  Revoke
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <Dialog open={revokeConfirmDialog} onOpenChange={setRevokeConfirmDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('agentApiKeyRevokeDialogTitle')}</DialogTitle>
            <DialogDescription>
              {t('agentApiKeyRevokeDialogBody', { count: activeKeys.length })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeConfirmDialog(false)}>
              {tc('cancel')}
            </Button>
            <Button variant="destructive" onClick={() => void revokeAllAndGenerate()}>
              {t('agentApiKeyRevokeConfirmCta')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={newKeyDialog} onOpenChange={setNewKeyDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>API Key Generated</DialogTitle>
            <DialogDescription>
              Copy this API key now. It will only be shown once.
            </DialogDescription>
          </DialogHeader>
          {generatedKey && (
            <div className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="generated-api-key" className="text-sm font-medium leading-none text-foreground select-none">API Key</label>
                <div className="flex gap-2">
                  <Input
                    id="generated-api-key"
                    value={generatedKey}
                    readOnly
                    className="font-mono text-sm"
                  />
                  <Button onClick={() => void copyToClipboard(generatedKey)} className="gap-1.5 shrink-0">
                    {copiedKey ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                    {copiedKey ? 'Copied!' : 'Copy'}
                  </Button>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                Use this key in the Authorization header:
                <code className="block mt-1 p-2 bg-muted rounded text-xs break-all">
                  Authorization: Bearer {generatedKey}
                </code>
              </p>
              <div className="rounded-md bg-muted p-2">
                <p className="text-xs font-medium text-foreground">{t('agentApiKeyScopeLabel')}</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground break-all">
                  {['core', ...selectedScopes].join(' · ')}
                </p>
              </div>
              <div className="pt-2 border-t border-border">
                <p className="text-xs text-muted-foreground mb-2">{t('agentApiKeyOnboardingInstruction')}</p>
                <pre className="text-xs bg-muted rounded p-2 whitespace-pre-wrap break-all">{buildOnboardingMessage(generatedKey, generatedMcpConfig)}</pre>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2 gap-1.5"
                  onClick={() => void copyOnboardingMessage(generatedKey, generatedMcpConfig)}
                >
                  {copiedOnboarding ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                  {t('agentApiKeyCopyOnboardingCta')}
                </Button>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              onClick={() => {
                setNewKeyDialog(false);
                setGeneratedKey(null);
              }}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
