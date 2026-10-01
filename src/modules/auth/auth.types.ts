/**
 * The shapes auth parks in Redis while a flow is half finished, plus the only
 * shape of a user it ever hands back.
 *
 * None of these is a database row: a pending signup has no account yet, and a
 * login challenge is deliberately gone the moment it is spent.
 */

/**
 * An account that has been asked for but not yet confirmed.
 *
 * It is keyed by the email address itself (`reg:pending:<email>`), which is why
 * `startSignup` answers with the plain address and not a masked one — the caller
 * has to send back the same key to verify or to ask for another code.
 */
export type PendingSignup = {
	name: string;
	email: string;
	provider: "LOCAL" | "GOOGLE";
	passwordHash: string | null;
	googleId: string | null;
	avatarUrl: string | null;
	phone: string | null;
	otpHash: string;
	attempts: number;
};

/**
 * A login that has passed the password but not yet the second factor.
 *
 * The ip and ua hashes are what tie the second step to the browser that started
 * the first, so a stolen challenge id is not a login on its own.
 */
export type LoginChallenge = {
	userId: string;
	otpHash: string;
	attempts: number;
	resends: number;
	ipHash: string;
	uaHash: string;
	/** So whoever ends the challenge can take the emailed link down with it. */
	magicHash?: string;
};

/**
 * The user as the client is allowed to see it. Everything the token or the
 * session carries — the password hash, the 2FA flag, the department — stays on
 * this side of the wire unless an endpoint deliberately adds it.
 */
export type PublicUser = {
	id: string;
	name: string;
	email: string;
	role: string;
	avatarUrl: string | null;
};
