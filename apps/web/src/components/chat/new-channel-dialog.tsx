'use client';

import { useEffect, useRef } from 'react';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { useUnifiedSwitcher } from '@/hooks/use-unified-switcher';
import { CreateProjectDialog } from '@/components/nav/create-project-dialog';

// story 5032 (C2) — «+ 새 채널» is «new project»: the switcher's own dialog (name · who may be called · plan limit), worded as a channel. The chat list mounts this host only while it is open, so the list itself
// (and its many tests) never loads the switcher's state; the host opens the dialog once and tells the list when it closes.
export function NewChannelDialogHost({ onClose }: { onClose: () => void }) {
  const ctx = useDashboardContext();
  const s = useUnifiedSwitcher({
    orgs: ctx.orgMemberships ?? [],
    currentOrgId: ctx.orgId,
    projects: ctx.projectMemberships ?? [],
    currentProjectId: ctx.projectId ?? undefined,
  });
  const setOpen = s.setCreateProjectOpen;
  const askedOpen = useRef(false); // the open request was made (once, on mount)
  const seenOpen = useRef(false); // the dialog has been seen open — only a close AFTER that is a real close (the first render is still «closed»)
  useEffect(() => {
    if (!askedOpen.current) { askedOpen.current = true; setOpen(true); }
  }, [setOpen]);
  useEffect(() => {
    if (s.createProjectOpen) { seenOpen.current = true; return; }
    if (seenOpen.current && !s.creating) onClose();
  }, [s.createProjectOpen, s.creating, onClose]);
  return <CreateProjectDialog s={s} variant="channel" idPrefix="chat-channel" />;
}
