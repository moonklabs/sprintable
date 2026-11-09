# Usage records and the "Work without asking" switch

Two things in Sprintable are easy to miss and worth knowing before you run it for other people. This page says what they are, where they live in the source, and how to turn
them off (or leave them off). It is meant to be read once, in full.

Sprintable does not decide what **your** agents may or may not do. It gives you the switches and tells you what each one does.

---

## 1. Usage records: what is reported, and where to turn it off

There are two different things, and the page keeps them apart.

**A. Reported to a third party — the Google Analytics tag.** A build from this repository reports no usage to any third party. The only code in the source that does is the Google Analytics
tag of the web app, and it exists only in a build that was given a measurement id.

| What | Where in the source | When it is active | How to turn it off |
|---|---|---|---|
| Google Analytics 4 tag (page path, page address without query, referrer without query, one `sign_up` event) | `apps/web/src/components/google-analytics.tsx` (the tag: `GA_ID` at the top, the script at the bottom); mounted only by `apps/web/src/components/analytics-gate.tsx`, which the root layout `apps/web/src/app/layout.tsx` renders | Only if the web build was made with `NEXT_PUBLIC_GA4_MEASUREMENT_ID` set (`apps/web/Dockerfile`, build argument). The default `docker compose` build does not set it. | Leave `NEXT_PUBLIC_GA4_MEASUREMENT_ID` empty at build time, **or** set **`DISABLE_ANALYTICS=true`** in the web server's environment (read on every request, no rebuild). |
| Cloudflare Web Analytics beacon | Not in the source. If your site is served through a Cloudflare zone with Web Analytics on, Cloudflare injects it at its edge. The app's content-security policy (`apps/web/next.config.ts`) allows its hosts so it does not raise a console error. | Only behind such a zone. | Switch Web Analytics off in the Cloudflare dashboard; or do not put the site behind that zone. |

What the tag never sends: the query string or the `#` part of an address, and nothing at all from screens that carry a one-time value (password reset, invitation, share links,
the desktop pairing screens). That list is in `google-analytics.tsx` (`NO_ANALYTICS_SEGMENTS`, `ONE_TIME_QUERY_KEYS`) and is pinned by tests.

**`DISABLE_ANALYTICS`.** Unset, empty, `0`, `false`, `no`, `off` and `n` keep the tag as it was built. Any other value turns it off — deliberately, so that a typo (`ture`) stops the
sending instead of leaving it on. With the switch on, the page is served without the tag: no script, no `gtag`, no `dataLayer`, no request to a Google host.
(Measured in a real browser with a measurement id baked in: with the switch on, 0 requests to Google on three screens, a repeat of one of them with a query, and one client-side move,
and no `_ga` cookie; with the switch unset, the tag is requested. The test is `apps/web/e2e/ga-off.4822.spec.ts`, run with `pnpm e2e:ga-off` in `apps/web`.)

One more thing worth saying plainly: with the content-security policy this repository ships, a browser **refuses** to load the Google tag even in a build that has an id
(`script-src` and `connect-src` do not list Google's hosts). So the tag, as shipped, reports nothing until someone also widens the policy on purpose.

**B. Recorded by Sprintable on the server the person uses — the setup funnel.** These are not sent to anyone else, and `DISABLE_ANALYTICS` does **not** govern them, because the
product itself reads them to work (for example the agent connection check looks for `verify_started`, and the desktop setup screen shows its status from them).

| Sender | Where in the source | Goes to |
|---|---|---|
| The web app's setup screens (7 events: `onboarding_started`, `config_copied`, `verify_started`, `abandoned_explicit`, `desktop_handoff_selected`, `desktop_key_copied`, `desktop_doc_opened`; a random per-wizard id, the agent id, the runtime, a failure reason, a client time) | `apps/web/src/app/onboarding/onboarding-telemetry.ts` (`emitOnboardingEvent`, `beaconOnboardingEvent`), called from the onboarding, connect and recruiter screens and `components/desktop/desktop-setup-doc-watch.tsx`; the web server relays it in `apps/web/src/app/api/onboarding/events/route.ts` | `POST /api/v2/onboarding/events` of the backend the web app is configured with → table `onboarding_events` |
| The desktop app's setup shell (named events keyed by the setup id; the names are listed in `backend/app/services/onboarding_funnel.py`, `DESKTOP_SHELL_EMIT_EVENTS`) | in the desktop app repository: `desktop-electron/src/setup-wiring.ts` (the request), `shell-events.ts` (the names) | the same endpoint of the server the app is connected to |
| The backend's own steps (agent created, config generated, first authentication seen, stream connected, verified … ; `BE_EMIT_EVENTS`) | `emit_onboarding_event(...)` in `backend/app/routers/agents.py`, `routers/agent_gateway.py`, `services/desktop_setup.py`; the list in `backend/app/services/onboarding_funnel.py` | the same table |

On a self-hosted install these rows stay in your own database. They carry no page content, no message text and no key (the desktop shell's rule: never a path or a key in `meta`).
If you want the measurement-only ones switchable too, that is a separate decision, because some of the same names are read by the product.

Also in the source, and easy to mistake for a sender: `apps/web/src/app/(authenticated)/organization/channels/page.tsx` shows a copy-paste snippet that a person can put on **their own website**
to count page views (`/api/v2/public/pageview`). Sprintable itself does not send it.

What Sprintable records for itself in general is not "sent" anywhere: activity feeds, events, agent statistics, audit entries are rows in **your** database, because they are the product.

---

## 2. "Work without asking": the switch that skips an agent's permission prompts

**What it is.** A per-agent setting, stored on the server (`agent_run_profiles.unattended`), shown in the agent's profile as **Work without asking**. When it is on, the
desktop app starts that agent's **next** session in the Claude Code CLI's `bypassPermissions` mode: tools run right away, and no permission card is sent to anyone's phone
or browser. What the agent may and may not do then follows **the Claude Code settings on that computer** — Sprintable adds no sandbox, no command filter, no deny list and no
allow list of its own. (It applies to Claude Code agents. Codex agents ask or go ahead as the Codex settings on their computer say.)

**Default.** Off, for every agent and every new organization.

**Who can turn it on.** Only an active **organization owner**. If anyone else submits a save that would change this value, the server refuses it with `403 owner_required` and writes
nothing from that request (not even the other fields of the same save); a save that leaves the value as it is — a model or effort change by a non-owner — is not an owner matter. The switch is
read-only in the interface for everyone else. The change is recorded with who made it and a version number; a session that is already
running keeps the mode it started in until it is restarted.

**What is asked while it is off (the default).** The agent asks before it uses a tool; a host it has not been allowed to reach is asked about on the owner's phone or browser, and adding a host needs a person's signed answer.

**What it is not.** It is not a Sprintable-wide "skip approvals" setting. Human approval **gates** (merge, release) are a separate mechanism; a gate can only auto-approve on a
timeout if its policy says so, never for high-risk or production-touching work, and that is off by default.

**If you run Sprintable for other people:** leave **Work without asking** off unless the agent runs on a machine where you are content for it to use every tool its CLI has,
without being asked. The decision is yours; the product will not make it for you.
