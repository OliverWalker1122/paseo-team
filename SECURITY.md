# Security Policy

## Supported versions

Only the latest release on `main` receives security fixes.

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report it privately through [GitHub Security Advisories](https://github.com/OliverWalker1122/paseo-team/security/advisories/new). Include:

- what an attacker could do and under which conditions
- steps or a proof of concept to reproduce it
- the Paseo version and provider involved

You can expect an acknowledgement within 7 days. Once a fix is ready, we will publish an advisory and credit you unless you prefer to stay anonymous.

## Scope

Of particular interest:

- credentials, `.env` contents or command arguments leaking into logs, task records or prompts
- task record paths escaping the plugin's state directory
