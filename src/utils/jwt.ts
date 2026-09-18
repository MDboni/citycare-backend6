import crypto from "node:crypto";
import jwt, { type SignOptions } from "jsonwebtoken";
import { env } from "@/config/env.js";
import type { Role } from "@/generated/prisma/enums.js";

export const JWT_ISSUER = "citycare";
export const JWT_AUDIENCE = "citycare-api";
const ALGORITHM = "HS256" as const;

export type AccessPayload = {
	sub: string;
	role: Role;
	/** Session id — lets logout kill the token family, not just one token. */
	sid: string;
	/** Token id — the denylist key after logout. */
	jti: string;
	iat: number;
	exp: number;
};

export type RefreshPayload = {
	sub: string;
	sid: string;
	jti: string;
	iat: number;
	exp: number;
};

/**
 * `isSuperAdmin` is deliberately NOT in the token: a privilege that can be
 * revoked must be read from the database on every request.
 */
export const signAccessToken = (payload: { sub: string; role: Role; sid: string }) => {
	const jti = crypto.randomUUID();
	const token = jwt.sign({ role: payload.role, sid: payload.sid }, env.JWT_ACCESS_SECRET, {
		algorithm: ALGORITHM,
		subject: payload.sub,
		jwtid: jti,
		issuer: JWT_ISSUER,
		audience: JWT_AUDIENCE,
		expiresIn: env.JWT_ACCESS_EXPIRES_IN as SignOptions["expiresIn"],
	});
	return { token, jti };
};

export const signRefreshToken = (payload: { sub: string; sid: string }) => {
	const jti = crypto.randomUUID();
	const token = jwt.sign({ sid: payload.sid }, env.JWT_REFRESH_SECRET, {
		algorithm: ALGORITHM,
		subject: payload.sub,
		jwtid: jti,
		issuer: JWT_ISSUER,
		audience: JWT_AUDIENCE,
		expiresIn: env.JWT_REFRESH_EXPIRES_IN as SignOptions["expiresIn"],
	});
	return { token, jti };
};

export const verifyAccessToken = (token: string): AccessPayload =>
	jwt.verify(token, env.JWT_ACCESS_SECRET, {
		algorithms: [ALGORITHM],
		issuer: JWT_ISSUER,
		audience: JWT_AUDIENCE,
	}) as AccessPayload;

export const verifyRefreshToken = (token: string): RefreshPayload =>
	jwt.verify(token, env.JWT_REFRESH_SECRET, {
		algorithms: [ALGORITHM],
		issuer: JWT_ISSUER,
		audience: JWT_AUDIENCE,
	}) as RefreshPayload;

/** Seconds a revoked access token still has to live — the denylist TTL. */
export const remainingTtl = (exp: number): number =>
	Math.max(1, exp - Math.floor(Date.now() / 1000));
