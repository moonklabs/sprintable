// story #4763 AC6 — the server layout of /login hands the download switch (read on the server only) down to the page.
import { afterEach, describe, expect, it, vi } from 'vitest';
import LoginLayout from './layout';
import { MacAppOfferProvider } from './mac-app-offer';

afterEach(() => { vi.unstubAllEnvs(); });

describe('[SID:4763 AC6] /login layout', () => {
  it('DESKTOP_DOWNLOAD_ENABLED === "true" → the offer is on; unset or anything else → off', () => {
    vi.stubEnv('DESKTOP_DOWNLOAD_BUCKET', 'sprintable-desktop-releases-dev');
    vi.stubEnv('DESKTOP_DOWNLOAD_ENABLED', 'true');
    const on = LoginLayout({ children: null });
    expect(on.type).toBe(MacAppOfferProvider);
    expect(on.props.enabled).toBe(true);
    vi.stubEnv('DESKTOP_DOWNLOAD_ENABLED', 'false');
    expect(LoginLayout({ children: null }).props.enabled).toBe(false);
    vi.stubEnv('DESKTOP_DOWNLOAD_ENABLED', '');
    expect(LoginLayout({ children: null }).props.enabled).toBe(false);
  });

  // «받기» is the file itself (/desktop/get/macos): the switch on with no usable bucket would draw a link that can only answer 502
  it('the switch on but no usable bucket (unset · empty · not a plain bucket name) → the offer is off', () => {
    vi.stubEnv('DESKTOP_DOWNLOAD_ENABLED', 'true');
    for (const bucket of [undefined, '', '  ', 'a/b', 'x.y']) {
      if (bucket === undefined) vi.stubEnv('DESKTOP_DOWNLOAD_BUCKET', undefined as unknown as string);
      else vi.stubEnv('DESKTOP_DOWNLOAD_BUCKET', bucket);
      expect(LoginLayout({ children: null }).props.enabled, String(bucket)).toBe(false);
    }
  });
});
