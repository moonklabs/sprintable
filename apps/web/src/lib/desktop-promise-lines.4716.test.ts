// story 4716 (UX-1 · 글) AC2 — the three «what happens after you open the Mac app» lines promise only what is true on BOTH app builds:
// today the app shows its own sign-in screen (the person goes in with the same account); with the browser hand-off (story 4712 · the app
// opens the browser and the person presses [열기]) it is a press, not a sign-in. So the lines say «go in with the same account» and never
//  — «열기만 하면» / "just open the app" (a sign-in or a press always stands between), «브라우저가 … 열려요» (not true before 4712 lands),
//  — «로그인하면 돼요» (not true after it). Measured on the installed app (dev build 39fb67b9e): the first window is /login, not a browser.
import { describe, expect, it } from 'vitest';
import ko from '../../messages/ko.json';
import en from '../../messages/en.json';

const lines = {
  ko: [ko.onboarding.download.afterNote, ko.onboarding.desktopOpenAppNote, ko.onboarding.first.macLead],
  en: [en.onboarding.download.afterNote, en.onboarding.desktopOpenAppNote, en.onboarding.first.macLead],
};

describe('4716 AC2 — the Mac app promise lines', () => {
  it('each ko line says the person goes in with the same / this account', () => {
    for (const l of lines.ko) expect(l, l).toMatch(/(같은|이) 계정으로 들어가/);
  });
  it('each en line says the person continues with the same / this account', () => {
    for (const l of lines.en) expect(l, l).toMatch(/continue with (the same|this) account/);
  });
  it('no line promises «only open it», a browser that opens by itself, or a sign-in the browser hand-off does not have', () => {
    for (const l of lines.ko) {
      expect(l, l).not.toMatch(/열기만/);
      expect(l, l).not.toMatch(/브라우저가/);
      expect(l, l).not.toMatch(/로그인하면/);
    }
    for (const l of lines.en) {
      expect(l, l).not.toMatch(/just open/i);
      expect(l, l).not.toMatch(/browser continues/i);
      expect(l, l).not.toMatch(/sign in/i);
    }
  });
});
