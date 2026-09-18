import type { TxClient } from "@/lib/prisma.js";

export type AuditContext = {
	ip?: string | undefined;
	userAgent?: string | undefined;
};

export type AuditInput = {
	actorId?: string | null;
	action: string;
	entityType: string;
	entityId: string;
	before?: object | undefined;
	after?: object | undefined;
	ctx?: AuditContext | undefined;
};

/**
 * Append-only by database trigger — an audit row can never be edited or
 * deleted, only inserted. Always call it inside the same transaction as the
 * change it describes, so the two can never disagree.
 */
export const audit = async (
	tx: TxClient,
	{ ctx, actorId, before, after, ...data }: AuditInput,
): Promise<void> => {
	await tx.auditLog.create({
		data: {
			...data,
			actorId: actorId ?? null,
			before: (before ?? undefined) as never,
			after: (after ?? undefined) as never,
			ip: ctx?.ip ?? null,
			userAgent: ctx?.userAgent ?? null,
		},
	});
};

/** Action names used across the app — no magic strings in services. */
export const AUDIT_ACTIONS = {
	USER_REGISTERED: "USER_REGISTERED",
	USER_ROLE_UPDATED: "USER_ROLE_UPDATED",
	USER_STATUS_UPDATED: "USER_STATUS_UPDATED",
	USER_DELETED: "USER_DELETED",
	USER_SESSIONS_REVOKED: "USER_SESSIONS_REVOKED",
	PASSWORD_CHANGED: "PASSWORD_CHANGED",
	TWO_FA_TOGGLED: "TWO_FA_TOGGLED",
	OFFICER_CREATED: "OFFICER_CREATED",
	ADMIN_CREATED: "ADMIN_CREATED",
	ADMIN_REMOVED: "ADMIN_REMOVED",
	ENTITY_RESTORED: "ENTITY_RESTORED",
	SETTING_UPDATED: "SETTING_UPDATED",
	COMPLAINT_CREATED: "COMPLAINT_CREATED",
	COMPLAINT_UPDATED: "COMPLAINT_UPDATED",
	COMPLAINT_DELETED: "COMPLAINT_DELETED",
	COMPLAINT_STATUS_CHANGED: "COMPLAINT_STATUS_CHANGED",
	COMPLAINT_ASSIGNED: "COMPLAINT_ASSIGNED",
	COMPLAINT_ESCALATED: "COMPLAINT_ESCALATED",
	CATEGORY_CREATED: "CATEGORY_CREATED",
	CATEGORY_UPDATED: "CATEGORY_UPDATED",
	CATEGORY_DELETED: "CATEGORY_DELETED",
	DEPARTMENT_CREATED: "DEPARTMENT_CREATED",
	DEPARTMENT_UPDATED: "DEPARTMENT_UPDATED",
	DEPARTMENT_DELETED: "DEPARTMENT_DELETED",
	WARD_CREATED: "WARD_CREATED",
	WARD_UPDATED: "WARD_UPDATED",
	ZONE_CREATED: "ZONE_CREATED",
	SERVICE_TYPE_CREATED: "SERVICE_TYPE_CREATED",
	SERVICE_TYPE_UPDATED: "SERVICE_TYPE_UPDATED",
	SERVICE_REQUEST_CREATED: "SERVICE_REQUEST_CREATED",
	SERVICE_REQUEST_STATUS_CHANGED: "SERVICE_REQUEST_STATUS_CHANGED",
	PAYMENT_INITIATED: "PAYMENT_INITIATED",
	PAYMENT_SUCCESS: "PAYMENT_SUCCESS",
	PAYMENT_FAILED: "PAYMENT_FAILED",
	PAYMENT_REFUND_REQUESTED: "PAYMENT_REFUND_REQUESTED",
	PAYMENT_REFUNDED: "PAYMENT_REFUNDED",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
