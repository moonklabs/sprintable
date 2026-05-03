'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { MemoCreateForm } from '@/components/memos/memo-create-form';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { useDashboardContext } from '../../../dashboard/dashboard-shell';

interface Member {
  id: string;
  name: string;
}

export default function NewMemoPage() {
  const router = useRouter();
  const t = useTranslations('memos');
  const { projectId } = useDashboardContext();
  const [members, setMembers] = useState<Member[]>([]);

  useEffect(() => {
    if (!projectId) return;
    fetch(`/api/team-members?project_id=${projectId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => setMembers(json?.data ?? []))
      .catch(() => null);
  }, [projectId]);

  const handleSubmit = useCallback(async (data: {
    title: string;
    content: string;
    memo_type: string;
    assigned_to_ids: string[];
  }) => {
    if (!projectId) return false;
    try {
      const res = await fetch('/api/memos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, project_id: projectId }),
      });
      if (!res.ok) return false;
      const { data: newMemo } = await res.json();
      router.push(`/memos/${newMemo.id}`);
      return true;
    } catch {
      return false;
    }
  }, [projectId, router]);

  const handleCancel = useCallback(() => {
    router.push('/memos');
  }, [router]);

  return (
    <>
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('createTitle')}</h1>} />
      <div className="flex flex-1 flex-col overflow-y-auto p-4">
        <div className="mx-auto w-full max-w-2xl">
          <MemoCreateForm
            members={members}
            onSubmit={handleSubmit}
            onCancel={handleCancel}
          />
        </div>
      </div>
    </>
  );
}
