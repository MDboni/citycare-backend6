# Authentication

Access token: 15 minutes, Bearer, HS256. Refresh token: 7 days, SHA-256 hashed in the database,
rotated on every use, bound to a session. Nothing about a user reaches PostgreSQL before their
email address has been proven.

## Signup — Redis first

```
POST /auth/register
  ├─ Zod .strict()  (an unknown key such as "role" is a 400)
  ├─ authLimiter    5 failed attempts / 15 min per IP (RATE_LIMIT_AUTH_MAX)
  ├─ email normalised (trim + lowercase)
  ├─ an active user with that email?          → 409 EMAIL_EXISTS
  ├─ otp:cooldown:{email} exists?             → 429 OTP_COOLDOWN
  ├─ INCR otp:sends:{email} (1 h TTL); > 5    → 429 RATE_LIMITED
  ├─ SET reg:pending:{email} EX 600
  │     { name, email, passwordHash (bcrypt), otpHash (HMAC), attempts: 0, … }
  ├─ SET otp:cooldown:{email} EX 60
  └─ email the OTP                            → 202 { email: masked, expiresInSec }

POST /auth/verify-otp
  ├─ GET reg:pending:{email}; missing         → 400 OTP_EXPIRED
  ├─ attempts >= 5                            → DEL + 429 RATE_LIMITED
  ├─ timing-safe compare; wrong               → attempts++ (KEEPTTL), 400 "N attempts left"
  └─ right → one transaction:
        User.create(role CITIZEN, emailVerifiedAt = now)
        AuditLog USER_REGISTERED
     then DEL the keys                        → 201 tokens

POST /auth/resend-otp
  └─ a pending record gets a fresh OTP; an unknown email gets the *same* 202
```

Redis never holds a plain password or a plain OTP: the password is bcrypt-hashed and the OTP is
HMAC-SHA256'd with `OTP_SECRET` before either is stored.

**Password policy.** At least 10 characters with an upper-case letter, a lower-case letter, a
digit and a symbol, and it must not contain the user's name or the local part of their email.

## Login — password, then a second factor

```
POST /auth/login
  ├─ login:ip:{ip} >= 30 fails / 15 min       → 429
  ├─ login:fail:{email} >= 5                  → 423 ACCOUNT_LOCKED (15 min)
  │                              >= 10        → 423 ACCOUNT_LOCKED (1 h)
  ├─ findFirst({ email, deletedAt: null })
  ├─ bcrypt.compare(password, user?.password ?? DUMMY_HASH)   ← always runs
  │     fail → INCR counters, SecurityEvent, 401 "Invalid credentials"
  ├─ BLOCKED                                  → 403 ACCOUNT_BLOCKED
  ├─ DEL login:fail:{email}
  ├─ mustOtp = twoFactorEnabled          (on by default for every new account)
  ├─ trusted = CITIZEN && a valid device token
  ├─ !mustOtp || trusted → 200 { twoFactorRequired: false, accessToken, refreshToken, user }
  └─ otherwise
        challengeId = 32 random bytes
        magicToken  = 32 random bytes            ← only ever exists in the email
        SET login:otp:{challengeId} EX 300
            { userId, otpHash, attempts, resends, ipHash, uaHash, magicHash }
        SET login:magic:{sha256(magicToken)} = challengeId EX 300
        email the OTP *and* a sign-in link, SecurityEvent OTP_SENT
        → 202 { twoFactorRequired: true, challengeId, email: masked, expiresInSec }

POST /auth/login/verify-otp
  ├─ missing challenge                        → 400 OTP_EXPIRED
  ├─ uaHash mismatch                          → DEL + 401 (challenge belongs to one browser)
  ├─ wrong OTP  → attempts++, 5 → end challenge, SecurityEvent OTP_FAILED, 400 OTP_INVALID
  ├─ DEL returns 0 (someone else used it)     → 400 "OTP already used"
  └─ createSessionAndTokens
        CITIZEN + trustDevice → TrustedDevice (30 d) + deviceToken in the response
        unknown user agent    → SecurityEvent NEW_DEVICE + alert email

GET /auth/login/magic?token=…                  ← the same challenge, one click
  ├─ authLimiter, token must be 64 hex
  ├─ GET login:magic:{sha256(token)} → challengeId; missing → 400
  ├─ GET login:otp:{challengeId};      missing → 400 (the code already used it)
  ├─ DEL the magic key; returns 0 → 400        (single use, race safe)
  ├─ end the challenge, so the emailed code dies with it
  └─ createSessionAndTokens — never a trusted device
```

**The two halves of one challenge.** The code and the link are two ways through the *same*
`challengeId`, never two credentials: whichever is used first ends the challenge and takes the other
down with it, and a resend replaces both. `magicHash` on the challenge record is what makes that
possible in either direction.

The link is the one path that does **not** check the user agent. `verify-otp` refuses a challenge
presented by a different browser, but a link is opened in a mail client, never in the app that
started the login — binding it would mean the feature never works. That is the trade, and it is why
this path is short-lived, single use, rate limited, alerted on a new device, and never mints a
trusted device: a click cannot tell us the person meant to trust the machine they clicked on.

The dummy bcrypt compare matters: without it, an unknown email would answer measurably faster
than a wrong password and the endpoint would become an account-existence oracle.

**Only a citizen may switch the second factor off**, and only through `PATCH /auth/2fa` after
confirming their password *and* a fresh OTP. That endpoint rejects any other role outright, and
`isSuperAdmin`/`role` are not accepted from a client anywhere, so a privileged account cannot
downgrade itself to a single factor. The one exception is the seed script, which creates the
demo accounts with `twoFactorEnabled = false` so an evaluator can sign in without a mailbox.

## Sessions, rotation and logout

`createSessionAndTokens` writes a `Session` (ip, user agent, device name, expiry — 8 hours for a
super admin, 7 days otherwise), stores the SHA-256 of the refresh token, updates
`lastLoginAt`/`lastLoginIp` and records `LOGIN_SUCCESS`.

```
POST /auth/refresh-token
  ├─ hash the incoming token and look it up; missing → 401
  ├─ already revoked → THEFT:
  │     revoke every session of that user, SecurityEvent TOKEN_REUSE, 401
  ├─ expired, or the session is revoked/expired      → 401
  └─ valid → in one transaction: create the successor, mark the old one revoked with
             replacedById, touch Session.lastUsedAt

POST /auth/logout
  ├─ revoke the session and its refresh tokens (revokedReason LOGOUT)
  ├─ SET jwt:deny:{jti} for the access token's remaining lifetime
  └─ DEL sess:{sid}
```

Rotation plus reuse detection is what limits the damage from a stolen refresh token: the thief
gets one use, and the moment either party presents the old token every session dies.

## Five checks on every request

`src/middlewares/auth.ts` verifies, in order:

1. Signature, `HS256` only, issuer `citycare`, audience `citycare-api`.
2. `jwt:deny:{jti}` — the token was not logged out.
3. `sess:{sid}` — the session exists, is not revoked and has not expired (cached 60 s).
4. The user still exists, is not soft-deleted and is not `BLOCKED`.
5. `iat` is not older than `passwordChangedAt`, and the role in the token still matches the
   database.

Checks 4 and 5 are why a password change, a role change or a block takes effect within one
request instead of within fifteen minutes.

## Google OAuth

```
GET  /auth/google            → passport redirect (scope profile+email, session:false, state:true)
GET  /auth/google/callback   → email_verified === false → 403
     ├─ existing user (by googleId, or by a live email → link googleId)
     │     → the normal 2FA challenge, or tokens if none is needed
     │     → redirect to {CLIENT_URL}/auth/callback?status=…
     └─ new user → startSignup({ provider: GOOGLE, … }) → the same Redis + OTP flow,
                   so every account is created by exactly one code path
POST /auth/google/token { idToken }   ← Postman-friendly; audience-checked with google-auth-library
```

## Password reset

`forgot-password` stores `pwd:reset:{sha256(token)} = userId` for 15 minutes and emails a link.
An unknown address gets the identical `200`. `reset-password` re-checks the policy, sets
`passwordChangedAt`, revokes every session and records `PASSWORD_CHANGED`.

## Redis keys

| Key | Holds | TTL |
| --- | --- | --- |
| `reg:pending:{email}` | pending signup (password and OTP both hashed) | 10 min |
| `otp:cooldown:{email}` | resend cooldown | 60 s |
| `otp:sends:{email}` | sends this hour | 1 h |
| `login:fail:{email}` | consecutive failures | 15 min → 1 h |
| `login:ip:{ip}` | failures from this IP | 15 min |
| `login:otp:{challengeId}` | 2FA challenge | 5 min |
| `login:magic:{tokenHash}` | the emailed link, pointing at a challengeId | 5 min |
| `pwd:reset:{tokenHash}` | user id | 15 min |
| `jwt:deny:{jti}` | logout denylist | remaining token life |
| `sess:{sid}` | session validity cache | 60 s |
| `categories:all`, `wards:all`, … | master data cache | 1 h |
| `admin:stats` | dashboard cache | 60 s |
