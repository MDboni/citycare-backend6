import { v2 as cloudinary } from "cloudinary";
import { env } from "@/config/env.js";
import { logger } from "@/lib/logger.js";
import { ApiError } from "@/utils/ApiError.js";
import { randomToken } from "@/utils/crypto.js";

cloudinary.config({
	cloud_name: env.CLOUDINARY_CLOUD_NAME,
	api_key: env.CLOUDINARY_API_KEY,
	api_secret: env.CLOUDINARY_API_SECRET,
	secure: true,
});

export const cloudinaryConfigured = Boolean(
	env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET,
);

export type UploadResult = { url: string; publicId: string };

export type UploadOptions = {
	folder: string;
	/** "authenticated" for NID / trade licence scans — never publicly readable. */
	type?: "upload" | "authenticated";
	resourceType?: "image" | "raw" | "auto";
};

/**
 * Uploads a buffer straight from memory. The public id is random, so a leaked
 * URL cannot be used to guess a neighbouring user's file.
 */
export const uploadBuffer = (buffer: Buffer, options: UploadOptions): Promise<UploadResult> => {
	if (!cloudinaryConfigured) {
		throw new ApiError(503, "File storage is not configured", [
			{ code: "SERVICE_UNAVAILABLE", message: "Cloudinary credentials are missing" },
		]);
	}

	return new Promise((resolve, reject) => {
		const stream = cloudinary.uploader.upload_stream(
			{
				folder: options.folder,
				public_id: randomToken(12),
				type: options.type ?? "upload",
				resource_type: options.resourceType ?? "image",
				overwrite: false,
				invalidate: true,
			},
			(error, result) => {
				if (error || !result) {
					logger.error({ err: error }, "cloudinary upload failed");
					reject(new ApiError(502, "File upload failed", [{ code: "GATEWAY_ERROR" }]));
					return;
				}
				resolve({ url: result.secure_url, publicId: result.public_id });
			},
		);
		stream.end(buffer);
	});
};

/** Time-limited download link for an `authenticated` asset (default 10 min). */
export const signedUrl = (publicId: string, expiresInSec = 600): string =>
	cloudinary.url(publicId, {
		type: "authenticated",
		sign_url: true,
		secure: true,
		expires_at: Math.floor(Date.now() / 1000) + expiresInSec,
	});

export const destroyAsset = async (
	publicId: string,
	type: "upload" | "authenticated" = "upload",
) => {
	try {
		await cloudinary.uploader.destroy(publicId, { type });
	} catch (err) {
		logger.warn({ err, publicId }, "cloudinary destroy failed");
	}
};

export { cloudinary };
