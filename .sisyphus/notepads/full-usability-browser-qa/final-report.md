# Browser QA Final Report - Sprintable (OSS Mode)

## Summary
The browser QA session for Sprintable (OSS mode) revealed several critical blockers and functional gaps. The most significant issue is a global Supabase client initialization error that causes infinite re-renders and blocks main content on key pages like the Dashboard and Workflow Editor. Several core features in the Settings page (Webhook save, Project creation, Invitations, Account deletion) are either broken or explicitly not implemented (501/503 errors).

## Environment Note
Testing was conducted in **OSS Mode** using Docker Compose (`docker-compose.oss.yml`). In this mode, the application uses SQLite and bypasses standard authentication (automatically logging in as "OSS User"). Real authentication flows and Supabase-dependent features could not be meaningfully tested in this environment.

## Major Issues

### 1. Global Supabase Client Error (Critical)
- **Severity**: Critical
- **Reproduction Steps**:
  1. Start the app in OSS mode (`docker compose -f docker-compose.oss.yml up`).
  2. Navigate to any page (e.g., `/dashboard`, `/board`).
  3. Open the browser console.
- **Observed Evidence**: Console flooded with `[error] [Realtime] Failed to create Supabase client: Error: @supabase/ssr: Your project's URL and API key are required`. Dashboard content remains in an infinite skeleton loading state.
- **Recommended Next Action**: Isolate Supabase client initialization. Ensure it only runs when Supabase environment variables are present, or provide a mock client for OSS mode to prevent frontend crashes.

### 2. Settings Page Functional Failures (High)
- **Severity**: High
- **Reproduction Steps**:
  1. Navigate to `/settings`.
  2. Attempt to save a webhook, create a project, or invite a member.
- **Observed Evidence**:
  - **Webhook Save**: Returns `503 Service Unavailable` from `PUT /api/webhooks/config`.
  - **Project Creation**: Silent failure; no network request is sent upon clicking "Create project".
  - **Invitations/Account Delete**: Returns `501 Not Implemented`.
- **Recommended Next Action**: Implement missing endpoints for OSS mode or provide clear "Not available in OSS" UI feedback. Fix the client-side form submission for project creation.

### 3. Broken Documentation Link (Medium)
- **Severity**: Medium
- **Reproduction Steps**:
  1. Navigate to `/board`.
  2. Click the "Connect GitHub webhook →" link.
- **Observed Evidence**: Redirects to `/docs/quickstart-webhook` which returns a 404 Not Found page.
- **Recommended Next Action**: Update the link to point to the correct documentation path or create the missing documentation page.

### 4. Workflow Editor Content Missing (High)
- **Severity**: High
- **Reproduction Steps**:
  1. Navigate to `/agents/workflow`.
- **Observed Evidence**: The page renders the navigation shell, but the main content area is completely empty.
- **Recommended Next Action**: Investigate if this is a side effect of the global Supabase error or a separate missing component/route issue.

## Recommended Next Actions (Ordered by Impact)
1. **Fix Global Supabase Error**: This is the primary blocker for usability and prevents further automated testing.
2. **Fix Project Creation**: This is core functionality that should be available in the OSS version.
3. **Fix Documentation Links**: Low effort fix to improve the initial user experience.
4. **Implement/Stub Settings Endpoints**: Ensure the UI accurately reflects the capabilities of the OSS mode to avoid user confusion.
