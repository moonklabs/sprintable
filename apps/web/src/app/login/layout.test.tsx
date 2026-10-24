// story #4763 AC6 — the server layout of /login hands the download switch (read on the server only) down to the page.
import { afterEach, describe, expect, it, vi } from 'vitest';
import LoginLayout from './layout';
import { MacAppOfferProvider } from './mac-app-offer';

afterEach(() => { vi.unstubAllEnvs(); });

describe('[SID:4763 AC6] /login layout', () => {
  it('DESKTOP_DOWNLOAD_ENABLED === "true" → the offer is on; unset or anything else → off', () => {
    vi.stubEnv('DESKTOP_DOWNLOAD_ENABLED', 'true');
    const on = LoginLayout({ children: null });
    expect(on.type).toBe(MacAppOfferProvider);
    expect(on.props.enabled).toBe(true);
    vi.stubEnv('DESKTOP_DOWNLOAD_ENABLED', 'false');
    expect(LoginLayout({ children: null }).props.enabled).toBe(false);
    vi.stubEnv('DESKTOP_DOWNLOAD_ENABLED', '');
    expect(LoginLayout({ children: null }).props.enabled).toBe(false);
  });
});
