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

const render = (data: ReceiptData): Promise<Buffer> =>
	new Promise((resolve, reject) => {
		const doc = new PDFDocument({ size: "A4", margin: 50 });
		const chunks: Buffer[] = [];

		doc.on("data", (chunk: Buffer) => chunks.push(chunk));
		doc.on("end", () => resolve(Buffer.concat(chunks)));
		doc.on("error", reject);

		doc.fontSize(22).fillColor("#0b6bcb").text("CityCare", { align: "left" });
		doc.fontSize(10).fillColor("#6b7280").text("City Complaint & Service Platform");
		doc.moveDown(1.5);

		doc.fontSize(16).fillColor("#111827").text("Payment receipt");
		doc.moveDown(0.8);

		const row = (label: string, value: string) => {
			doc.fontSize(11).fillColor("#6b7280").text(label, { continued: true });
			doc.fillColor("#111827").text(`  ${value}`);
			doc.moveDown(0.3);
		};

		row("Transaction id:", data.transactionId);
		row("Reference no:", data.referenceNo);
		row("Service:", data.serviceName);
		row("Paid by:", `${data.payerName} (${data.payerEmail})`);
		row("Paid at:", data.paidAt.toISOString());
		doc.moveDown(0.6);
		doc.fontSize(15).fillColor("#0b6bcb").text(`Amount: ${data.currency} ${data.amount}`);

		doc.moveDown(2);
		doc
			.fontSize(9)
			.fillColor("#9ca3af")
			.text("This receipt was generated automatically and is valid without a signature.");

		doc.end();
	});

/**
 * Renders the receipt and stores it in Cloudinary. A failure here must never
 * roll back a successful payment, so the caller gets `null` instead of a throw.
 */
export const generateReceipt = async (data: ReceiptData): Promise<string | null> => {
	try {
		const pdf = await render(data);
		const { url } = await uploadBuffer(pdf, {
			folder: "citycare/receipts",
			resourceType: "raw",
		});
		return url;
	} catch (err) {
		logger.error({ err, transactionId: data.transactionId }, "receipt generation failed");
		return null;
	}
};
