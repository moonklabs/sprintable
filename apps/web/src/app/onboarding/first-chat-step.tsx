'use client';

// story 5036 (C6 · step ③ of the onboarding's straight line): the end the three ways of step ② share — once an agent has connected (its first call was
// seen), «첫 대화를 시작해 보세요» opens the conversation with it in THE project step ① made. It used to be two buttons at the foot of the key way only
// (story #3201: the first round trip is where the funnel fell off) — the way that opens the conversation is the same one (PO 08-29: no third way): a DM with the
// agent, always new; when it cannot be opened the person is sent where «대화로 가기» goes, never left on a dead end.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { refreshSessionAfterChange } from '@/lib/db/client';
import { withProjectParam } from '@/hooks/use-flat-href';
import { createFirstInstructionConversation } from '@/lib/onboarding/first-instruction';

interface FirstChatStepProps {
  projectId: string;
  /** the agent that connected — null when the app made it (the conversation then opens with the project's first real agent) */
  agentId: string | null;
  /** «대화로 가기» — and the way out when the conversation could not be opened */
  onFinish: () => void;
  /** the word of that way out follows where it lands (the page decides: «홈으로 가기» / «대화로 가기») */
  finishLabel: string;
}

export function FirstChatStep({ projectId, agentId, onFinish, finishLabel }: FirstChatStepProps) {
  const t = useTranslations('onboarding.line');
  const to = useTranslations('onboarding');
  const [starting, setStarting] = useState(false);

  const start = async () => {
    if (starting) return;
    setStarting(true);
    try {
      const convId = await createFirstInstructionConversation(projectId, agentId);
      if (!convId) { onFinish(); return; }
      await refreshSessionAfterChange().catch(() => null); // story 4776 — one rotation at a time for the page, minted after the conversation exists
      window.location.href = withProjectParam(`/chats/${convId}`, projectId); // story #4231 3차 — the onboarding's project goes along
    } catch {
      onFinish();
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="space-y-4 text-center" data-testid="onboarding-first-chat">
      <div className="space-y-2">
        <h1 id="onboarding-step-title" className="break-keep text-ds-title font-semibold text-ds-ink">{t('chatTitle')}</h1>
        <p className="break-keep text-ds-body text-ds-ink-2">{t('chatLead')}</p>
      </div>
      <Button variant="primary" size="lg" className="w-full" loading={starting} onClick={() => void start()} data-testid="onboarding-first-chat-start">
        {starting ? to('firstInstructionStarting') : to('firstInstructionCta')}
      </Button>
      <Button variant="quiet" className="w-full" onClick={onFinish} disabled={starting} data-testid="onboarding-first-chat-finish">{finishLabel}</Button>
    </div>
  );
}
