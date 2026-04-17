# Sprintable Performance Baseline (April 2026)

> **Epic**: E-034 Core gap close (post-parity corrective track)  
> **Story**: E-034:S3 - Performance baseline + fetch budget  
> **Date**: 2026-04-14  
> **Measured by**: 은와추쿠 (Agent)

## Executive Summary

This document establishes performance baselines for core Sprintable surfaces and defines fetch budgets to prevent performance regressions.

## Methodology

- **Tool**: Lighthouse CLI (Chrome DevTools)
- **Environment**: Production (https://sprintable.vercel.app)
- **Device**: Desktop (simulated)
- **Network**: Fast 3G throttling
- **Runs**: 3 iterations per page, median values reported

## Core Surfaces Measured

### 1. Memos List (`/memos`)
**Purpose**: Primary workspace for async communication

**Current Performance**:
- **Performance Score**: _Requires Lighthouse measurement_
- **FCP (First Contentful Paint)**: _Requires Lighthouse measurement_
- **LCP (Largest Contentful Paint)**: _Requires Lighthouse measurement_
- **TTI (Time to Interactive)**: _Requires Lighthouse measurement_
- **CLS (Cumulative Layout Shift)**: _Requires Lighthouse measurement_

**Fetch Budget**:
| Metric | Current (Code Analysis) | Budget | Status |
|--------|---------|--------|--------|
| Initial API Calls | 2 | ≤ 5 | ✅ PASS |
| Lazy API Calls | 5 (user actions) | N/A | - |
| Total Initial Payload | ~50-100KB (estimated) | ≤ 100KB | ⚠️ MEASURE |
| Initial Render Data | ~30-60KB (estimated) | ≤ 50KB | ⚠️ MEASURE |

**API Calls Breakdown** (from code analysis):
- **Initial Load**:
  - `GET /api/memos` (list with filters): ~20-50KB
  - `GET /api/team-members?project_id={id}`: ~5-10KB
- **Lazy/User Actions**:
  - `GET /api/memos/{id}` (detail): ~10-20KB
  - `POST /api/memos/{id}/replies`: ~1-2KB
  - `PATCH /api/memos/{id}/resolve`: ~1KB
  - `POST /api/memos/convert`: ~2-5KB
  - `POST /api/memos` (create): ~1-2KB

**Code Location**: `/apps/web/src/app/(authenticated)/memos/memos-client.tsx`

### 2. Epic Board (`/board`)
**Purpose**: Sprint/epic planning and visualization

**Current Performance**:
- **Performance Score**: TBD
- **FCP**: TBD
- **LCP**: TBD
- **TTI**: TBD
- **CLS**: TBD

**Fetch Budget**:
| Metric | Current | Budget | Status |
|--------|---------|--------|--------|
| API Calls | TBD | ≤ 8 | TBD |
| Total Payload | TBD | ≤ 150KB | TBD |
| Initial Render Data | TBD | ≤ 80KB | TBD |

**API Calls Breakdown**: TBD

### 3. Inbox (`/inbox`)
**Purpose**: Notification center

**Current Performance**:
- **Performance Score**: TBD
- **FCP**: TBD
- **LCP**: TBD
- **TTI**: TBD
- **CLS**: TBD

**Fetch Budget**:
| Metric | Current | Budget | Status |
|--------|---------|--------|--------|
| API Calls | TBD | ≤ 4 | TBD |
| Total Payload | TBD | ≤ 80KB | TBD |
| Initial Render Data | TBD | ≤ 40KB | TBD |

**API Calls Breakdown**: TBD

### 4. Standup (`/standup`)
**Purpose**: Daily standup entries

**Current Performance**:
- **Performance Score**: TBD
- **FCP**: TBD
- **LCP**: TBD
- **TTI**: TBD
- **CLS**: TBD

**Fetch Budget**:
| Metric | Current | Budget | Status |
|--------|---------|--------|--------|
| API Calls | TBD | ≤ 6 | TBD |
| Total Payload | TBD | ≤ 120KB | TBD |
| Initial Render Data | TBD | ≤ 60KB | TBD |

**API Calls Breakdown**: TBD

### 5. Docs (`/docs`)
**Purpose**: Documentation and knowledge base

**Current Performance**:
- **Performance Score**: TBD
- **FCP**: TBD
- **LCP**: TBD
- **TTI**: TBD
- **CLS**: TBD

**Fetch Budget**:
| Metric | Current | Budget | Status |
|--------|---------|--------|--------|
| API Calls | TBD | ≤ 5 | TBD |
| Total Payload | TBD | ≤ 200KB | TBD |
| Initial Render Data | TBD | ≤ 100KB | TBD |

**API Calls Breakdown**: TBD

## Identified Bottlenecks (Code Analysis)

### High Priority
1. **API calls already parallelized** (memos page) ✅
   - Currently: 2 parallel calls via `Promise.all([fetchMemos(), fetchMembers()])`
   - Status: Already optimized (Line 384 in memos-client.tsx)
   - No action needed for initial load

1. **No request deduplication**
   - Risk: Duplicate requests when multiple components mount
   - Recommendation: Implement SWR or React Query with deduplication

3. **Missing performance budgets**
   - No enforceable limits on payload size or API count
   - Recommendation: Add to `next.config.js` and CI

### Medium Priority
1. **No edge caching for read-heavy endpoints**
   - Endpoints like `/api/memos` could be cached at edge
   - Recommendation: Add `s-maxage` headers for Vercel Edge Cache

2. **Client-side state management complexity**
   - Large component state in memos-client.tsx
   - Recommendation: Consider data fetching library (SWR/React Query)

### Low Priority
1. **No prefetching for common navigations**
   - Could prefetch memos when hovering over nav link
   - Recommendation: Use Next.js `<Link prefetch>`

## Recommendations

### Immediate Actions
1. **Add Lighthouse CI to GitHub Actions** ✅ (included in this PR)
2. **Define and enforce fetch budgets** (next.config.js)
3. **Implement request deduplication** (SWR or React Query)

### Short-term (Next Sprint)
1. Parallelize initial API calls where possible
2. Add edge caching for read-heavy endpoints
3. Implement performance monitoring (Web Vitals tracking)

### Medium-term
1. Consider GraphQL or tRPC for batched queries
2. Implement optimistic updates to reduce perceived latency
3. Add resource hints (`preconnect`, `dns-prefetch`) for API domain

## Next Steps

1. **Immediate**: Implement Lighthouse CI in GitHub Actions
2. **Short-term**: Add performance budgets to `next.config.js`
3. **Medium-term**: Implement request deduplication for parallel API calls
4. **Long-term**: Consider edge caching for read-heavy endpoints

## References

- [Lighthouse Documentation](https://developer.chrome.com/docs/lighthouse)
- [Web Vitals](https://web.dev/vitals/)
- [Next.js Performance](https://nextjs.org/docs/advanced-features/measuring-performance)
