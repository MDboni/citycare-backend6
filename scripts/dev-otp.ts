/**
 * Prints the OTP that is currently pending in Redis. Development only.
 *
 *   pnpm run otp                      every pending signup and login challenge
 *   pnpm run otp citizen2             only the ones whose email contains that
 *
 * Redis never holds the six digits — `reg:pending:*` and `login:otp:*` store
 * `otpHash = HMAC-SHA256(otp, OTP_SECRET)`. There are only 900,000 possible
 * codes, so with the secret in hand the original is recovered by trying them
 * all, which takes about a second. Without the secret a leaked Redis dump is
 * worth nothing, which is the whole point of keying the hash.
 *
 * Use this when SMTP is configured: the server then emails the OTP instead of
 * logging it, and the seeded citizen2…citizen5 addresses are not real mailboxes.
 */
import { isProd } from "@/config/env.js";
import { connectRedis, redis } from "@/config/redis.js";
import { prisma } from "@/lib/prisma.js";
import { otpHash } from "@/utils/crypto.js";

if (isProd) {
	console.error("dev-otp refuses to run with NODE_ENV=production.");
	process.exit(1);
}

const needle = (process.argv[2] ?? "").toLowerCase();

/** Walks the whole six-digit space until the keyed hash matches. */
const recover = (hash: string): string | null => {
	for (let n = 100_000; n < 1_000_000; n += 1) {
		const candidate = String(n);
		if (otpHash(candidate) === hash) return candidate;
	}
	return null;
};

const ok = await connectRedis();
if (!ok) {
	console.error("Could not reach Redis. Is REDIS_URL set and the service up?");
	process.exit(1);
}

type Pending = { email?: string; otpHash?: string; attempts?: number };
type Challenge = { userId?: string; otpHash?: string; attempts?: number };

let found = 0;

// --- signups waiting for their OTP ------------------------------------------
for (const key of await redis.keys("reg:pending:*")) {
	const email = key.slice("reg:pending:".length);
	if (needle && !email.toLowerCase().includes(needle)) continue;

	const raw = await redis.get(key);
	if (!raw) continue;

	const pending = JSON.parse(raw) as Pending;
	const ttl = await redis.ttl(key);
	const code = pending.otpHash ? recover(pending.otpHash) : null;

	found += 1;
	console.log(`\nSIGNUP   ${email}`);
	console.log(`  OTP      ${code ?? "(not recoverable — is OTP_SECRET the one that wrote it?)"}`);
	console.log(`  expires  in ${ttl}s        attempts used: ${pending.attempts ?? 0}/5`);
}

// --- logins waiting on their second factor ----------------------------------
for (const key of await redis.keys("login:otp:*")) {
	const raw = await redis.get(key);
	if (!raw) continue;

	const challenge = JSON.parse(raw) as Challenge;
	const user = challenge.userId
		? await prisma.user.findFirst({
				where: { id: challenge.userId },
				select: { email: true, role: true },
			})
		: null;

	const email = user?.email ?? challenge.userId ?? "unknown";
	if (needle && !email.toLowerCase().includes(needle)) continue;

	const ttl = await redis.ttl(key);
	const code = challenge.otpHash ? recover(challenge.otpHash) : null;

	found += 1;
	console.log(`\nLOGIN    ${email}${user ? ` (${user.role})` : ""}`);
	console.log(`  OTP          ${code ?? "(not recoverable)"}`);
	console.log(`  challengeId  ${key.slice("login:otp:".length)}`);
	console.log(`  expires      in ${ttl}s        attempts used: ${challenge.attempts ?? 0}/5`);
}

if (found === 0) {
	console.log(
		needle
			? `\nNothing pending for "${needle}". Send the register or login request first.`
			: "\nNothing pending. Send POST /auth/register or a login that needs a second factor, then run this again.",
	);
}

console.log();
await redis.quit();
await prisma.$disconnect();
