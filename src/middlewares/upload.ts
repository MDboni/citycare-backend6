import type { RequestHandler } from "express";
import { fileTypeFromBuffer } from "file-type";
import multer from "multer";
import { ApiError } from "@/utils/ApiError.js";
import { catchAsync } from "@/utils/catchAsync.js";

/**
 * 4 MB rather than the 5 you might expect: serverless hosts cap a request body
 * at 4.5 MB, and a file rejected at the platform edge never reaches this
 * middleware, so the caller gets an opaque platform error instead of our 400.
 * Staying under that line keeps every rejection ours to explain.
 */
export const MAX_FILE_SIZE = 4 * 1024 * 1024; // 4 MB

const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const DOCUMENT_MIME = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

/**
 * Memory storage only — nothing ever touches the server's disk; buffers go
 * straight to Cloudinary.
 */
const storage = multer.memoryStorage();

const makeUploader = (allowed: Set<string>) =>
	multer({
		storage,
		limits: { fileSize: MAX_FILE_SIZE, files: 5 },
		fileFilter: (_req, file, cb) => {
			// A first cheap check; the magic-byte check below is the real one.
			if (!allowed.has(file.mimetype)) {
				cb(
					new ApiError(400, "Unsupported file type", [
						{
							field: file.fieldname,
							code: "VALIDATION_ERROR",
							message: `Allowed: ${[...allowed].join(", ")}`,
						},
					]),
				);
				return;
			}
			cb(null, true);
		},
	});

export const uploadImage = makeUploader(IMAGE_MIME);
export const uploadDocument = makeUploader(DOCUMENT_MIME);

/**
 * The declared Content-Type is attacker-controlled, so the real bytes decide.
 * This is what turns an `.exe` renamed to `.jpg` into a 400.
 */
export const verifyFileType = (allowed: Set<string>): RequestHandler =>
	catchAsync(async (req, _res, next) => {
		const files: Express.Multer.File[] = req.file
			? [req.file]
			: Array.isArray(req.files)
				? req.files
				: Object.values(req.files ?? {}).flat();

		for (const file of files) {
			const detected = await fileTypeFromBuffer(file.buffer);
			if (!detected || !allowed.has(detected.mime)) {
				throw new ApiError(400, "File content does not match its extension", [
					{
						field: file.fieldname,
						code: "VALIDATION_ERROR",
						message: `Detected type: ${detected?.mime ?? "unknown"}`,
					},
				]);
			}
		}
		next();
	});

export const verifyImage = verifyFileType(IMAGE_MIME);
export const verifyDocument = verifyFileType(DOCUMENT_MIME);

export const requireFile =
	(field: string): RequestHandler =>
	(req, _res, next) => {
		if (!req.file) {
			throw new ApiError(400, "Validation failed", [
				{ field, code: "VALIDATION_ERROR", message: `${field} file is required` },
			]);
		}
		next();
	};
