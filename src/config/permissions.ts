/**
 * The permission catalogue.
 *
 * This is the single source of truth: route guards reference `PERMISSIONS.x`,
 * the seed writes exactly this list into the database, and the console renders
 * it as the matrix on Settings → Access. A code that is not here cannot be
 * referenced by a route, and a route cannot reference a code that will not
 * exist after seeding — the two drift apart otherwise, and the failure mode is
 * a 403 nobody can explain.
 *
 * `defaultRoles` is only used to build the three seeded system roles, which
 * reproduce today's access exactly. After seeding it means nothing: an admin
 * can hand any permission to any role from the console.
 */

import type { Role } from "@/generated/prisma/enums.js";

export type PermissionDefinition = {
	code: string;
	name: string;
	description: string;
	category: string;
	/** Which enum roles hold this in the freshly seeded system roles. */
	defaultRoles: Role[];
	/** Super-admin-only capabilities start life granted to nobody else. */
	superAdminOnly?: boolean;
};

export const PERMISSION_CATALOGUE = [
	// ── Complaints ──────────────────────────────────────────────────────────
	{
		code: "complaints__view_all",
		name: "View all complaints",
		description: "See the full complaint queue, not just one citizen's own reports.",
		category: "Complaints",
		defaultRoles: ["ADMIN", "OFFICER"],
	},
	{
		code: "complaints__assign",
		name: "Assign complaints",
		description: "Route a complaint to a department and an officer.",
		category: "Complaints",
		defaultRoles: ["ADMIN"],
	},
	{
		code: "complaints__update_status",
		name: "Move a complaint through its states",
		description: "Start work, resolve, reject or close a complaint.",
		category: "Complaints",
		defaultRoles: ["ADMIN", "OFFICER"],
	},
	{
		code: "complaints__comment_internal",
		name: "Post internal notes",
		description: "Comment on a complaint in a note the citizen never sees.",
		category: "Complaints",
		defaultRoles: ["ADMIN", "OFFICER"],
	},
	{
		code: "complaints__delete",
		name: "Delete complaints",
		description: "Soft-delete a complaint. Rarely correct; prefer rejecting it.",
		category: "Complaints",
		defaultRoles: ["ADMIN"],
	},

	// ── Service requests ────────────────────────────────────────────────────
	{
		code: "service_requests__view_all",
		name: "View all service requests",
		description: "See every citizen's applications, not just your own.",
		category: "Service requests",
		defaultRoles: ["ADMIN", "OFFICER"],
	},
	{
		code: "service_requests__process",
		name: "Process service requests",
		description: "Approve, reject or complete an application.",
		category: "Service requests",
		defaultRoles: ["ADMIN", "OFFICER"],
	},

	// ── Payments ────────────────────────────────────────────────────────────
	{
		code: "payments__view_all",
		name: "View all payments",
		description: "See every transaction and its gateway history.",
		category: "Payments",
		defaultRoles: ["ADMIN"],
	},
	{
		code: "payments__refund_request",
		name: "Request a refund",
		description: "Raise a refund against a settled payment.",
		category: "Payments",
		defaultRoles: ["ADMIN"],
	},
	{
		code: "payments__refund_approve",
		name: "Approve a refund",
		description: "Release money back to a citizen. Separate from requesting one on purpose.",
		category: "Payments",
		defaultRoles: [],
		superAdminOnly: true,
	},

	// ── People ──────────────────────────────────────────────────────────────
	{
		code: "users__view",
		name: "View users",
		description: "Browse citizen and staff accounts.",
		category: "People",
		defaultRoles: ["ADMIN"],
	},
	{
		code: "users__create_officer",
		name: "Create officers",
		description: "Add an officer account and attach it to a department.",
		category: "People",
		defaultRoles: ["ADMIN"],
	},
	{
		code: "users__change_role",
		name: "Change account type",
		description: "Move an account between citizen, officer and admin.",
		category: "People",
		defaultRoles: ["ADMIN"],
	},
	{
		code: "users__change_status",
		name: "Block and unblock accounts",
		description: "Stop an account signing in without deleting it.",
		category: "People",
		defaultRoles: ["ADMIN"],
	},
	{
		code: "users__force_logout",
		name: "Force sign-out",
		description: "Revoke every live session for an account.",
		category: "People",
		defaultRoles: ["ADMIN"],
	},
	{
		code: "users__create_admin",
		name: "Create admins",
		description: "Add another administrator.",
		category: "People",
		defaultRoles: [],
		superAdminOnly: true,
	},
	{
		code: "users__remove_admin",
		name: "Remove admins",
		description: "Strip administrator access from an account.",
		category: "People",
		defaultRoles: [],
		superAdminOnly: true,
	},

	// ── Taxonomy ────────────────────────────────────────────────────────────
	{
		code: "taxonomy__manage_departments",
		name: "Manage departments",
		description: "Create, rename and retire departments.",
		category: "Taxonomy",
		defaultRoles: ["ADMIN"],
	},
	{
		code: "taxonomy__manage_categories",
		name: "Manage categories",
		description: "Create complaint categories and set their SLA hours.",
		category: "Taxonomy",
		defaultRoles: ["ADMIN"],
	},
	{
		code: "taxonomy__manage_wards",
		name: "Manage wards",
		description: "Create and edit wards.",
		category: "Taxonomy",
		defaultRoles: ["ADMIN"],
	},
	{
		code: "taxonomy__manage_zones",
		name: "Manage zones",
		description: "Create and edit zones.",
		category: "Taxonomy",
		defaultRoles: ["ADMIN"],
	},
	{
		code: "taxonomy__manage_service_types",
		name: "Manage service types",
		description: "Create civic services and set their fees.",
		category: "Taxonomy",
		defaultRoles: ["ADMIN"],
	},

	// ── Contact ─────────────────────────────────────────────────────────────
	{
		code: "contact__manage_messages",
		name: "Read contact messages",
		description: "Open the public contact form inbox and mark messages handled.",
		category: "Contact",
		defaultRoles: ["ADMIN"],
	},

	// ── Oversight ───────────────────────────────────────────────────────────
	{
		code: "oversight__view_dashboard",
		name: "View the overview",
		description: "See city-wide counts and charts on the console overview.",
		category: "Oversight",
		defaultRoles: ["ADMIN"],
	},
	{
		code: "oversight__view_reports",
		name: "View reports",
		description: "Open the SLA report and export complaint CSVs.",
		category: "Oversight",
		defaultRoles: ["ADMIN"],
	},
	{
		code: "oversight__view_audit_logs",
		name: "View the audit log",
		description: "Read the record of who changed what.",
		category: "Oversight",
		defaultRoles: ["ADMIN"],
	},
	{
		code: "oversight__view_security_events",
		name: "View security events",
		description: "Read sign-in failures, lockouts and token reuse.",
		category: "Oversight",
		defaultRoles: ["ADMIN"],
	},
	{
		code: "oversight__manage_settings",
		name: "Change system settings",
		description: "Edit the reopen limit, SLA factors and other global knobs.",
		category: "Oversight",
		defaultRoles: [],
		superAdminOnly: true,
	},

	// ── Access control ──────────────────────────────────────────────────────
	{
		code: "access_control__manage_users",
		name: "Assign roles to users",
		description: "Give and take away access roles on the Access screen.",
		category: "Access control",
		defaultRoles: [],
		superAdminOnly: true,
	},
	{
		code: "access_control__manage_roles",
		name: "Manage roles",
		description: "Create roles and choose which permissions they carry.",
		category: "Access control",
		defaultRoles: [],
		superAdminOnly: true,
	},
	{
		code: "access_control__manage_permissions",
		name: "Manage permissions",
		description: "Create and edit the permissions roles are built from.",
		category: "Access control",
		defaultRoles: [],
		superAdminOnly: true,
	},
] as const satisfies readonly PermissionDefinition[];

/** `PERMISSIONS.complaints__assign` is a typo-proof way to name a code. */
export const PERMISSIONS = Object.fromEntries(
	PERMISSION_CATALOGUE.map((p) => [p.code, p.code]),
) as { [K in (typeof PERMISSION_CATALOGUE)[number]["code"]]: K };

export type PermissionCode = keyof typeof PERMISSIONS;

/** The three seeded roles, named for humans rather than for the enum. */
export const SYSTEM_ROLES: { role: Role; name: string; description: string }[] = [
	{
		role: "CITIZEN",
		name: "Citizen",
		description: "The default for every public account. Holds no console permissions.",
	},
	{
		role: "OFFICER",
		name: "Officer",
		description: "Works the queue for one department: assignment, status changes, internal notes.",
	},
	{
		role: "ADMIN",
		name: "Administrator",
		description: "Runs the city-wide console: routing, taxonomy, people and reports.",
	},
];
