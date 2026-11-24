# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Quality gate no longer fingerprints the workspace. It checks that the latest CI run passed after the previous rework round and that the latest review round approved, so user edits and commits no longer block it.
- The two-round review limit is soft: verdicts are always recorded, and the task is flagged for a user decision instead of rejecting the record. Authorizing an extra round now actually allows it.
- Code review is no longer forced by diff size or architecture-impact wording; the coordinator decides, and delivery reports diff size as advice.
- Rerunning a check with an existing log name picks a new name instead of failing.

### Removed

- Workspace content fingerprints, review anti-spoofing sidecar checks, `substantialChange` and `rawOutput` review inputs.

## [6.0.0] - 2026-11-25

First public release as a native Paseo plugin.

### Added

- Team tasks started from any chat with `/paseo-team`, with this chat as the coordinator.
- Separate Developer, Code Reviewer and optional Expert and Plan Reviewer sessions, each with only the permissions its role needs.
- Cross review by two reviewers from opposing angles, limited to two rounds before the team asks you to decide.
- Quality gate with five checks, bound to a fingerprint of the current workspace contents.
- Credential-isolated CI runner that records results without command arguments.
- Setup screen to choose provider, model and reasoning effort per role, with saved presets.
- Live team graph for each chat, and a history view with every review round and its findings.
- English and Chinese UI that follows the Paseo app language.

[6.0.0]: https://github.com/OliverWalker1122/paseo-team/releases/tag/v6.0.0
