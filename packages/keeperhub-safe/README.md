# keeperhub-safe — bounty package

This directory must stay copy-pasteable into a fork of `KeeperHub/keeperhub` at
`plugins/safe/`, with no edits and no import from `@remit/core` (CLAUDE.md §3).

**Read docs/OPEN_QUESTIONS.md before writing anything here.** P0 found that the premise
in PRD.md §5.10 no longer holds: `plugins/safe/` already exists upstream, Zodiac Roles
execution is already implemented behind `app/api/user/safe/[safeId]/role/*`, and issue
#1241 was closed as completed on 2026-08-11. The upstream policy is also issue-first: a
maintainer must apply the `accepted` label before a pull request (`ISSUES.md`).

Conventions, once there is an accepted issue to build against:

```
plugins/safe/
  index.ts          # plugin definition, registerIntegration
  icon.tsx
  credentials.ts
  test.ts           # connection test
  steps/<action>.ts # one per action, "use step" directive
```

Step-file rules that the bundler enforces: export nothing but the step function,
`_integrationType` and types; share logic through a `*-core.ts` file with no `"use step"`;
no Node-only SDKs inside a step file — use `fetch`. Run `pnpm discover-plugins` after
adding one.
