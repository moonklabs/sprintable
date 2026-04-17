'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { OperatorSelect } from '@/components/ui/operator-control';

interface ProjectSwitcherItem {
  projectId: string;
  projectName: string;
}

export function ProjectSwitcher({
  projects,
  currentProjectId,
  className,
}: {
  projects: ProjectSwitcherItem[];
  currentProjectId?: string;
  className?: string;
}) {
  const router = useRouter();
  const t = useTranslations('shell');
  const [pending, setPending] = useState(false);

  return (
    <OperatorSelect
      value={currentProjectId ?? ''}
      disabled={pending || projects.length === 0}
      className={className}
      onChange={async (event) => {
        const nextProjectId = event.target.value;
        if (!nextProjectId || nextProjectId === currentProjectId) return;

        setPending(true);
        try {
          await fetch('/api/current-project', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_id: nextProjectId }),
          });
          router.refresh();
        } finally {
          setPending(false);
        }
      }}
    >
      {!currentProjectId ? <option value="">{t('projectSelectPrompt')}</option> : null}
      {projects.map((project) => (
        <option key={project.projectId} value={project.projectId}>{project.projectName}</option>
      ))}
    </OperatorSelect>
  );
}
