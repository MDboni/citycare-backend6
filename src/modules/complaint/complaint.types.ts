/**
 * The three columns an access check needs, and nothing else.
 *
 * Kept narrow on purpose: `assertCanRead` is handed the result of a `select`
 * rather than a whole complaint, so a caller cannot accidentally satisfy it with
 * a row it has not actually loaded the owner of.
 */
export type AccessRow = {
	citizenId: string;
	officerId: string | null;
	categoryId: string;
};
