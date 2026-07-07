'use client';

import { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AddAgentForm } from '@/components/settings/add-agent-form';

interface AddAgentDialogProps {
  open: boolean;
  onClose: () => void;
  projects: { id: string; name: string }[];
  onCreated?: () => void;
}

/**
 * story d63d3f73 — 관리 탭 "에이전트 추가" 진입점. AddAgentForm(2-phase: 입력→결과) 그대로
 * 재사용, 모달 셸만 전용(0c1a81b6 AddMemberModal의 human/agent 토글은 이 컨텍스트엔 불필요).
 */
export function AddAgentDialog({ open, onClose, projects, onCreated }: AddAgentDialogProps) {
  const t = useTranslations('agents');

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('manageAddAgent')}</DialogTitle>
        </DialogHeader>
        <AddAgentForm projects={projects} onCreated={onCreated} onDone={onClose} />
      </DialogContent>
    </Dialog>
  );
}
