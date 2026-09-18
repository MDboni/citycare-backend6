import type { Request } from "express";
import type OAuth2Strategy from "passport-oauth2";
import { redis } from "@/config/redis.js";
import { ApiError } from "@/utils/ApiError.js";
import { randomToken } from "@/utils/crypto.js";

/**
 * The OAuth `state` parameter is what stops an attacker starting a Google
 * sign-in and having someone else's browser finish it. Passport's built-in
 * store keeps it in `req.session` — which this API does not have and should not
 * grow. It is stateless by design, and on a serverless host the callback can
 * land on a different instance than the one that issued the redirect, so an
 * in-process session would not survive the round trip anyway.
 *
 * Redis already holds every other short-lived single-use token here: the signup
 * OTP, the magic sign-in link, the password reset. The state belongs with them.
 * Written before the redirect, deleted on the way back, and expiring on its own
 * if the user abandons the flow at Google.
 */

const key = (state: string) => `oauth:state:${state}`;

/** Long enough to pick an account and type a password, short enough to matter. */
const TTL_SECONDS = 600;

const unavailable = (err: unknown) =>
	new ApiError(503, "Google login is temporarily unavailable", [
		{ code: "SERVICE_UNAVAILABLE", message: (err as Error).message },
	]);

type StoreCallback = OAuth2Strategy.StateStoreStoreCallback;
type VerifyCallback = OAuth2Strategy.StateStoreVerifyCallback;
type Metadata = OAuth2Strategy.Metadata;

/**
 * Passport picks which form to call from `Function.length`, so the implementation
 * signatures below decide it: `store` is called with the metadata, `verify` too.
 * Neither is used — the state is opaque — but the arity has to match.
 */
class RedisStateStore implements OAuth2Strategy.StateStore {
	store(req: Request, callback: StoreCallback): void;
	store(req: Request, meta: Metadata, callback: StoreCallback): void;
	store(_req: Request, metaOrCallback: Metadata | StoreCallback, callback?: StoreCallback): void {
		const done =
			typeof metaOrCallback === "function" ? metaOrCallback : (callback as StoreCallback);
		const state = randomToken(24);
		redis
			.set(key(state), "1", "EX", TTL_SECONDS)
			.then(() => done(null, state))
			.catch((err: unknown) => done(unavailable(err), null));
	}

	verify(req: Request, state: string, callback: VerifyCallback): void;
	verify(req: Request, state: string, meta: Metadata, callback: VerifyCallback): void;
	verify(
		_req: Request,
		state: string,
		metaOrCallback: Metadata | VerifyCallback,
		callback?: VerifyCallback,
	): void {
		const done =
			typeof metaOrCallback === "function" ? metaOrCallback : (callback as VerifyCallback);

		if (!state) {
			done(null, false, { message: "Unable to verify authorization request state." });
			return;
		}

		// DEL reports how many keys it removed, so it is the check and the
		// consumption in one step: a replayed state finds nothing and fails.
		redis
			.del(key(state))
			.then((removed) => {
				if (removed === 1) {
					done(null, true, null);
					return;
				}
				done(null, false, { message: "Invalid authorization request state." });
			})
			.catch((err: unknown) => done(unavailable(err), false, null));
	}
}

export const oauthStateStore: OAuth2Strategy.StateStore = new RedisStateStore();
