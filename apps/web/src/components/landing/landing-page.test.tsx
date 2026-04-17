import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '../../../messages/en.json';
import koMessages from '../../../messages/ko.json';
import { LandingPage } from './landing-page';

describe('LandingPage', () => {
  it('renders the completed landing IA with audience, pricing, proof, and clear CTA paths', () => {
    const markup = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Seoul">
        <LandingPage />
      </NextIntlClientProvider>,
    );

    expect(markup).toContain('From BYOA pilots to agent teams that ship');
    expect(markup).toContain('Who Sprintable is for');
    expect(markup).toContain('Choose your AI operating model');
    expect(markup).toContain('Proof, not platform theater');
    expect(markup).toContain('Pricing that grows with your workflow');
    expect(markup).toContain('See live workflow');
    expect(markup).toContain('View pricing');

    const loginLinks = markup.match(/href="\/login"/g) ?? [];
    const pricingLinks = markup.match(/href="#pricing"/g) ?? [];

    expect(loginLinks.length).toBeGreaterThanOrEqual(3);
    expect(pricingLinks.length).toBeGreaterThanOrEqual(2);
  });

  it('renders the Korean locale without missing landing translations', () => {
    const markup = renderToStaticMarkup(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <LandingPage />
      </NextIntlClientProvider>,
    );

    expect(markup).toContain('BYOA 실험에서 실제로 배포하는 에이전트 팀까지');
    expect(markup).toContain('Sprintable이 맞는 팀');
    expect(markup).toContain('AI 운영 모델을 선택하는');
    expect(markup).toContain('워크플로우와 함께 커지는 요금제');
    expect(markup).not.toContain('MISSING_MESSAGE');
  });
});
