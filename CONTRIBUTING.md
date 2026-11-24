# Contributing

Thanks for helping improve Paseo Team.

## Before you start

- For bugs, open an issue with your Paseo version, the provider and model involved, and steps to reproduce.
- For new features, open an issue first so we can agree on scope before you write code.
- Report security problems privately as described in [SECURITY.md](./SECURITY.md), not in a public issue.

## Development setup

```bash
git clone https://github.com/OliverWalker1122/paseo-team.git
cd paseo-team
npm ci
paseo plugin add "$(pwd)"
```

Run `paseo plugin reload paseo-team` after each change, and `paseo plugin logs paseo-team` to see server output.

## Pull requests

1. Create a branch from `main`.
2. Keep each pull request focused on one change.
3. Run `npm run format`, then `npm run ci`. Both must pass.
4. Add or update tests in `tests/` for any behavior change.
5. Update `README.md` and `CHANGELOG.md` when user-facing behavior changes.

## Code guidelines

- **Cross-platform client.** Code in `client/` and `shared/` uses React Native primitives and host UI components only: no DOM elements, no `window` or `document`, no `node:` imports.
- **Shared contracts.** Every RPC and subscription is a Zod contract in `shared/contracts.ts`, validated on both sides.
- **Both languages.** Every user-facing string lives in `shared/i18n.ts` with English and Chinese versions.
- **No secrets.** Never read `.env` files or print environment variables, including in tests. Tests run with `SKIP_DOTENV=true` and `DOTENV_CONFIG_PATH=/dev/null`.
- **Stay in scope.** The plugin coordinates agents. Workspaces, worktrees, commits and merges belong to Paseo and the user.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](./LICENSE).
