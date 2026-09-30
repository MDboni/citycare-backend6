import PDFDocument from "pdfkit";
import { uploadBuffer } from "@/config/cloudinary.js";
import { logger } from "@/lib/logger.js";

export type ReceiptData = {
	transactionId: string;
	referenceNo: string;
	serviceName: string;
	amount: string;
	currency: string;
	payerName: string;
	payerEmail: string;
	paidAt: Date;
};

/** A4 with 50pt margins: 495pt of usable width. */
const LEFT = 50;
const RIGHT = 545;
const INK = "#111827";
const MUTED = "#6b7280";
const BRAND = "#0b6bcb";
const RULE = "#e5e7eb";

/**
 * Dhaka time, spelled out.
 *
 * The timestamp is the one line on a receipt somebody may have to argue about
 * later, so it carries its zone rather than leaving a reader to guess whether a
 * bare "18:41" was local or UTC.
 */
const stamp = (date: Date) =>
	`${new Intl.DateTimeFormat("en-GB", {
		dateStyle: "medium",
		timeStyle: "short",
		timeZone: "Asia/Dhaka",
	}).format(date)} (Asia/Dhaka)`;

const day = (date: Date) =>
	new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "Asia/Dhaka" }).format(date);

const money = (currency: string, amount: string) => {
	const value = Number(amount);
	return `${currency} ${Number.isFinite(value) ? value.toFixed(2) : amount}`;
};

const render = (data: ReceiptData): Promise<Buffer> =>
	new Promise((resolve, reject) => {
		const doc = new PDFDocument({
			size: "A4",
			margin: 50,
			info: {
				Title: `CityCare receipt ${data.transactionId}`,
				Author: "CityCare",
				Subject: `${data.serviceName} — ${data.referenceNo}`,
			},
		});
		const chunks: Buffer[] = [];

		doc.on("data", (chunk: Buffer) => chunks.push(chunk));
		doc.on("end", () => resolve(Buffer.concat(chunks)));
		doc.on("error", reject);

		const rule = (y: number) => {
			doc.moveTo(LEFT, y).lineTo(RIGHT, y).lineWidth(1).strokeColor(RULE).stroke();
		};

		/** A label above its value, in one column. */
		const field = (label: string, value: string, x: number, y: number, width: number) => {
			doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(label.toUpperCase(), x, y, {
				width,
				characterSpacing: 0.6,
			});
			doc
				.font("Helvetica-Bold")
				.fontSize(10)
				.fillColor(INK)
				.text(value, x, y + 12, { width });
		};

		// ---------------------------------------------------------------- header
		doc.font("Helvetica-Bold").fontSize(20).fillColor(BRAND).text("CityCare", LEFT, 50);
		doc
			.font("Helvetica")
			.fontSize(9)
			.fillColor(MUTED)
			.text("City Complaint & Service Platform", LEFT, 74);

		doc
			.font("Helvetica-Bold")
			.fontSize(13)
			.fillColor(INK)
			.text("PAYMENT RECEIPT", LEFT, 52, { width: RIGHT - LEFT, align: "right" });
		doc
			.font("Helvetica")
			.fontSize(9)
			.fillColor(MUTED)
			.text(`Invoice no  ${data.referenceNo}`, LEFT, 70, {
				width: RIGHT - LEFT,
				align: "right",
			})
			// Date only up here; the exact time lives once, in the details block.
			.text(`Paid  ${day(data.paidAt)}`, LEFT, 83, {
				width: RIGHT - LEFT,
				align: "right",
			});

		rule(108);

		// --------------------------------------------------------------- payer
		field("Billed to", data.payerName, LEFT, 124, 250);
		doc
			.font("Helvetica")
			.fontSize(10)
			.fillColor(MUTED)
			.text(data.payerEmail, LEFT, 150, { width: 250 });

		field("Status", "Paid in full", 330, 124, RIGHT - 330);

		// ---------------------------------------------------------------- lines
		const tableTop = 196;
		doc
			.font("Helvetica")
			.fontSize(8)
			.fillColor(MUTED)
			.text("DESCRIPTION", LEFT, tableTop, { characterSpacing: 0.6 })
			.text("AMOUNT", LEFT, tableTop, {
				width: RIGHT - LEFT,
				align: "right",
				characterSpacing: 0.6,
			});
		rule(tableTop + 14);

		doc
			.font("Helvetica")
			.fontSize(11)
			.fillColor(INK)
			.text(data.serviceName, LEFT, tableTop + 24, { width: 340 })
			.text(money(data.currency, data.amount), LEFT, tableTop + 24, {
				width: RIGHT - LEFT,
				align: "right",
			});

		rule(tableTop + 50);

		doc
			.font("Helvetica-Bold")
			.fontSize(12)
			.fillColor(INK)
			.text("Total paid", LEFT, tableTop + 62)
			.fillColor(BRAND)
			.text(money(data.currency, data.amount), LEFT, tableTop + 62, {
				width: RIGHT - LEFT,
				align: "right",
			});

		// ------------------------------------------------------ payment details
		const detailsTop = tableTop + 110;
		doc
			.font("Helvetica")
			.fontSize(8)
			.fillColor(MUTED)
			.text("PAYMENT DETAILS", LEFT, detailsTop, { characterSpacing: 0.6 });
		rule(detailsTop + 14);

		field("Transaction id", data.transactionId, LEFT, detailsTop + 26, 250);
		field("Gateway", "SSLCommerz", 330, detailsTop + 26, RIGHT - 330);
		field("Application", data.referenceNo, LEFT, detailsTop + 66, 250);
		field("Paid at", stamp(data.paidAt), 330, detailsTop + 66, RIGHT - 330);

		// ---------------------------------------------------------------- footer
		doc
			.font("Helvetica")
			.fontSize(8)
			.fillColor("#9ca3af")
			.text(
				"Generated automatically by CityCare and valid without a signature. The transaction id above is the one the payment gateway holds.",
				LEFT,
				760,
				{ width: RIGHT - LEFT, align: "center" },
			);

		doc.end();
	});

/**
 * Builds the receipt PDF in memory.
 *
 * Nothing is stored: the bytes are rendered from the payment row each time they
 * are asked for, so a receipt can never drift from the record it describes and
 * there is no file to lose. It is cheap — a single page of text.
 */
export const renderReceipt = (data: ReceiptData): Promise<Buffer> => render(data);

/**
 * Also keeps a copy in Cloudinary, for the link in the receipt email.
 *
 * A failure here must never roll back a successful payment, so the caller gets
 * `null` instead of a throw — the email still goes out, carrying the PDF as an
 * attachment, and the in-app download is unaffected.
 */
export const storeReceipt = async (pdf: Buffer, transactionId: string): Promise<string | null> => {
	try {
		const { url } = await uploadBuffer(pdf, {
			folder: "citycare/receipts",
			resourceType: "raw",
		});
		return url;
	} catch (err) {
		logger.error({ err, transactionId }, "receipt upload failed");
		return null;
	}
};
