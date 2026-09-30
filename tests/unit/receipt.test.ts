import { describe, expect, it, vi } from "vitest";
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

/** Every visible string, read back out of the compressed content stream. */
const textOf = async (pdf: Buffer): Promise<string> => {
	const { inflateSync } = await import("node:zlib");
	const raw = pdf.toString("latin1");
	const header = /\/Length (\d+)\s*\/Filter \/FlateDecode\s*>>\s*stream\r?\n/.exec(raw);
	if (!header) throw new Error("no deflated content stream");

	const start = header.index + header[0].length;
	const body = inflateSync(
		Buffer.from(raw.slice(start, start + Number(header[1])), "latin1"),
	).toString("latin1");

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
		expect(raw(pdf).match(/\/Type \/Page[^s]/g)).toHaveLength(1);
	});

	it("prints what the payer needs to prove the payment", async () => {
		const text = await textOf(await renderReceipt(DATA));

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
		const text = await textOf(await renderReceipt({ ...DATA, amount: "unknown" }));
		expect(text).toContain("BDT unknown");
	});
});

describe("receipt email", () => {
	it("attaches the pdf", async () => {
		const sendMail = vi.fn(async () => ({}));

		vi.doMock("nodemailer", () => ({
			default: { createTransport: () => ({ sendMail, verify: vi.fn(async () => true) }) },
		}));
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

		const mailer = await import("@/lib/mailer.js?receipt-attachment");
		const pdf = await renderReceipt(DATA);

		await mailer.sendReceiptEmail("payer@example.test", {
			transactionId: DATA.transactionId,
			amount: DATA.amount,
			serviceName: DATA.serviceName,
			referenceNo: DATA.referenceNo,
			pdf,
		});

		expect(sendMail).toHaveBeenCalledTimes(1);
		const message = sendMail.mock.calls[0][0] as {
			to: string;
			html: string;
			attachments?: { filename: string; content: Buffer; contentType: string }[];
		};

		expect(message.to).toBe("payer@example.test");
		expect(message.attachments).toHaveLength(1);
		expect(message.attachments?.[0]).toMatchObject({
			filename: `CityCare-receipt-${DATA.transactionId}.pdf`,
			contentType: "application/pdf",
		});
		expect(message.attachments?.[0].content.subarray(0, 5).toString("latin1")).toBe("%PDF-");
		expect(message.html).toContain("attached to this email as a PDF");
	});

	it("says where the receipt is when there is no attachment", async () => {
		const sendMail = vi.fn(async () => ({}));

		vi.doMock("nodemailer", () => ({
			default: { createTransport: () => ({ sendMail, verify: vi.fn(async () => true) }) },
		}));
		vi.doMock("@/lib/prisma.js", () => ({
			prisma: {
				emailLog: {
					create: vi.fn(async () => ({ id: "log-2" })),
					update: vi.fn(async () => ({})),
				},
			},
		}));

		const mailer = await import("@/lib/mailer.js?receipt-no-attachment");

		await mailer.sendReceiptEmail("payer@example.test", {
			transactionId: DATA.transactionId,
			amount: DATA.amount,
			serviceName: DATA.serviceName,
		});

		const message = sendMail.mock.calls[0][0] as { html: string; attachments?: unknown[] };
		expect(message.attachments).toBeUndefined();
		expect(message.html).toContain("available from the Payments page");
	});
});

const raw = (pdf: Buffer) => pdf.toString("latin1");
