'use client';

// story 5036 (C6 · step ③ of the onboarding's straight line): the end the three ways of step ② share — once an agent has connected (its first call was
// seen), «첫 대화를 시작해 보세요» opens THE PROJECT'S CHANNEL — the project step ① made (lib/onboarding/first-chat.ts: the project's channel room, else the DM with the agent
// the way before channels did; story #3201: the first round trip is where the funnel fell off); when neither can be opened the person is sent where «대화로 가기» goes,
// never left on a dead end.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { refreshSessionAfterChange } from '@/lib/db/client';
import { withProjectParam } from '@/hooks/use-flat-href';
import { openFirstChatRoom } from '@/lib/onboarding/first-chat';
import { clearLineProject } from '@/lib/onboarding/line-project';

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
  // every way out of step ③ — the way on, the way out, and a room that could not be opened — uses the first-run line's mark up (the Mac app's: lib/onboarding/line-project.ts)
  const finish = () => { clearLineProject(); onFinish(); };

  const start = async () => {
    if (starting) return;
    setStarting(true);
    try {
      const convId = await openFirstChatRoom(projectId, agentId);
      if (!convId) { finish(); return; }
      clearLineProject(); // the first-run line (the Mac app's) is done: its mark is not read again
      await refreshSessionAfterChange().catch(() => null); // story 4776 — one rotation at a time for the page, minted after the conversation exists
      window.location.href = withProjectParam(`/chats/${convId}`, projectId); // story #4231 3차 — the onboarding's project goes along
    } catch {
      finish();
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
      <Button variant="quiet" className="w-full" onClick={finish} disabled={starting} data-testid="onboarding-first-chat-finish">{finishLabel}</Button>
    </div>
  );
}
