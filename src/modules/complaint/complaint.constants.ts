import type { ComplaintStatus, Priority, Role } from "@/generated/prisma/enums.js";

/**
 * The complaint state machine. Anything not listed here is a 409
 * INVALID_TRANSITION — there is no "any admin can set any status" escape hatch.
 */
export const transitions: Record<ComplaintStatus, { to: ComplaintStatus; roles: Role[] }[]> = {
	SUBMITTED: [
		{ to: "UNDER_REVIEW", roles: ["ADMIN"] },
		{ to: "CANCELLED", roles: ["CITIZEN"] },
	],
	UNDER_REVIEW: [
		{ to: "ASSIGNED", roles: ["ADMIN"] },
		{ to: "REJECTED", roles: ["ADMIN"] },
	],
	ASSIGNED: [{ to: "IN_PROGRESS", roles: ["OFFICER"] }],
	IN_PROGRESS: [{ to: "RESOLVED", roles: ["OFFICER"] }],
	RESOLVED: [
		{ to: "CLOSED", roles: ["CITIZEN", "ADMIN"] },
		{ to: "REOPENED", roles: ["CITIZEN"] },
	],
	REOPENED: [{ to: "ASSIGNED", roles: ["ADMIN"] }],
	CLOSED: [],
	REJECTED: [],
	CANCELLED: [],
};

/** Statuses that still need somebody's attention. */
export const OPEN_STATUSES: ComplaintStatus[] = [
	"SUBMITTED",
	"UNDER_REVIEW",
	"ASSIGNED",
	"IN_PROGRESS",
	"REOPENED",
];

export const PRIORITY_LADDER: Priority[] = ["LOW", "MEDIUM", "HIGH", "URGENT"];

/** 10 upvotes push a complaint up one step, capped at URGENT. */
export const UPVOTES_FOR_PRIORITY_BUMP = 10;
export const MAX_ATTACHMENTS = 5;
export const DUPLICATE_WINDOW_HOURS = 24;
/** Radius used by the "possible duplicate" hint on create. */
export const NEARBY_DUPLICATE_METERS = 100;
export const AUTO_CLOSE_AFTER_DAYS = 7;

export const bumpPriority = (current: Priority): Priority => {
	const index = PRIORITY_LADDER.indexOf(current);
	return PRIORITY_LADDER[Math.min(index + 1, PRIORITY_LADDER.length - 1)] ?? current;
};

export const canTransition = (
	from: ComplaintStatus,
	to: ComplaintStatus,
	role: Role,
): { ok: boolean; allowedRole: boolean } => {
	const edge = transitions[from].find((t) => t.to === to);
	if (!edge) return { ok: false, allowedRole: false };
	return { ok: edge.roles.includes(role), allowedRole: edge.roles.includes(role) };
};
