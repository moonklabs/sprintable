'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';

export function OssWebhookBanner() {
  const [connected, setConnected] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('/api/oss/webhook-status')
      .then((r) => r.json())
      .then((data) => setConnected(data?.data?.connected ?? false))
      .catch(() => setConnected(false));
  }, []);

  if (connected === null) return null;

  if (connected) {
    return (
      <Badge variant="success">
        GitHub Connected ✓
      </Badge>
    );
  }

  return (
    <a
      href="/docs/quickstart-webhook"
      target="_blank"
      rel="noopener noreferrer"
    >
      <Badge variant="outline">
        Connect GitHub webhook →
      </Badge>
    </a>
  );
}
