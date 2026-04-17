# Fetch Budgets for Sprintable Surfaces

> **Epic**: E-034 Core gap close  
> **Story**: E-034:S3 - Performance baseline + fetch budget  
> **Last Updated**: 2026-04-14

## Purpose

This document defines fetch budgets (API call limits and payload size constraints) for core Sprintable surfaces to prevent performance regressions.

## Budget Enforcement

Budgets are enforced through:
1. **Code Review**: Manual check during PR review
2. **Lighthouse CI**: Automated payload size checks (see `lighthouserc.json`)
3. **Runtime Monitoring**: Web Vitals tracking (future)

## Core Surfaces

### 1. Memos List (`/memos`)

**Budget**:
- Max Initial API Calls: **5**
- Max Total Initial Payload: **100 KB**
- Max Initial Render Data: **50 KB**

**Rationale**: Primary workspace; must load quickly for daily use.

**Current Status** (as of 2026-04-14):
- Initial API Calls: 2 ✅
- Estimated Payload: ~50-70 KB ✅

### 2. Epic Board (`/board`)

**Budget**:
- Max Initial API Calls: **8**
- Max Total Initial Payload: **150 KB**
- Max Initial Render Data: **80 KB**

**Rationale**: Complex visualization; slightly higher budget acceptable.

**Current Status**: _Pending measurement_

### 3. Inbox (`/inbox`)

**Budget**:
- Max Initial API Calls: **4**
- Max Total Initial Payload: **80 KB**
- Max Initial Render Data: **40 KB**

**Rationale**: Notification center; should be extremely fast.

**Current Status**: _Pending measurement_

### 4. Standup (`/standup`)

**Budget**:
- Max Initial API Calls: **6**
- Max Total Initial Payload: **120 KB**
- Max Initial Render Data: **60 KB**

**Rationale**: Daily use; moderate complexity.

**Current Status**: _Pending measurement_

### 5. Documentation (`/docs`)

**Budget**:
- Max Initial API Calls: **5**
- Max Total Initial Payload: **200 KB**
- Max Initial Render Data: **100 KB**

**Rationale**: Content-heavy; higher payload acceptable for rich content.

**Current Status**: _Pending measurement_

## Guidelines

### When Budget is Exceeded

1. **Investigation Required**:
   - Identify which API call or payload caused the increase
   - Determine if increase is justified (new feature, necessary data)

2. **Remediation Options**:
   - Implement pagination or lazy loading
   - Remove unnecessary fields from API response
   - Batch multiple API calls into one
   - Implement edge caching for static data

3. **Budget Adjustment**:
   - If increase is unavoidable, update budget with PO approval
   - Document reason in this file

### Best Practices

1. **Parallelize Independent Calls**: Use `Promise.all()` for non-dependent API calls
2. **Implement Request Deduplication**: Use SWR or React Query
3. **Edge Caching**: Add `s-maxage` headers for read-heavy endpoints
4. **Incremental Data Loading**: Load critical data first, defer non-critical
5. **Prefetching**: Prefetch data for likely next navigation

## Measurement

Actual performance metrics are collected via:
- **Lighthouse CI**: Runs on every PR (see `.github/workflows/lighthouse-ci.yml`)
- **Web Vitals**: Runtime performance tracking (future)

See `docs/performance-baseline-2026-04.md` for detailed baseline measurements.

## References

- [Web Performance Budget Calculator](https://www.performancebudget.io/)
- [Lighthouse Performance Budgets](https://web.dev/performance-budgets-with-lighthouse/)
- [Next.js Performance](https://nextjs.org/docs/advanced-features/measuring-performance)
