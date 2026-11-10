'use client';

import { useEffect } from 'react';
import { useToast } from '@/components/ui/toast';

// story 4892 (UI-9 §5 #3) — the upload code reports «파일 크기가 100MB를 초과합니다» · «문서를 먼저 저장한 후 첨부할 수 있습니다» · other upload failures as a
// window event; the editor only forwarded it to an `onFileError` prop that the doc page never passes, so the person saw NOTHING after a failed attach.
// With no handler given, the message is shown as an error toast. A page that passes its own handler keeps getting it (and no toast is added).
export const FILE_ERROR_EVENT = 'docs:file-size-error';

export function useFileErrorNotice(onFileError?: (message: string) => void): void {
  const { addToast } = useToast();
  useEffect(() => {
    const handle = (e: Event) => {
      const message = (e as CustomEvent<{ message?: unknown }>).detail?.message;
      if (typeof message !== 'string' || message.trim() === '') return;
      if (onFileError) onFileError(message);
      else addToast({ title: message, type: 'error' });
    };
    window.addEventListener(FILE_ERROR_EVENT, handle);
    return () => window.removeEventListener(FILE_ERROR_EVENT, handle);
  }, [onFileError, addToast]);
}
