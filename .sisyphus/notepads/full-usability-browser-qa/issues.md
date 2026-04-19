## Browser QA Issues

### 1. Dashboard Content Stuck Loading (Supabase Client Error)
- **Location**: `/dashboard`
- **Symptom**: The main content area shows skeleton loaders indefinitely.
- **Console Error**: `[error] [Realtime] Failed to create Supabase client: Error: @supabase/ssr: Your project's URL and API key are required to create a Supabase client!`
- **Context**: The app is running in OSS mode (SQLite), but the frontend appears to be attempting to initialize Supabase Realtime, which fails because the Supabase environment variables are not set. This blocks the main content from rendering.

### 2. Global Supabase Client Error (Infinite Re-renders)
- **Location**: Global (observed on `/dashboard`, `/board`, `/docs`, `/settings`)
- **Symptom**: The console is flooded with `[error] [Realtime] Failed to create Supabase client: Error: @supabase/ssr: Your project's URL and API key are required to create a Supabase client!`. On `/dashboard`, this causes an infinite loop of network requests and re-renders, destroying the browser execution context and making the page unresponsive to automated clicks.
- **Context**: The Supabase client is likely initialized in a global layout or provider, causing errors across the entire app when running in OSS mode without Supabase env vars.

### 3. Broken "Connect GitHub webhook" Link
- **Location**: `/board`
- **Symptom**: Clicking the "Connect GitHub webhook →" link (`@e20`) opens a new tab to `/docs/quickstart-webhook`, which returns a 404 Not Found page.
- **Context**: The link points to a non-existent documentation page.

### 4. Webhook Settings Save Fails (503 Service Unavailable)
- **Location**: `/settings#webhooks`
- **Symptom**: Filling out the Discord webhook URL and clicking "저장" (Save) does not show any success or error feedback in the UI.
- **Console/Network Error**: The `PUT /api/webhooks/config` request returns a `503 Service Unavailable` status.
- **Context**: The backend endpoint for saving webhook configurations is either not implemented, failing due to the missing Supabase configuration, or otherwise unavailable in the OSS local environment.

### 5. Authentication Bypass in OSS Mode
- **Location**: `/login`
- **Symptom**: Navigating to `/login` immediately redirects to `/dashboard`.
- **Context**: In OSS mode, the application appears to bypass authentication entirely or automatically logs in as a default user ("OSS User"). While convenient for local development, this means actual authentication flows cannot be tested in this environment.

### 6. Webhook Configuration Save Fails
- **Location**: `/settings` (Webhook Settings)
- **Symptom**: Clicking "Save" after entering a webhook URL results in a `503 Service Unavailable` error.
- **Context**: The `PUT /api/webhooks/config` endpoint is either not implemented for OSS mode or failing due to missing dependencies (like Supabase).

### 7. Project Creation Fails Silently
- **Location**: `/settings` (Projects)
- **Symptom**: Filling out the "Project name" and "Project description" fields and clicking "Create project" does nothing. No network request is sent, and the UI does not update.
- **Context**: The form submission is likely broken or blocked by client-side errors (e.g., the global Supabase client error).

### 8. Team Invitation Not Implemented
- **Location**: `/settings` (Team Invitations)
- **Symptom**: Entering an email address and clicking "Invite" results in a `501 Not Implemented` error.
- **Context**: The `POST /api/invitations` endpoint is explicitly returning 501, indicating this feature is not available in the current OSS build.

### 9. Account Deletion Not Implemented
- **Location**: `/settings` (Danger Zone)
- **Symptom**: Clicking "Delete Account", then "Confirm Delete" in the alert dialog results in a `501 Not Implemented` error.
- **Context**: The `POST /api/account/delete` endpoint is explicitly returning 501.

### 10. Workflow Editor Content Missing
- **Location**: `/agents/workflow`
- **Symptom**: The page renders the navigation shell, but the main content area is completely empty.
- **Context**: Similar to the dashboard, this page is likely broken by the global Supabase client initialization error.
