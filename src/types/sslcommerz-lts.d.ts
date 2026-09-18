/**
 * `sslcommerz-lts` ships no types. This declares only the surface CityCare
 * uses; the raw gateway payload stays `unknown` on purpose, because it is
 * attacker-influenced data that must be validated before use.
 */
declare module "sslcommerz-lts" {
	export type SslInitPayload = Record<string, string | number | undefined>;

	export type SslInitResponse = {
		status?: string;
		failedreason?: string;
		GatewayPageURL?: string;
		sessionkey?: string;
		[key: string]: unknown;
	};

	export type SslValidationResponse = {
		status?: string;
		tran_id?: string;
		val_id?: string;
		amount?: string | number;
		currency?: string;
		card_type?: string;
		bank_tran_id?: string;
		[key: string]: unknown;
	};

	export type SslRefundResponse = {
		APIConnect?: string;
		status?: string;
		refund_ref_id?: string;
		errorReason?: string;
		[key: string]: unknown;
	};

	export default class SSLCommerzPayment {
		constructor(storeId: string, storePassword: string, isLive?: boolean);
		init(payload: SslInitPayload): Promise<SslInitResponse>;
		validate(payload: { val_id: string }): Promise<SslValidationResponse>;
		initiateRefund(payload: {
			refund_amount: number | string;
			refund_remarks: string;
			bank_tran_id: string;
			refe_id?: string;
		}): Promise<SslRefundResponse>;
		transactionQueryByTransactionId(payload: { tran_id: string }): Promise<SslValidationResponse>;
	}
}
