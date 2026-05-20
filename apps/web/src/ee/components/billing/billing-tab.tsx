'use client';

/**
 * EE-only Billing tab component.
 * Only rendered when isEEEnabled() returns true.
 * OSS builds never import this file.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

interface BillingStatus {
  org_id: string;
  plan: string;
  status: string;
  provider: string;
}

export function BillingTab({ orgId }: { orgId: string }) {
  const t = useTranslations();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/v2/billing/status', {
      headers: { 'Content-Type': 'application/json' },
    })
      .then((r) => r.json())
      .then((data: BillingStatus) => setStatus(data))
      .catch(() => setStatus(null))
      .finally(() => setLoading(false));
  }, [orgId]);

  if (loading) {
    return <div className="p-4 text-muted-foreground text-sm">Loading billing info...</div>;
  }

  return (
    <div className="space-y-4 p-4">
      <h3 className="text-lg font-semibold">Billing</h3>
      {status ? (
        <div className="rounded-md border p-4 text-sm space-y-2">
          <p>
            <span className="font-medium">Plan:</span> {status.plan}
          </p>
          <p>
            <span className="font-medium">Status:</span> {status.status}
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Billing information unavailable.</p>
      )}
    </div>
  );
}
