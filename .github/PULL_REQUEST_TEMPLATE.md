## Summary

- What changed and why:

## Verification

- [ ] `SKIP_DOTENV=true DOTENV_CONFIG_PATH=/dev/null npm run format`
- [ ] `SKIP_DOTENV=true DOTENV_CONFIG_PATH=/dev/null npm run ci`
- [ ] `SKIP_DOTENV=true DOTENV_CONFIG_PATH=/dev/null npm run test:coverage`
- [ ] If prompts, hooks, or runtime behavior changed: updated tests in `tests/` (and ran L3 `npm run test:e2e` when relevant)
- [ ] Updated `README.md` / `README.zh-CN.md` / `CHANGELOG.md` if user-facing behavior changed

## Checklist

- [ ] No DOM or `node:` imports added under `client/` or `shared/`
- [ ] No `.env*`, tokens, or private local paths introduced
- [ ] No hidden worktrees or automatic `git commit` introduced
