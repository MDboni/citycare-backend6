import { describe, expect, it } from "vitest";
import { maskEmail, otpHash, randomOtp, safeEqual, sha256 } from "@/utils/crypto.js";

describe("otp hashing", () => {
	it("is deterministic and never the plain value", () => {
		const hash = otpHash("123456");
		expect(hash).toBe(otpHash("123456"));
		expect(hash).not.toContain("123456");
		expect(hash).toHaveLength(64);
	});

	it("differs from a plain sha256, so a rainbow table is useless", () => {
		expect(otpHash("123456")).not.toBe(sha256("123456"));
	});

	it("produces a different hash for a different otp", () => {
		expect(otpHash("123456")).not.toBe(otpHash("123457"));
	});
});

describe("safeEqual", () => {
	it("matches identical strings", () => {
		expect(safeEqual("abc", "abc")).toBe(true);
	});

	it("rejects different strings and different lengths without throwing", () => {
		expect(safeEqual("abc", "abd")).toBe(false);
		expect(safeEqual("abc", "abcdef")).toBe(false);
	});
});

describe("randomOtp", () => {
	it("is always six digits", () => {
		for (let i = 0; i < 200; i += 1) {
			expect(randomOtp()).toMatch(/^\d{6}$/);
		}
	});
});

describe("maskEmail", () => {
	it("keeps the shape without revealing the address", () => {
		expect(maskEmail("citizen1@citycare.com")).toBe("c*****1@citycare.com");
		expect(maskEmail("ab@x.com")).toBe("a***@x.com");
	});
});
