'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

// story #4359 — 문서 트리 «이름 변경»이 브라우저 prompt('Enter new title:')(영어 고정 · 디자인 창 아님)였다. 같은 동작을 디자인 창으로:
// 열리면 입력에 초점 · Esc = 닫기(Dialog) · 앞뒤 공백만인 이름과 바뀌지 않은 이름은 저장 버튼이 잠김 · Enter = 저장.
// 입력 칸은 열릴 때마다 key로 새로 마운트해 지금 제목에서 시작한다(효과 안 setState 없이).
export interface DocRenameDialogProps {
  open: boolean;
  currentTitle: string;
  onClose: () => void;
  onSubmit: (newTitle: string) => void;
}

export function DocRenameDialog({ open, currentTitle, onClose, onSubmit }: DocRenameDialogProps) {
  const t = useTranslations('docs');
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent data-testid="doc-rename-dialog">
        <DialogHeader>
          <DialogTitle>{t('docTreeRename')}</DialogTitle>
        </DialogHeader>
        {open ? <RenameForm key={currentTitle} currentTitle={currentTitle} onClose={onClose} onSubmit={onSubmit} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({ currentTitle, onClose, onSubmit }: Omit<DocRenameDialogProps, 'open'>) {
  const t = useTranslations('docs');
  const [value, setValue] = useState(currentTitle);
  const next = value.trim();
  const canSave = next.length > 0 && next !== currentTitle;
  const submit = () => { if (canSave) { onSubmit(next); onClose(); } };
  return (
    <>
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
        aria-label={t('docTreeRename')}
        autoFocus
        data-testid="doc-rename-input"
      />
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
        <Button onClick={submit} disabled={!canSave} data-testid="doc-rename-save">{t('save')}</Button>
      </DialogFooter>
    </>
  );
}
