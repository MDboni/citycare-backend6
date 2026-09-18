# Security policy

## Reporting a vulnerability

Email **security@citycare.com** with:

- what the issue is and where (endpoint, file, or both),
- how to reproduce it, ideally the smallest request that shows it,
- what an attacker gets out of it.

Please do **not** open a public issue, and please do not test against production data.

You should get an acknowledgement within 3 working days and an assessment within 10. We will
tell you when a fix ships and credit you unless you would rather stay anonymous.

## Supported versions

| Version | Supported |
| --- | --- |
| 1.0.x | yes |
| < 1.0 | no |

## In scope

- Authentication and session handling — token forgery, replay, fixation, privilege escalation
- Authorisation — reaching another user's complaint, payment, document or notification
- Injection — SQL, NoSQL, command, template
- Stored or reflected XSS through any field the API stores
- Payment tampering — forged callbacks, amount manipulation, double refunds
- Leaking personal data (email, phone, address, uploaded documents)
- Rate-limit and lockout bypasses

## Out of scope

- Denial of service from sheer volume
- Findings that only apply to a self-hosted instance with deliberately weak configuration
- Missing headers with no demonstrated impact
- Automated scanner output with no working proof of concept
- Social engineering, physical access, and third-party services we do not control

## What this project already does

| Area | Control |
| --- | --- |
| Passwords | bcrypt, 12 rounds, minimum 10 characters with mixed classes |
| Two-factor | On for every account created through the API; the code and the emailed link end the same single-use challenge; only a CITIZEN may opt out, with their password plus a fresh OTP |
| Tokens | HS256 only, issuer and audience pinned, `jti` denylist on logout, refresh rotation with reuse detection |
| Privilege | `isSuperAdmin` is never in a token and cannot be set through any API; a database CHECK keeps it on ADMIN rows |
| Input | Zod `.strict()` on every body; `sanitize-html` on every free-text field |
| Uploads | MIME whitelist plus magic-byte inspection, 5 MB, random public ids, sensitive files behind 10-minute signed URLs |
| Data access | Prisma only; `$queryRawUnsafe` is never used |
| Audit | Append-only `AuditLog` enforced by a database trigger |
| Logs | pino redaction for authorization headers, passwords, OTPs and tokens |
| Retention | Security events 90 days, email log 30 days, deleted accounts anonymised after 30 days |

## Handling secrets

`.env` is git-ignored and `.env.example` carries placeholders only. Generate each secret
separately with `openssl rand -hex 64` — never reuse one across `JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET` and `OTP_SECRET`. CI runs gitleaks on every push. If a secret is ever
committed, follow [`docs/runbook.md`](docs/runbook.md#secret-leaked).
