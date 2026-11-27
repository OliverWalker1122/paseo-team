# Contributing

Thanks for helping improve Paseo Team.

## Before you start

- For bugs, open an issue with your Paseo version, the provider and model involved, and steps to reproduce.
- For new features, open an issue first so we can agree on scope before you write code.
- Report security problems privately as described in [SECURITY.md](./SECURITY.md), not in a public issue.
- Please follow our [Code of Conduct](./CODE_OF_CONDUCT.md) in all interactions.

## Development setup

```bash
git clone https://github.com/OliverWalker1122/paseo-team.git
cd paseo-team
npm ci
paseo plugin add "$(pwd)"
```

Run `paseo plugin reload paseo-team` after each change, and `paseo plugin logs paseo-team` to see server output.

## Testing tiers

Tests are organized into three tiers:

1. **L1 Unit, prompt & UI contracts (`npm run test:unit`)**: pure offline tests covering config migration and per-role permission specs, prompt templates, live Paseo tree projection, composer pills/toggles, setup UI, and DAG rendering.
2. **L2 Server hook & live subscription integration (`npm run test:integration`)**: boots `contribute()` against an in-memory Paseo harness (`tests/hooks.integration.test.ts`) to verify both server hooks (`agent.open.before`, `agent.permission.before`), config/start RPCs, and the shared `agents.list({ subscribe: {} })` live update hub.
3. **L3 Live Paseo E2E (`npm run test:e2e`)**: real acceptance smoke test (`tests/e2e/live-paseo.test.mjs`) against a running Paseo daemon and real providers (`PASEO_E2E_LIVE=1 PASEO_E2E_CWD=/path/to/test-repo`). Opt-in only; skipped during normal `npm test` and CI.

## Pull requests

1. Create a branch from `main`.
2. Keep each pull request focused on one change.
3. Run `npm run format`, `npm run ci`, and `npm run test:coverage` (run `npm run coverage:badge` if coverage changes). All checks must pass.
4. Add or update tests in `tests/` for any behavior change.
5. Update `README.md`, `README.zh-CN.md`, and `CHANGELOG.md` when user-facing behavior changes.

## Code guidelines

- **Cross-platform client.** Code in `client/` and `shared/` uses React Native primitives and host UI components only: no DOM elements, no `window` or `document`, no `node:` imports.
- **Shared contracts.** Every RPC and subscription is a Zod contract in `shared/contracts.ts`, validated on both sides.
- **Both languages.** Every user-facing string lives in `shared/i18n.ts` with English and Chinese versions.
- **No secrets.** Never read `.env` files or print environment variables, including in tests. Tests run with `SKIP_DOTENV=true` and `DOTENV_CONFIG_PATH=/dev/null`.
- **Stay in scope.** The plugin coordinates agents. Workspaces, worktrees, commits and merges belong to Paseo and the user.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](./LICENSE).
