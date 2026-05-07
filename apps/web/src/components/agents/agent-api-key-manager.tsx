'use client';

import { useState, useEffect, useCallback } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';

const SCOPES = ['read', 'write', 'admin'] as const;
type Scope = typeof SCOPES[number];

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
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [newKeyDialog, setNewKeyDialog] = useState(false);
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [selectedScopes, setSelectedScopes] = useState<Scope[]>(['read', 'write']);
  const [copiedOnboarding, setCopiedOnboarding] = useState(false);
  const { addToast } = useToast();

  const LLMS_URL = 'https://app.sprintable.ai/llms.txt';

  const buildOnboardingMessage = (apiKey: string) =>
    `아래의 정보를 읽고 온보딩하기 바람.\nsprintable agent name : ${agentName}\nsprintable agent api key : ${apiKey}\n${LLMS_URL}`;

  const loadApiKeys = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/agents/${agentId}/api-key`);
      if (!response.ok) throw new Error('Failed to load API keys');
      const result = await response.json();
      setApiKeys(result.data || []);
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
    setLoading(true);
    try {
      const response = await fetch(`/api/agents/${agentId}/api-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: selectedScopes }),
      });
      if (!response.ok) throw new Error('Failed to generate API key');
      const result = await response.json();
      const rawKey = result.data.api_key as string;
      setGeneratedKey(rawKey);
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

  const revokeApiKey = async (keyId: string) => {
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

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    addToast({
      type: 'success',
      title: 'Copied',
      body: 'API key copied to clipboard',
    });
  };

  const copyOnboardingMessage = async (apiKey: string) => {
    try {
      await navigator.clipboard.writeText(buildOnboardingMessage(apiKey));
      setCopiedOnboarding(true);
      addToast({ type: 'success', title: '온보딩 메시지 복사됨' });
      window.setTimeout(() => setCopiedOnboarding(false), 1500);
    } catch {
      addToast({ type: 'error', title: '복사 실패', body: '클립보드 접근 권한을 확인하세요.' });
    }
  };

  const activeKeys = apiKeys.filter((k) => !k.revoked_at);
  const hasActiveKey = activeKeys.length > 0 || generatedKey !== null;

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold">API Keys - {agentName}</h3>
          <p className="text-sm text-muted-foreground">
            Manage API keys for agent authentication
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={loadApiKeys} disabled={loading}>
            Refresh
          </Button>
          <Button
            variant="outline"
            disabled={!hasActiveKey || copiedOnboarding}
            onClick={() => void copyOnboardingMessage(generatedKey ?? (activeKeys[0] ? `${activeKeys[0].key_prefix}...` : ''))}
            className="gap-1.5"
          >
            {copiedOnboarding ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
            온보딩 메시지 복사
          </Button>
          <Button
            onClick={() => {
              setNewKeyDialog(true);
              generateApiKey();
            }}
            disabled={loading}
          >
            Generate API Key
          </Button>
        </div>
        <div className="flex gap-4 mt-3">
          <p className="text-xs text-muted-foreground self-center">Scope:</p>
          {SCOPES.map((scope) => (
            <label key={scope} className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={selectedScopes.includes(scope)}
                onChange={(e) => {
                  if (e.target.checked) {
                    setSelectedScopes((prev) => [...prev, scope]);
                  } else {
                    setSelectedScopes((prev) => prev.filter((s) => s !== scope));
                  }
                }}
                className="h-3 w-3"
              />
              <span className={scope === 'admin' ? 'text-orange-500 font-medium' : ''}>{scope}</span>
            </label>
          ))}
        </div>
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

      <Dialog open={newKeyDialog} onOpenChange={setNewKeyDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API Key Generated</DialogTitle>
            <DialogDescription>
              Copy this API key now. It will only be shown once.
            </DialogDescription>
          </DialogHeader>
          {generatedKey && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>API Key</Label>
                <div className="flex gap-2">
                  <Input
                    value={generatedKey}
                    readOnly
                    className="font-mono text-sm"
                  />
                  <Button onClick={() => copyToClipboard(generatedKey)}>
                    Copy
                  </Button>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                Use this key in the Authorization header:
                <code className="block mt-1 p-2 bg-muted rounded text-xs">
                  Authorization: Bearer {generatedKey}
                </code>
              </p>
              <div className="pt-2 border-t border-border">
                <p className="text-xs text-muted-foreground mb-2">에이전트에게 아래 온보딩 메시지를 전달하세요:</p>
                <pre className="text-xs bg-muted rounded p-2 whitespace-pre-wrap break-all">{buildOnboardingMessage(generatedKey)}</pre>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2 gap-1.5"
                  onClick={() => void copyOnboardingMessage(generatedKey)}
                >
                  {copiedOnboarding ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                  온보딩 메시지 복사
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
    </Card>
  );
}
