# Full Usability Browser QA - Learnings

## Session: ses_25b60f1ccffeEnOGUSXr0JFUaM
## Date: 2026-04-19

## Key Findings

### Environment
- Docker container `sprintable-gstack-web-1` running on port 3000
- Container shows as "unhealthy" but app responds
- Supabase realtime connection not configured locally

### Testing Method
- Used gstack browse (headless Chromium)
- Screenshots captured to /tmp/
- Console errors extracted via `$B console --errors`

### Common Issues Found
1. Supabase URL/API key missing in .env
2. Docker unhealthy status
3. 400/404 resource errors
4. Standup page fails to load data

### What Works
- Navigation menu
- Language toggle (EN/KR)
- Board Kanban view
- Settings page
- Empty states render correctly

## Patterns Observed
- Console errors are very verbose (many realtime retry attempts)
- Language toggle works well
- UI is consistent across pages

## Recommendations
1. Add Supabase setup documentation to README
2. Fix Docker healthcheck
3. Investigate 400/404 errors
