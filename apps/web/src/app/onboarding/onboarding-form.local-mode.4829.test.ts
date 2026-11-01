// story 4829 — the form hands `localMode` on to the connect step. Pinned in the source (as this repo does for a prop that only travels): reaching the connect step in a mounted
// form takes a whole sign-up, and the two ends of this hop are tested on their own (page.4829.test.tsx · connect-step.4829.test.tsx).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, 'onboarding-form.tsx'), 'utf8');

describe('[SID:4829] OnboardingForm → ConnectStep', () => {
  it('takes a `localMode` prop (default false = hosted) and gives it to <ConnectStep>', () => {
    expect(src).toMatch(/localMode\?: boolean;/);
    expect(src).toMatch(/macDownloadEnabled = false, afterOrgDelete = false, localMode = false,/);
    const connect = src.slice(src.indexOf('<ConnectStep'), src.indexOf('/>', src.indexOf('<ConnectStep')));
    expect(connect).toContain('localMode={localMode}');
  });
});
