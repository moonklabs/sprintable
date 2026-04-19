'use client';

import { useState, useEffect } from 'react';
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

interface ApiKey {
  id: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface AgentApiKeyManagerProps {
  agentId: string;
  agentName: string;
}

export function AgentApiKeyManager({ agentId, agentName }: AgentApiKeyManagerProps) {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [newKeyDialog, setNewKeyDialog] = useState(false);
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const { addToast } = useToast();

  // Load API keys on mount
  useEffect(() => {
    loadApiKeys();
  }, [agentId]);

  const loadApiKeys = async () => {
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
  };

  const generateApiKey = async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/agents/${agentId}/api-key`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error('Failed to generate API key');
      const result = await response.json();
      setGeneratedKey(result.data.api_key);
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
            onClick={() => {
              setNewKeyDialog(true);
              generateApiKey();
            }}
            disabled={loading}
          >
            Generate API Key
          </Button>
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
                <p className="font-mono text-sm">{key.key_prefix}...</p>
                <p className="text-xs text-muted-foreground">
                  Created: {new Date(key.created_at).toLocaleDateString()}
                  {key.last_used_at &&
                    ` • Last used: ${new Date(key.last_used_at).toLocaleDateString()}`}
                  {key.revoked_at && ` • Revoked: ${new Date(key.revoked_at).toLocaleDateString()}`}
                </p>
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
