import passport from "passport";
import { Strategy as GoogleStrategy, type Profile } from "passport-google-oauth20";
import { env } from "@/config/env.js";
import { logger } from "@/lib/logger.js";

export const googleConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

export type GoogleProfile = {
	googleId: string;
	email: string;
	emailVerified: boolean;
	name: string;
	avatarUrl?: string;
};

const toGoogleProfile = (profile: Profile): GoogleProfile => {
	const primary = profile.emails?.[0];
	return {
		googleId: profile.id,
		email: (primary?.value ?? "").trim().toLowerCase(),
		// passport types the flag loosely; Google sends a real boolean.
		emailVerified: (primary as { verified?: boolean } | undefined)?.verified !== false,
		name: profile.displayName || profile.name?.givenName || "CityCare user",
		avatarUrl: profile.photos?.[0]?.value,
	};
};

if (googleConfigured) {
	passport.use(
		new GoogleStrategy(
			{
				clientID: env.GOOGLE_CLIENT_ID,
				clientSecret: env.GOOGLE_CLIENT_SECRET,
				callbackURL: env.GOOGLE_CALLBACK_URL,
				scope: ["profile", "email"],
				// No server session; the `state` parameter protects the callback from CSRF.
				state: true,
			},
			(_accessToken, _refreshToken, profile, done) => {
				done(null, toGoogleProfile(profile) as unknown as Express.User);
			},
		),
	);
	logger.info("Google OAuth strategy registered");
} else {
	logger.warn("GOOGLE_CLIENT_ID/SECRET missing — Google login is disabled");
}

export default passport;
