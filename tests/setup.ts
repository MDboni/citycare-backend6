import { beforeAll, vi } from "vitest";

/**
 * Test environment. Secrets are dummies — the point is that env validation
 * passes, not that they are strong.
 */
process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET ??= "test-access-secret-test-access-secret-test";
process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret-test-refresh-secret-t";
process.env.OTP_SECRET ??= "test-otp-secret-test-otp-secret-test-otp-s";
process.env.DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	process.env.DATABASE_URL ??
	"postgresql://localhost:5432/citycare_test";
process.env.BCRYPT_SALT_ROUNDS ??= "10";

/**
 * Nothing leaves the machine during a test run: no SMTP, no payment gateway.
 * Integration tests read the OTP back from these mocks' call arguments.
 */
vi.mock("@/lib/mailer.js", () => ({
	smtpConfigured: false,
	verifyMailer: vi.fn(async () => false),
	sendOtpEmail: vi.fn(async () => {}),
	sendLoginOtpEmail: vi.fn(async () => {}),
	sendNewLoginAlert: vi.fn(async () => {}),
	sendPasswordResetEmail: vi.fn(async () => {}),
	sendStatusUpdateEmail: vi.fn(async () => {}),
	sendReceiptEmail: vi.fn(async () => {}),
	sendOfficerInviteEmail: vi.fn(async () => {}),
	sendEscalationEmail: vi.fn(async () => {}),
	transporter: { sendMail: vi.fn(), verify: vi.fn() },
}));

vi.mock("sslcommerz-lts", () => ({
	default: class {
		async init() {
			return { status: "SUCCESS", GatewayPageURL: "https://sandbox.sslcommerz.test/pay/fake" };
		}
		async validate({ val_id }: { val_id: string }) {
			// Only the id the test hands out is ever "VALID"; anything else is a forgery.
			return val_id === "valid-val-id"
				? { status: "VALID", tran_id: process.env.TEST_TRAN_ID, amount: "50.00", currency: "BDT" }
				: { status: "INVALID_TRANSACTION" };
		}
		async initiateRefund() {
			return { APIConnect: "DONE", status: "success", refund_ref_id: "refund-123" };
		}
	},
}));

/** Integration tests need a real Postgres; unit tests do not. */
export const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

beforeAll(() => {
	if (!hasTestDb) {
		console.warn(
			"\n  TEST_DATABASE_URL is not set — integration tests are skipped.\n" +
				"  Point it at a throwaway database to run the full suite.\n",
		);
	}
});
