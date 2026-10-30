# Security Policy

## Reporting a Vulnerability

**Do NOT open a public issue for security vulnerabilities.**

Instead, please email: **security@moonklabs.com**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Response Timeline

- **Acknowledgement**: Within 48 hours
- **Initial assessment**: Within 5 business days
- **Fix release**: Best effort, typically within 30 days

## Scope

- Authentication and authorization bypasses
- Data exposure or leakage
- SQL injection, XSS, CSRF
- Payment/billing manipulation
- API key exposure

## Agent permission prompts (a switch an owner may use)

Each agent has a server-side setting, **Work without asking** (`agent_run_profiles.unattended`, default off). Only an active organization owner can turn it on; when it is
on, the desktop app starts that agent's next session in the Claude Code CLI's `bypassPermissions` mode, so tools run without a permission prompt and what the agent may do
follows the Claude Code settings of the computer it runs on — Sprintable adds no sandbox or deny list of its own. An owner turning it on is intended behaviour (the product does
not decide what your agents may do), not a vulnerability. These **are** vulnerabilities: anyone other than an owner being able to change it; it being changed without the
owner's intent (for example a cross-site request that flips it); and the change not being recorded with who made it. Details, and the usage-record switch (`DISABLE_ANALYTICS`):
[docs/usage-records-and-permission-switches.md](docs/usage-records-and-permission-switches.md).

## Out of Scope

- Denial of service (DoS)
- Social engineering
- Issues in third-party dependencies (report upstream)

## Recognition

We credit security researchers in our release notes (with permission).

Thank you for helping keep Sprintable secure! 🔒
