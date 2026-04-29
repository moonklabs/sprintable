'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { SprintableLogo } from '@/components/brand/sprintable-logo';
import { LocaleSwitcher } from '@/components/locale-switcher';

type PricingPlan = {
  name: string;
  price: string;
  period: string;
  audience: string;
  features: string[];
};

export function LandingPage() {
  const t = useTranslations('landing');

  const audiences = t.raw('hero.audiences') as string[];
  const freePlan = t.raw('pricing.free') as PricingPlan;
  const teamPlan = t.raw('pricing.team') as PricingPlan;
  const enterprisePlan = t.raw('pricing.pro') as PricingPlan;

  const valueCards = [
    {
      eyebrow: t('value.story.eyebrow'),
      title: t('value.story.title'),
      description: t('value.story.desc'),
    },
    {
      eyebrow: t('value.clarity.eyebrow'),
      title: t('value.clarity.title'),
      description: t('value.clarity.desc'),
    },
    {
      eyebrow: t('value.proof.eyebrow'),
      title: t('value.proof.title'),
      description: t('value.proof.desc'),
    },
  ];

  const customerCards = [
    {
      title: t('customers.founders.title'),
      description: t('customers.founders.desc'),
      fit: t('customers.founders.fit'),
    },
    {
      title: t('customers.product.title'),
      description: t('customers.product.desc'),
      fit: t('customers.product.fit'),
    },
    {
      title: t('customers.services.title'),
      description: t('customers.services.desc'),
      fit: t('customers.services.fit'),
    },
  ];

  const modelCards = [
    {
      eyebrow: 'BYOA',
      title: t('model.byoa.title'),
      description: t('model.byoa.desc'),
      bullets: t.raw('model.byoa.bullets') as string[],
      accent: 'border-[#414754]/40 bg-[#15181b]',
      bulletAccent: 'text-[#00daf3]',
    },
    {
      eyebrow: 'Premium',
      title: t('model.serving.title'),
      description: t('model.serving.desc'),
      bullets: t.raw('model.serving.bullets') as string[],
      accent: 'border-[#b6c4ff]/35 bg-[#1b1f28]',
      bulletAccent: 'text-[#b6c4ff]',
    },
  ];

  const proofSteps = [
    {
      eyebrow: t('proof.step1.eyebrow'),
      title: t('proof.step1.title'),
      description: t('proof.step1.desc'),
    },
    {
      eyebrow: t('proof.step2.eyebrow'),
      title: t('proof.step2.title'),
      description: t('proof.step2.desc'),
    },
    {
      eyebrow: t('proof.step3.eyebrow'),
      title: t('proof.step3.title'),
      description: t('proof.step3.desc'),
    },
    {
      eyebrow: t('proof.step4.eyebrow'),
      title: t('proof.step4.title'),
      description: t('proof.step4.desc'),
    },
  ];

  const pricingPlans = [
    {
      key: 'free',
      plan: freePlan,
      ctaLabel: t('hero.primaryCta'),
      ctaHref: '/login',
      className: 'border border-[#414754]/20 bg-[#15181b]',
      buttonClassName: 'bg-[#2c3138] text-white hover:bg-[#3a4048]',
    },
    {
      key: 'team',
      plan: teamPlan,
      ctaLabel: t('teamTrial'),
      ctaHref: '/login',
      className: 'border border-[#b6c4ff]/30 bg-[linear-gradient(180deg,rgba(182,196,255,0.16),rgba(17,19,22,0.92))] shadow-[0_24px_80px_rgba(104,137,255,0.18)]',
      buttonClassName: 'bg-[#b6c4ff] text-[#002780] hover:bg-[#9fb1ff]',
      badge: t('tagPopular'),
    },
    {
      key: 'enterprise',
      plan: enterprisePlan,
      ctaLabel: t('contactSales'),
      ctaHref: '/login',
      className: 'border border-[#414754]/20 bg-[#15181b]',
      buttonClassName: 'bg-white/10 text-white hover:bg-white/15',
    },
  ];

  return (
    <div className="min-h-screen bg-[#0f1115] text-[#edf1f7] font-[Inter] selection:bg-[#b6c4ff]/30">
      <nav className="fixed inset-x-0 top-0 z-50 border-b border-white/10 bg-[#0f1115]/85 backdrop-blur-xl">
        <div className="mx-auto flex h-20 max-w-7xl items-center justify-between gap-4 px-5 sm:px-6">
          <Link href="/" className="shrink-0">
            <SprintableLogo
              variant="horizontal"
              className="text-white"
              markClassName="h-7"
              wordmarkClassName="text-[0.9rem] tracking-[0.14em]"
            />
          </Link>

          <div className="hidden items-center gap-6 lg:flex">
            <a className="text-sm font-semibold text-[#cbd3e1] transition hover:text-white" href="#value">{t('navProduct')}</a>
            <a className="text-sm font-semibold text-[#cbd3e1] transition hover:text-white" href="#customers">{t('navCustomers')}</a>
            <a className="text-sm font-semibold text-[#cbd3e1] transition hover:text-white" href="#model">{t('navModel')}</a>
            <a className="text-sm font-semibold text-[#cbd3e1] transition hover:text-white" href="#proof">{t('navProof')}</a>
            <a className="text-sm font-semibold text-[#cbd3e1] transition hover:text-white" href="#pricing">{t('navPricing')}</a>
          </div>

          <div className="flex items-center gap-3 sm:gap-4">
            <LocaleSwitcher />
            <a href="https://github.com/moonklabs/sprintable" target="_blank" rel="noopener noreferrer" className="hidden text-sm font-semibold text-[#aeb7c8] transition hover:text-white sm:inline-flex">{t('github')}</a>
            <Link href="/login" className="rounded-full bg-[#b6c4ff] px-4 py-2 text-sm font-bold text-[#002780] transition hover:bg-[#9fb1ff] sm:px-6">{t('hero.primaryCta')}</Link>
          </div>
        </div>
      </nav>

      <main className="overflow-x-hidden pb-28 pt-20 md:pb-0">
        <section className="relative px-5 pb-20 pt-12 sm:px-6 sm:pb-24 sm:pt-16">
          <div className="absolute inset-x-0 top-0 -z-10 h-[540px] bg-[radial-gradient(circle_at_top_left,rgba(182,196,255,0.18),transparent_45%),radial-gradient(circle_at_top_right,rgba(0,218,243,0.12),transparent_40%)]" />
          <div className="mx-auto grid max-w-7xl gap-10 xl:grid-cols-[1.08fr_0.92fr] xl:items-center">
            <div className="space-y-8">
              <div className="inline-flex items-center gap-3 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs">
                <span className="rounded-full bg-[#00daf3]/15 px-2 py-1 font-bold uppercase tracking-[0.2em] text-[#00daf3]">{t('badge')}</span>
                <span className="text-[#c5cede]">{t('badgeText')}</span>
              </div>

              <div className="space-y-5">
                <p className="text-sm font-semibold uppercase tracking-[0.28em] text-[#8ea2d7]">{t('hero.eyebrow')}</p>
                <h1 className="max-w-4xl text-5xl font-black tracking-[-0.04em] text-white sm:text-6xl xl:text-7xl">{t('hero.headline')}</h1>
                <p className="max-w-3xl text-lg leading-8 text-[#c8d0dc] sm:text-xl">{t('hero.subheadline')}</p>
              </div>

              <div className="flex flex-wrap gap-3">
                {audiences.map((audience) => (
                  <div key={audience} className="rounded-full border border-white/10 bg-[#161920] px-4 py-2 text-sm font-medium text-[#d7def0]">
                    {audience}
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                <Link href="/login" className="inline-flex items-center justify-center rounded-2xl bg-[#b6c4ff] px-6 py-4 text-base font-bold text-[#002780] shadow-[0_18px_48px_rgba(104,137,255,0.24)] transition hover:bg-[#9fb1ff]">{t('hero.primaryCta')}</Link>
                <a href="#proof" className="inline-flex items-center justify-center rounded-2xl border border-white/15 bg-white/5 px-6 py-4 text-base font-semibold text-white transition hover:bg-white/10">{t('hero.secondaryCta')}</a>
                <a href="#pricing" className="inline-flex items-center justify-center rounded-2xl border border-[#b6c4ff]/20 bg-[#151922] px-6 py-4 text-base font-semibold text-[#dbe4ff] transition hover:border-[#b6c4ff]/40 hover:bg-[#1c2230]">{t('hero.pricingCta')}</a>
                <a href="https://github.com/moonklabs/sprintable" target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-center rounded-2xl border border-transparent px-2 py-4 text-sm font-semibold text-[#95a3bc] transition hover:text-white">{t('hero.githubCta')}</a>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                {[
                  { title: t('hero.noteTitle'), body: t('hero.noteBody') },
                  { title: t('model.byoa.title'), body: t('model.byoa.desc') },
                  { title: t('model.serving.title'), body: t('model.serving.desc') },
                ].map((item) => (
                  <div key={item.title} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <p className="mb-2 text-sm font-semibold text-white">{item.title}</p>
                    <p className="text-sm leading-6 text-[#b9c4d6]">{item.body}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="relative">
              <div className="absolute -inset-6 -z-10 rounded-[2rem] bg-[radial-gradient(circle,rgba(182,196,255,0.24),transparent_62%)] blur-3xl" />
              <div className="rounded-[2rem] border border-white/10 bg-[linear-gradient(180deg,rgba(24,28,36,0.96),rgba(13,15,20,0.98))] p-6 shadow-[0_32px_80px_rgba(0,0,0,0.38)] sm:p-8">
                <div className="flex items-center justify-between gap-4 rounded-2xl border border-white/8 bg-white/5 px-4 py-3 text-sm text-[#c7d0de]">
                  <span className="font-semibold text-white">{t('hero.workflowTitle')}</span>
                  <span className="rounded-full border border-[#00daf3]/30 bg-[#00daf3]/10 px-3 py-1 text-xs font-semibold text-[#00daf3]">{t('hero.workflowBadge')}</span>
                </div>

                <div className="mt-6 rounded-3xl border border-white/8 bg-[#12161d] p-5">
                  <p className="text-sm leading-6 text-[#b9c4d6]">{t('hero.workflowSummary')}</p>
                  <div className="mt-6 space-y-4">
                    {[
                      { label: t('hero.workflowStoryLabel'), value: t('hero.workflowStoryValue') },
                      { label: t('hero.workflowMemoLabel'), value: t('hero.workflowMemoValue') },
                      { label: t('hero.workflowShipLabel'), value: t('hero.workflowShipValue') },
                    ].map((step, index) => (
                      <div key={step.label} className="flex gap-4 rounded-2xl border border-white/6 bg-white/[0.03] p-4">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#b6c4ff]/15 font-bold text-[#b6c4ff]">0{index + 1}</div>
                        <div className="space-y-1">
                          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#8ea2d7]">{step.label}</p>
                          <p className="text-sm leading-6 text-[#eef2f7]">{step.value}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="value" className="px-5 py-20 sm:px-6">
          <div className="mx-auto max-w-7xl">
            <div className="max-w-3xl space-y-4">
              <p className="text-sm font-semibold uppercase tracking-[0.28em] text-[#8ea2d7]">{t('value.label')}</p>
              <h2 className="text-4xl font-black tracking-[-0.03em] text-white sm:text-5xl">{t('value.title')}</h2>
              <p className="text-lg leading-8 text-[#c4cddd]">{t('value.subtitle')}</p>
            </div>

            <div className="mt-10 grid gap-6 lg:grid-cols-3">
              {valueCards.map((card) => (
                <div key={card.title} className="rounded-3xl border border-white/10 bg-[#14181f] p-7">
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[#00daf3]">{card.eyebrow}</p>
                  <h3 className="mt-4 text-2xl font-bold text-white">{card.title}</h3>
                  <p className="mt-4 text-sm leading-7 text-[#bcc7d7]">{card.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="customers" className="bg-[#11151b] px-5 py-20 sm:px-6">
          <div className="mx-auto max-w-7xl">
            <div className="max-w-3xl space-y-4">
              <p className="text-sm font-semibold uppercase tracking-[0.28em] text-[#8ea2d7]">{t('customers.label')}</p>
              <h2 className="text-4xl font-black tracking-[-0.03em] text-white sm:text-5xl">{t('customers.title')}</h2>
              <p className="text-xl font-semibold text-[#b6c4ff]">{t('customers.tagline')}</p>
              <p className="text-lg leading-8 text-[#c4cddd]">{t('customers.subtitle')}</p>
            </div>

            <div className="mt-10 grid gap-6 lg:grid-cols-3">
              {customerCards.map((card) => (
                <div key={card.title} className="flex h-full flex-col rounded-3xl border border-white/10 bg-[#151922] p-7">
                  <h3 className="text-2xl font-bold text-white">{card.title}</h3>
                  <p className="mt-4 flex-1 text-sm leading-7 text-[#bcc7d7]">{card.description}</p>
                  <div className="mt-6 rounded-2xl border border-[#b6c4ff]/15 bg-[#b6c4ff]/8 p-4 text-sm leading-6 text-[#e3eaff]">
                    {card.fit}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="model" className="px-5 py-20 sm:px-6">
          <div className="mx-auto max-w-7xl">
            <div className="max-w-3xl space-y-4">
              <p className="text-sm font-semibold uppercase tracking-[0.28em] text-[#8ea2d7]">{t('model.label')}</p>
              <h2 className="text-4xl font-black tracking-[-0.03em] text-white sm:text-5xl">{t('model.title')}</h2>
              <p className="text-lg leading-8 text-[#c4cddd]">{t('model.subtitle')}</p>
            </div>

            <div className="mt-10 grid gap-6 lg:grid-cols-2">
              {modelCards.map((card) => (
                <div key={card.title} className={`rounded-3xl p-7 ${card.accent}`}>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[#8ea2d7]">{card.eyebrow}</p>
                  <h3 className="mt-4 text-2xl font-bold text-white">{card.title}</h3>
                  <p className="mt-4 text-sm leading-7 text-[#c4cddd]">{card.description}</p>
                  <ul className="mt-6 space-y-3">
                    {card.bullets.map((bullet) => (
                      <li key={bullet} className="flex gap-3 text-sm leading-6 text-[#edf1f7]">
                        <span className={card.bulletAccent}>✦</span>
                        <span>{bullet}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <div className="mt-6 rounded-3xl border border-[#b6c4ff]/20 bg-[#151a24] p-6">
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[#b6c4ff]">{t('model.bridgeTitle')}</p>
              <p className="mt-3 max-w-4xl text-base leading-7 text-[#d6dff1]">{t('model.bridgeBody')}</p>
            </div>
          </div>
        </section>

        <section id="proof" className="bg-[#11151b] px-5 py-20 sm:px-6">
          <div className="mx-auto max-w-7xl">
            <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
              <div className="space-y-4 lg:sticky lg:top-28">
                <p className="text-sm font-semibold uppercase tracking-[0.28em] text-[#8ea2d7]">{t('proof.label')}</p>
                <h2 className="text-4xl font-black tracking-[-0.03em] text-white sm:text-5xl">{t('proof.title')}</h2>
                <p className="text-lg leading-8 text-[#c4cddd]">{t('proof.subtitle')}</p>
              </div>

              <div className="grid gap-5">
                {proofSteps.map((step) => (
                  <div key={step.title} className="rounded-3xl border border-white/10 bg-[#151922] p-6">
                    <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[#00daf3]">{step.eyebrow}</p>
                    <h3 className="mt-3 text-2xl font-bold text-white">{step.title}</h3>
                    <p className="mt-4 text-sm leading-7 text-[#bcc7d7]">{step.description}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section id="pricing" className="px-5 py-20 sm:px-6">
          <div className="mx-auto max-w-7xl">
            <div className="max-w-3xl space-y-4">
              <p className="text-sm font-semibold uppercase tracking-[0.28em] text-[#8ea2d7]">{t('pricingLabel')}</p>
              <h2 className="text-4xl font-black tracking-[-0.03em] text-white sm:text-5xl">{t('pricing.title')}</h2>
              <p className="text-lg leading-8 text-[#c4cddd]">{t('pricing.subtitle')}</p>
            </div>

            <div className="mt-10 grid gap-6 xl:grid-cols-3">
              {pricingPlans.map(({ key, plan, ctaLabel, ctaHref, className, buttonClassName, badge }) => (
                <div key={key} className={`relative flex h-full flex-col rounded-3xl p-7 ${className}`}>
                  {badge ? (
                    <div className="absolute right-6 top-0 -translate-y-1/2 rounded-full bg-[#b6c4ff] px-3 py-1 text-[10px] font-black uppercase tracking-[0.24em] text-[#002780]">{badge}</div>
                  ) : null}
                  <div>
                    <h3 className="text-2xl font-bold text-white">{plan.name}</h3>
                    <p className="mt-3 text-sm font-medium text-[#bfc9db]">{plan.audience}</p>
                    <div className="mt-6 flex items-end gap-1 text-white">
                      <span className="text-5xl font-black tracking-[-0.04em]">{plan.price}</span>
                      {plan.period ? <span className="pb-1 text-sm text-[#aeb7c8]">{plan.period}</span> : null}
                    </div>
                  </div>
                  <ul className="mt-8 flex-1 space-y-3">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex gap-3 text-sm leading-6 text-[#ecf1f8]">
                        <span className="text-[#b6c4ff]">✓</span>
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                  <Link href={ctaHref} className={`mt-8 inline-flex items-center justify-center rounded-2xl px-5 py-3 text-sm font-bold transition ${buttonClassName}`}>
                    {ctaLabel}
                  </Link>
                </div>
              ))}
            </div>

            <div className="mt-6 rounded-3xl border border-white/10 bg-white/5 p-5 text-sm leading-7 text-[#d3dbe9]">
              {t('pricingFootnote')}
            </div>
          </div>
        </section>

        <section className="relative overflow-hidden px-5 py-20 sm:px-6">
          <div className="absolute inset-x-0 top-1/2 -z-10 mx-auto h-[360px] max-w-5xl -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(182,196,255,0.2),transparent_70%)] blur-3xl" />
          <div className="mx-auto max-w-5xl rounded-[2rem] border border-[#b6c4ff]/15 bg-[linear-gradient(180deg,rgba(20,24,31,0.96),rgba(12,14,18,0.98))] p-8 text-center shadow-[0_24px_80px_rgba(0,0,0,0.35)] sm:p-12">
            <p className="text-sm font-semibold uppercase tracking-[0.28em] text-[#8ea2d7]">{t('finalCta.label')}</p>
            <h2 className="mt-4 text-4xl font-black tracking-[-0.03em] text-white sm:text-5xl">{t('finalCta.title')}</h2>
            <p className="mx-auto mt-5 max-w-3xl text-lg leading-8 text-[#c4cddd]">{t('finalCta.desc')}</p>
            <div className="mt-10 flex flex-col justify-center gap-4 sm:flex-row">
              <Link href="/login" className="inline-flex items-center justify-center rounded-2xl bg-[#b6c4ff] px-6 py-4 text-base font-bold text-[#002780] transition hover:bg-[#9fb1ff]">{t('finalCta.primary')}</Link>
              <Link href="/docs" className="inline-flex items-center justify-center rounded-2xl border border-white/15 bg-white/5 px-6 py-4 text-base font-semibold text-white transition hover:bg-white/10">{t('finalCta.secondary')}</Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/10 bg-[#0f1115] px-5 py-16 sm:px-6">
        <div className="mx-auto grid max-w-7xl gap-10 md:grid-cols-4 xl:grid-cols-[1.4fr_0.8fr_0.8fr_0.8fr]">
          <div>
            <SprintableLogo
              variant="horizontal"
              className="text-white"
              markClassName="h-6"
              wordmarkClassName="text-[0.72rem] tracking-[0.12em]"
            />
            <p className="mt-4 max-w-sm text-sm leading-7 text-[#9eaabd]">{t('footerDesc')}</p>
            <div className="mt-6 flex gap-4 text-sm font-semibold text-[#cbd3e1]">
              <a href="https://github.com/moonklabs/sprintable" target="_blank" rel="noopener noreferrer" className="transition hover:text-white">{t('github')}</a>
              <Link href="/docs" className="transition hover:text-white">{t('footerDocs')}</Link>
            </div>
          </div>

          <div>
            <h3 className="text-xs font-black uppercase tracking-[0.24em] text-white">{t('navProduct')}</h3>
            <div className="mt-5 flex flex-col gap-3 text-sm text-[#9eaabd]">
              <a href="#value" className="transition hover:text-white">{t('navProduct')}</a>
              <a href="#proof" className="transition hover:text-white">{t('navProof')}</a>
              <a href="#pricing" className="transition hover:text-white">{t('footerChangelog')}</a>
            </div>
          </div>

          <div>
            <h3 className="text-xs font-black uppercase tracking-[0.24em] text-white">{t('footerCompany')}</h3>
            <div className="mt-5 flex flex-col gap-3 text-sm text-[#9eaabd]">
              <a href="#customers" className="transition hover:text-white">{t('footerAbout')}</a>
              <a href="#model" className="transition hover:text-white">{t('footerCareers')}</a>
              <a href="#proof" className="transition hover:text-white">{t('footerBlog')}</a>
            </div>
          </div>

          <div>
            <h3 className="text-xs font-black uppercase tracking-[0.24em] text-white">{t('footerResources')}</h3>
            <div className="mt-5 flex flex-col gap-3 text-sm text-[#9eaabd]">
              <Link href="/docs" className="transition hover:text-white">{t('footerDocs')}</Link>
              <a href="#pricing" className="transition hover:text-white">{t('navPricing')}</a>
              <a href="https://github.com/moonklabs/sprintable" target="_blank" rel="noopener noreferrer" className="transition hover:text-white">{t('footerCommunity')}</a>
            </div>
          </div>
        </div>

        <div className="mx-auto mt-12 flex max-w-7xl flex-col gap-4 border-t border-white/10 pt-6 text-sm text-[#9eaabd] md:flex-row md:items-center md:justify-between">
          <p>{t('footerCopyright')}</p>
          <div className="inline-flex items-center gap-2 rounded-full border border-[#b6c4ff]/15 bg-[#b6c4ff]/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-[#d8e1ff]">
            <span className="h-2 w-2 rounded-full bg-[#00daf3]" />
            {t('sysOperational')}
          </div>
        </div>
      </footer>

      <div className="fixed inset-x-0 bottom-4 z-40 px-4 md:hidden">
        <div className="mx-auto flex max-w-md items-center gap-3 rounded-3xl border border-white/10 bg-[#12161d]/95 p-3 shadow-[0_20px_60px_rgba(0,0,0,0.45)] backdrop-blur-xl">
          <Link href="/login" className="flex-1 rounded-2xl bg-[#b6c4ff] px-4 py-3 text-center text-sm font-bold text-[#002780]">
            {t('hero.primaryCta')}
          </Link>
          <a href="#pricing" className="flex-1 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-center text-sm font-semibold text-white">
            {t('hero.pricingCta')}
          </a>
        </div>
      </div>
    </div>
  );
}
