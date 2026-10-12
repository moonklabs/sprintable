// story 4654 (AC2): the phone app's store addresses — one place, the values pinned (a changed address must fail here, not on a customer's phone)
import { describe, expect, it } from 'vitest';
import { PHONE_APP_PUBLISHED, PHONE_APP_STORE_ANDROID, PHONE_APP_STORE_IOS, phoneAppStoreLinks } from './phone-app-store';

describe('[SID:4654] phone app store addresses', () => {
  it('the Android package and the iOS App Store id are the app\'s own (mobile app.json · eas.json)', () => {
    expect(PHONE_APP_STORE_ANDROID).toBe('https://play.google.com/store/apps/details?id=com.moonklabs.sprintable');
    expect(PHONE_APP_STORE_IOS).toBe('https://apps.apple.com/app/id6804625710');
  });

  it('nothing is published yet: no link at all (a store the customer cannot open is not shown)', () => {
    expect(PHONE_APP_PUBLISHED).toEqual({ android: false, ios: false });
    expect(phoneAppStoreLinks()).toEqual([]);
    expect(phoneAppStoreLinks({ android: false, ios: false })).toEqual([]);
  });

  it('a published store shows its link (Android first); an unpublished one stays hidden', () => {
    expect(phoneAppStoreLinks({ android: true, ios: true }).map((l) => l.url)).toEqual([PHONE_APP_STORE_ANDROID, PHONE_APP_STORE_IOS]);
    expect(phoneAppStoreLinks({ android: false, ios: true }).map((l) => l.store)).toEqual(['ios']);
    expect(phoneAppStoreLinks({ android: true, ios: false }).map((l) => l.url)).toEqual([PHONE_APP_STORE_ANDROID]);
    for (const l of phoneAppStoreLinks({ android: true, ios: true })) expect(l.url.startsWith('https://')).toBe(true);
  });
});
