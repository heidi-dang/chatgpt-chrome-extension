# Phase 6 — Dependency and legacy cleanup baseline (2026-10-08)

**Status: started, not complete.** Scope is the independently versioned CPTR Chrome extension; no changes to production Cloudflare OAuth, the plugin/backend release, browser wire schema or permission boundaries.

- Fresh base: `heidi-dang/chatgpt-chrome-extension` `main` at `863024f93b3e6536dfb2d084b70729cdd61ef99b`, extension version `0.1.8`.
- Baseline `npm audit --omit=dev --json`: **zero vulnerabilities**, so broad emergency upgrades are not justified.
- Scoped runtime update: **Zod 4.5.4 → 4.6.5** with reproducible `package.json` / `package-lock.json` changes. No new dependencies.
- Broad `npm update` initially hit the installed npm CLI's internal `Cannot read properties of null (reading 'edgesOut')` error; it made no tracked changes. A targeted `npm install --package-lock-only zod@4.6.5` succeeded; then `npm ci` reproduced the lockfile install.
- After update: `npm run check` **passed** (TypeScript, ESLint, **78/78 Vitest tests**, production extension build). Production-only `npm audit` remains **zero vulnerabilities**.
- Major upgrades such as TypeScript 7 and Vitest 5, and legacy endpoint/tool retirement, require separate compatibility/profiling evidence rather than speculative churn. Physical browser/official iOS app acceptance, fresh VM install and cross-repo release verification are **pending**.
- User explicitly accepted Phase 4 as closed because existing Cloudflare Managed OAuth works: do not touch Cloudflare, OAuth or Caddy auth configuration for Phase 6.
