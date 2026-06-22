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

## Linking PRs to Stories

Sprintable's approval gates can auto-link a PR to its story so a gate reflects the real
CI/merge outcome. Contributors in this repository may opt to tag a PR by including a
`sid-<story-uuid>` segment in the branch name (or `[SID:<story-uuid>]` in the PR body) —
this is **optional**, and untagged PRs are handled gracefully. The detailed tagging
conventions used by this repo's own agents live in [`AGENTS.md`](AGENTS.md).

Convention-free linking for product use (in-app, no branch/PR naming rules) is planned
and provided separately — the tagging above is an internal convenience, not a
requirement for using Sprintable.

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

## Contributing Workflow Templates

Workflow templates let contributors add new multi-step automation patterns without touching routing rule logic. See [`docs/workflow-templates.md`](docs/workflow-templates.md) for the full spec.

### Adding a new template

1. Add an entry to `SEED_TEMPLATES` in `backend/alembic/versions/0016_add_workflow_templates.py`.
2. Each entry needs: `slug`, `name`, `description`, `chain_length`, `steps`, `presets`, `rules_template`.
3. Use `step_1`, `step_2`, ... as `role_ref` placeholders — they are resolved at apply time.
4. Set `is_system: false` for community templates (users can delete them).
5. Write a pytest test in `backend/tests/test_e2e_workflow_template.py` asserting the correct rule count after `apply_template`.
6. Run `alembic upgrade head` locally and verify `GET /api/v2/workflow-templates` returns your new template.

### Template schema quick reference

```python
{
  "slug": "my-template",
  "name": "My Template",
  "description": "Short description",
  "chain_length": 2,
  "steps": [
    {"pattern": "assign", "role_ref": "step_1", "default_label": "Maker"},
    {"pattern": "review", "role_ref": "step_2", "default_label": "Reviewer"},
  ],
  "presets": {"default": {"step_1": "Writer", "step_2": "Editor"}},
  "rules_template": [
    {
      "role_ref": "step_1",
      "name": "{step_1} kickoff",
      "priority": 10,
      "match_type": "event",
      "conditions": {"memo_type": ["task"], "trigger_type_slugs": ["kickoff"]},
      "action": {"auto_reply_mode": "process_and_report", "side_effects": []},
    }
  ],
}
```

## Code of Conduct

Be respectful. Be constructive. We're all here to build something great.

## Questions?

Open a [Discussion](https://github.com/moonklabs/sprintable/discussions) or reach out on our community channels.
