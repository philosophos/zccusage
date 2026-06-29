import type { PaymentRecord } from './_types.ts';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import * as v from 'valibot';
import { PAYMENTS_FILE_NAME } from './_consts.ts';
import { paymentRecordSchema } from './_types.ts';
import { getClaudePaths } from './data-loader.ts';
import { logger } from './logger.ts';

/**
 * Payment records loader — reads the per-transaction payment log
 * (`better-ccusage-payments.json`) from the same directories searched for the
 * Claude config, or from an explicit path.
 *
 * Payments are decoupled from usage entries (payment time ≠ usage time). Each
 * record carries dual-currency amounts (billing + payment) that implicitly
 * capture the effective FX rate at payment time.
 */

const paymentsFileSchema = v.array(paymentRecordSchema);

/**
 * Build candidate payments file paths, mirroring the config search order:
 * 1. `./.better-ccusage/better-ccusage-payments.json`
 * 2. `<each claude config dir>/better-ccusage-payments.json`
 */
function buildPaymentsSearchPaths(): string[] {
	const dirs = [path.join(process.cwd(), '.better-ccusage')];
	try {
		dirs.push(...getClaudePaths());
	}
	catch {
		// getClaudePaths throws if no valid Claude dir exists — payments are
		// optional, so fall back to just the local cwd candidate.
	}
	return dirs.map(dir => path.join(dir, PAYMENTS_FILE_NAME));
}

/**
 * Resolve the payments file path to read: explicit `paymentsPath` if given,
 * otherwise the first existing candidate from the search paths.
 */
function resolvePaymentsPath(paymentsPath?: string): string | undefined {
	if (paymentsPath != null && paymentsPath !== '') {
		return existsSync(paymentsPath) ? paymentsPath : undefined;
	}
	for (const candidate of buildPaymentsSearchPaths()) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * Load and validate all payment records from the log file.
 * Returns an empty array if no file is found or the file is malformed
 * (malformed entries are skipped silently with a warning).
 */
export function loadPaymentRecords(paymentsPath?: string): PaymentRecord[] {
	const filePath = resolvePaymentsPath(paymentsPath);
	if (filePath == null) {
		return [];
	}

	let raw: string;
	try {
		raw = readFileSync(filePath, 'utf-8');
	}
	catch (err) {
		logger.warn(`Failed to read payments file ${filePath}: ${(err as Error).message}`);
		return [];
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	}
	catch (err) {
		logger.warn(`Payments file ${filePath} is not valid JSON: ${(err as Error).message}`);
		return [];
	}

	const result = v.safeParse(paymentsFileSchema, parsed);
	if (result.success) {
		return result.output;
	}
	// Fall back to per-entry validation: keep the valid ones, drop the rest.
	if (!Array.isArray(parsed)) {
		logger.warn(`Payments file ${filePath}: expected an array`);
		return [];
	}
	const records: PaymentRecord[] = [];
	for (const entry of parsed) {
		const entryResult = v.safeParse(paymentRecordSchema, entry);
		if (entryResult.success) {
			records.push(entryResult.output);
		}
	}
	logger.warn(`Payments file ${filePath}: loaded ${records.length}/${parsed.length} records (dropped invalid entries)`);
	return records;
}

export type PaymentFilterOptions = {
	from?: Date; // inclusive lower bound on paymentTime
	to?: Date; // inclusive upper bound on paymentTime
	providerId?: string; // restrict to a single platform
};

/**
 * Load payment records filtered by time range and/or provider.
 */
export function loadPayments(options: PaymentFilterOptions & { paymentsPath?: string } = {}): PaymentRecord[] {
	const records = loadPaymentRecords(options.paymentsPath);
	return records.filter((r) => {
		if (options.providerId != null && r.providerId !== options.providerId) {
			return false;
		}
		const time = new Date(r.paymentTime).getTime();
		if (Number.isNaN(time)) {
			return false;
		}
		if (options.from != null && time < options.from.getTime()) {
			return false;
		}
		if (options.to != null && time > options.to.getTime()) {
			return false;
		}
		return true;
	});
}

// ─── In-source tests ─────────────────────────────────────────────────────────

if (import.meta.vitest != null) {
	describe('loadPaymentRecords', () => {
		it('returns empty when no file exists', () => {
			expect(loadPaymentRecords('/nonexistent/path.json')).toEqual([]);
		});
	});
}
