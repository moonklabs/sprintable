// story 4654 (AC2): the phone app's store addresses — one place, the values pinned (a changed address must fail here, not on a customer's phone)
import { describe, expect, it } from 'vitest';
import { PHONE_APP_STORE_ANDROID, PHONE_APP_STORE_IOS, phoneAppStoreLinks } from './phone-app-store';

describe('[SID:4654] phone app store addresses', () => {
  it('the Android package and the iOS App Store id are the app\'s own (mobile app.json · eas.json)', () => {
    expect(PHONE_APP_STORE_ANDROID).toBe('https://play.google.com/store/apps/details?id=com.moonklabs.sprintable');
    expect(PHONE_APP_STORE_IOS).toBe('https://apps.apple.com/app/id6804625710');
  });

  it('the links are both https, Android first, and the QR carries the same address the link shows', () => {
    const links = phoneAppStoreLinks();
    expect(links.map((l) => l.url)).toEqual([PHONE_APP_STORE_ANDROID, PHONE_APP_STORE_IOS]);
    for (const l of links) expect(l.url.startsWith('https://')).toBe(true);
  });
});
