import { inflateSync } from "node:zlib";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { type ReceiptData, renderReceipt } from "@/lib/receipt.js";

const DATA: ReceiptData = {
	transactionId: "CC-1790697182104-9bf8921d",
	referenceNo: "SR-2026-000013",
	serviceName: "Building plan approval",
	amount: "5000",
	currency: "BDT",
	payerName: "Citizen 1",
	payerEmail: "citizen1@citycare.com",
	paidAt: new Date("2026-09-29T15:54:46.257Z"),
};

const latin1 = (pdf: Buffer) => pdf.toString("latin1");

/** Every visible string, read back out of the compressed content stream. */
const textOf = (pdf: Buffer): string => {
	const raw = latin1(pdf);
	const header = /\/Length (\d+)\s*\/Filter \/FlateDecode\s*>>\s*stream\r?\n/.exec(raw);
	if (!header) throw new Error("no deflated content stream");

	const start = header.index + header[0].length;
	const body = latin1(
		inflateSync(Buffer.from(raw.slice(start, start + Number(header[1])), "latin1")),
	);

	// pdfkit writes runs as [<hex> kern <hex>] TJ, so the hex is the text.
	return [...body.matchAll(/<([0-9A-Fa-f]+)>/g)]
		.map((match) => Buffer.from(match[1], "hex").toString("latin1"))
		.join("");
};

describe("receipt pdf", () => {
	it("renders a single-page pdf", async () => {
		const pdf = await renderReceipt(DATA);

		expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
		expect(pdf.length).toBeGreaterThan(1000);
		expect(latin1(pdf).match(/\/Type \/Page[^s]/g)).toHaveLength(1);
	});

	it("prints what the payer needs to prove the payment", async () => {
		const text = textOf(await renderReceipt(DATA));

		expect(text).toContain("PAYMENT RECEIPT");
		expect(text).toContain(DATA.transactionId);
		expect(text).toContain(DATA.referenceNo);
		expect(text).toContain(DATA.serviceName);
		expect(text).toContain(DATA.payerEmail);
		// Two decimals and the currency, never a bare number.
		expect(text).toContain("BDT 5000.00");
		// The timestamp says which clock it is on.
		expect(text).toContain("(Asia/Dhaka)");
	});

	it("falls back to the raw amount when it is not a number", async () => {
		const text = textOf(await renderReceipt({ ...DATA, amount: "unknown" }));
		expect(text).toContain("BDT unknown");
	});
});

/** The shape nodemailer is handed. Typed so the assertions need no casts. */
type SentMail = {
	to: string;
	subject: string;
	html: string;
	attachments?: { filename: string; content: Buffer; contentType: string }[];
};

/**
 * The mailer is mocked for the whole suite in tests/setup.ts, because no test
 * should be able to send mail by accident. This file is the exception that has
 * to read what it would have sent, so it unmocks the module and mocks the
 * transport underneath it instead — nothing leaves the process either way.
 */
vi.unmock("@/lib/mailer.js");

describe("receipt email", () => {
	const sendMail = vi.fn(async (_message: SentMail) => ({}));
	let sendReceiptEmail: typeof import("@/lib/mailer.js").sendReceiptEmail;

	beforeAll(async () => {
		vi.doMock("nodemailer", () => ({
			default: { createTransport: () => ({ sendMail, verify: vi.fn(async () => true) }) },
		}));
		// The mailer writes an EmailLog row per send; it has no database here.
		vi.doMock("@/lib/prisma.js", () => ({
			prisma: {
				emailLog: {
					create: vi.fn(async () => ({ id: "log-1" })),
					update: vi.fn(async () => ({})),
				},
			},
		}));

		// send() short-circuits without credentials, which would skip the transport.
		process.env.SMTP_USER = "mailer@example.test";
		process.env.SMTP_PASS = "not-a-real-password";

		({ sendReceiptEmail } = await import("@/lib/mailer.js"));
	});

	it("attaches the pdf, and says so, when one was rendered", async () => {
		const pdf = await renderReceipt(DATA);

		await sendReceiptEmail("payer@example.test", {
			transactionId: DATA.transactionId,
			amount: DATA.amount,
			serviceName: DATA.serviceName,
			referenceNo: DATA.referenceNo,
			pdf,
		});

		const message = sendMail.mock.calls.at(-1)?.[0];
		expect(message?.to).toBe("payer@example.test");
		expect(message?.subject).toContain(DATA.transactionId);
		expect(message?.attachments).toHaveLength(1);
		expect(message?.attachments?.[0]).toMatchObject({
			filename: `CityCare-receipt-${DATA.transactionId}.pdf`,
			contentType: "application/pdf",
		});
		expect(message?.attachments?.[0].content.subarray(0, 5).toString("latin1")).toBe("%PDF-");
		expect(message?.html).toContain("attached to this email as a PDF");
		expect(message?.html).toContain(DATA.referenceNo);
	});

	it("points at the payments page when the pdf could not be rendered", async () => {
		await sendReceiptEmail("payer@example.test", {
			transactionId: DATA.transactionId,
			amount: DATA.amount,
			serviceName: DATA.serviceName,
		});

		const message = sendMail.mock.calls.at(-1)?.[0];
		expect(message?.attachments).toBeUndefined();
		expect(message?.html).toContain("available from the Payments page");
	});
});
