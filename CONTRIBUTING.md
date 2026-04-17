# Contributing to Sprintable

Thank you for your interest in contributing! 🎉

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/sprintable.git`
3. Install dependencies: `pnpm install`
4. Create a branch: `git checkout -b feat/your-feature`

## Development Workflow

```bash
pnpm dev           # Start dev server
pnpm lint          # Check linting
pnpm type-check    # TypeScript check
pnpm test          # Run tests
pnpm build         # Production build
```

## Pull Request Process

1. **Branch naming**: `feat/description`, `fix/description`, `refactor/description`
2. **Commit messages**: Follow [Conventional Commits](https://www.conventionalcommits.org/)
   - `feat(scope): description`
   - `fix(scope): description`
   - `refactor(scope): description`
3. **PR requirements**:
   - All CI checks must pass (lint, type-check, test, build)
   - Include a clear description of changes
   - Reference related issues
   - Screenshots for UI changes
4. **Review**: At least one approval required before merge

## Code Style

- **TypeScript strict mode** — no `any` unless absolutely necessary
- **Tailwind CSS** — utility-first, no custom CSS unless needed
- **ESLint** — follow the existing config
- **Zod** — all API inputs validated with Zod schemas
- **Error handling** — use `apiSuccess`/`ApiErrors`/`handleApiError` patterns

## Commit Convention

```
feat(meetings): add AI summarize button
fix(billing): correct invoice PDF link
refactor(auth): simplify middleware chain
docs: update README installation guide
test(stories): add validation tests
```

## Issue Templates

- **Bug Report**: Use the bug report template
- **Feature Request**: Use the feature request template

## OSS Stub Files (SaaS Overlay Boundary)

The following files are intentional **OSS stubs** that return always-allow /
no-op / zero values. They exist so OSS single-user builds compile without
the proprietary `@moonklabs/sprintable-saas` overlay. In a SaaS-composed
build, a submodule overlay replaces the runtime behavior via the DI
registry (see `apps/web/src/lib/storage/factory.ts` —
`registerSubscriptionRepository` / `registerAgentRunBillingRepository`).

| Stub file | OSS behavior |
|---|---|
| `apps/web/src/lib/check-feature.ts` | all feature gates return `{ allowed: true }` |
| `apps/web/src/lib/usage-check.ts` | usage always zero, `incrementUsage` no-op |
| `apps/web/src/services/agent-run-billing.ts` | cost=0, `billingNotes: ['oss_no_charge']` |
| `apps/web/src/services/billing-limit-enforcer.ts` | `enforceBeforeRun` always `allow`, `enforceAfterRun` no-op |
| `apps/web/src/components/settings/usage-dashboard.tsx` | shows "disabled in OSS mode" notice |

Contributors should **not** reimplement billing logic in these files — if
you need feature gating, add an optional Repository via the registry
pattern and keep the public surface BYOA-neutral.

## Code of Conduct

Be respectful. Be constructive. We're all here to build something great.

## Questions?

Open a [Discussion](https://github.com/moonklabs/sprintable/discussions) or reach out on our community channels.
