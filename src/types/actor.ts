import type { Role } from "@/generated/prisma/enums.js";

/**
 * Who is asking.
 *
 * Every service that makes an access decision takes one of these rather than the
 * raw `req.user`, so the rule can be read — and tested — without an Express
 * request in hand. The controllers build it; nothing below them knows about HTTP.
 *
 * It lives here rather than inside a module because five of them need it:
 * complaints, service requests, payments and admin all answer "may this person
 * do that". Declaring it in whichever module happened to need it first made the
 * other four import a type from a neighbour they otherwise have no business with.
 */
export type Actor = {
	id: string;
	role: Role;
	departmentId: string | null;
	email: string;
	name: string;
};

/**
 * The admin routes need one fact more than the rest: a super admin outranks an
 * ordinary admin, and several of those checks turn on it. Kept as an
 * intersection so anything taking a plain `Actor` still accepts one.
 */
export type AdminActor = Actor & { isSuperAdmin: boolean };
