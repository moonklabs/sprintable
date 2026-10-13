'use client';

// story 4668 (UX-1 · U1 · design mirko/4668-design.md · copy yuna/ux1-copy-1013.md A-1): after the organization, one fork —
// «에이전트를 어디서 돌릴까요?». Two radio cards (the setup's «시작 방법» cards' shape), the app one chosen by default with the
// «권장» badge, one hero [계속]. No server call here: the app way makes the project and agents in the desktop setup
// (desktop-setup.tsx «첫 프로젝트» · 4496), the web way goes on to the project step. The choice lives in the parent
// (onboarding-form.tsx) because the progress bar follows it (Yuna: app 2/3 · web 2/5).

import { useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { usePhoneBridge } from '@/components/providers/phone-bridge-context';
import { notAMac } from '@/components/desktop/desktop-download-card';

export type WhereChoice = 'app' | 'web';

const noSubscribe = () => () => undefined;

interface WhereStepProps {
  choice: WhereChoice;
  onChoose: (choice: WhereChoice) => void;
  onContinue: () => void;
  /** id of the screen's h1 — the radio group is named by it (the title is the question) */
  titleId: string;
}

export function WhereStep({ choice, onChoose, onContinue, titleId }: WhereStepProps) {
  const t = useTranslations('onboarding.where');
  const to = useTranslations('onboarding');
  // the device is read after mount (null on the server and before the first read — no hydration mismatch), as PhoneAppCard does
  const { inPhoneApp } = usePhoneBridge();
  const elsewhere = useSyncExternalStore(noSubscribe, () => notAMac(navigator.userAgent, inPhoneApp), () => null);

  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-labelledby={titleId} className="flex flex-col gap-2">
        <label className="flex cursor-pointer gap-3 rounded-md border p-3 has-[:checked]:border-primary" data-testid="onboarding-where-app">
          <input
            type="radio"
            name="onboarding-where"
            value="app"
            checked={choice === 'app'}
            onChange={() => onChoose('app')}
            className="mt-1 shrink-0 self-start"
          />
          <span className="min-w-0 break-keep">
            <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-foreground">
              {t('app')}
              <Badge variant="info" className="px-1.5 py-0 text-[9px]">{to('transportRecommended')}</Badge>
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground">{t('appDesc')}</span>
          </span>
        </label>
        <label className="flex cursor-pointer gap-3 rounded-md border p-3 has-[:checked]:border-primary" data-testid="onboarding-where-web">
          <input
            type="radio"
            name="onboarding-where"
            value="web"
            checked={choice === 'web'}
            onChange={() => onChoose('web')}
            className="mt-1 shrink-0 self-start"
          />
          <span className="min-w-0 break-keep">
            <span className="block text-sm font-medium text-foreground">{t('web')}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">{t('webDesc')}</span>
          </span>
        </label>
      </div>
      {/* not a Mac (a phone · another OS) and the app chosen: the Mac app is downloaded on a Mac — the next screen says where */}
      {choice === 'app' && elsewhere === true ? (
        <p className="break-keep text-xs text-muted-foreground" data-testid="onboarding-where-not-mac">{t('notMacNote')}</p>
      ) : null}
      <Button variant="hero" size="lg" className="w-full" onClick={onContinue} data-testid="onboarding-where-continue">
        {t('continue')}
      </Button>
    </div>
  );
}
