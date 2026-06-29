import type { PaymentRecord } from './_types.ts';

/**
 * Currency conversion — derives an exchange rate from manually-supplied
 * payment records (no automatic FX fetching) with a config-rate fallback.
 *
 * Strategy (fallback chain):
 *  1. `from === to` → 1
 *  2. Last-known spot: the most recent payment record whose `paymentTime` is
 *     ≤ `date` and whose currency pair matches (`billingCurrency=from`,
 *     `paymentCurrency=to`). Implied rate = paymentAmount / billingAmount.
 *  3. User-configured rate: `configRates["FROM/TO"]`.
 *  4. `null` — no rate available; callers should keep the original currency.
 *
 * Payments are decoupled from usage by time (payment time ≠ usage time), so
 * "last-known spot" mirrors how real FX works and is unambiguous.
 */

export type ConversionContext = {
	paymentRecords?: PaymentRecord[];
	configRates?: Record<string, number>;
	date?: Date;
};

const pairKey = (from: string, to: string): string => `${from.toUpperCase()}/${to.toUpperCase()}`;

/**
 * Find the implied rate from payment records for a currency pair as of `date`.
 * Returns the most recent (paymentTime ≤ date) matching record's implied rate,
 * or undefined if none.
 */
function findPaymentImpliedRate(from: string, to: string, ctx: ConversionContext): number | undefined {
	const records = ctx.paymentRecords;
	if (records == null || records.length === 0) {
		return undefined;
	}
	const cutoff = ctx.date ?? new Date();
	const cutoffMs = cutoff.getTime();

	let best: { timeMs: number; rate: number } | undefined;
	for (const r of records) {
		if (r.billingCurrency.toUpperCase() !== from.toUpperCase()) {
			continue;
		}
		if (r.paymentCurrency.toUpperCase() !== to.toUpperCase()) {
			continue;
		}
		if (r.billingAmount <= 0) {
			continue;
		}
		const timeMs = new Date(r.paymentTime).getTime();
		if (Number.isNaN(timeMs) || timeMs > cutoffMs) {
			continue; // future payment relative to cutoff — skip
		}
		if (best == null || timeMs > best.timeMs) {
			best = { timeMs, rate: r.paymentAmount / r.billingAmount };
		}
	}
	return best?.rate;
}

/**
 * Resolve the exchange rate `from → to` (1 unit of `from` = rate units of `to`).
 * Returns `null` when no rate is available — callers should then keep the
 * original currency rather than silently misreporting.
 */
export function resolveRate(from: string, to: string, ctx: ConversionContext = {}): number | null {
	if (from.toUpperCase() === to.toUpperCase()) {
		return 1;
	}
	const implied = findPaymentImpliedRate(from, to, ctx);
	if (implied != null) {
		return implied;
	}
	const configured = ctx.configRates?.[pairKey(from, to)];
	if (configured != null) {
		return configured;
	}
	return null;
}

/**
 * Convert `amount` from currency `from` to `to`. On no rate available, returns
 * `null` so the display layer can fall back to the original-currency value.
 */
export function convert(amount: number, from: string, to: string, ctx: ConversionContext = {}): number | null {
	const rate = resolveRate(from, to, ctx);
	if (rate == null) {
		return null;
	}
	return amount * rate;
}

/**
 * Sum a multi-currency cost map (`Record<currency, amount>`) into a single
 * statistics-currency total. Unconverted currencies (no rate) are excluded from
 * the total; the caller may surface them separately. Returns the total and the
 * set of currencies that could not be converted.
 */
export function sumToCurrency(
	costByCurrency: Record<string, number>,
	toCurrency: string,
	ctx: ConversionContext = {},
): { total: number; unconverted: string[] } {
	let total = 0;
	const unconverted: string[] = [];
	for (const [currency, amount] of Object.entries(costByCurrency)) {
		const converted = convert(amount, currency, toCurrency, ctx);
		if (converted == null) {
			unconverted.push(currency);
		}
		else {
			total += converted;
		}
	}
	return { total, unconverted };
}

// ─── In-source tests ─────────────────────────────────────────────────────────

if (import.meta.vitest != null) {
	describe('resolveRate', () => {
		it('same currency → 1', () => {
			expect(resolveRate('USD', 'USD')).toBe(1);
		});
		it('payment-implied last-known spot', () => {
			const records = [
				{ paymentTime: '2026-01-01T00:00:00.000Z' as never, billingCurrency: 'USD' as never, billingAmount: 10, paymentCurrency: 'CNY' as never, paymentAmount: 72 },
				{ paymentTime: '2026-02-01T00:00:00.000Z' as never, billingCurrency: 'USD' as never, billingAmount: 10, paymentCurrency: 'CNY' as never, paymentAmount: 75 },
			] as never;
			// cutoff after Feb → use Feb rate (7.5)
			expect(resolveRate('USD', 'CNY', { paymentRecords: records, date: new Date('2026-03-01T00:00:00.000Z') })).toBe(7.5);
			// cutoff between Jan and Feb → use Jan rate (7.2)
			expect(resolveRate('USD', 'CNY', { paymentRecords: records, date: new Date('2026-01-15T00:00:00.000Z') })).toBe(7.2);
		});
		it('config rate fallback', () => {
			expect(resolveRate('USD', 'CNY', { configRates: { 'USD/CNY': 7.0 } })).toBe(7.0);
		});
		it('no rate → null', () => {
			expect(resolveRate('USD', 'CNY')).toBe(null);
		});
	});

	describe('sumToCurrency', () => {
		it('mixed currencies with rate', () => {
			const ctx = { configRates: { 'USD/CNY': 7.0 } };
			const result = sumToCurrency({ USD: 10, CNY: 85 }, 'CNY', ctx);
			expect(result.total).toBeCloseTo(155, 5);
			expect(result.unconverted).toEqual([]);
		});
		it('unconverted currency collected', () => {
			const result = sumToCurrency({ USD: 10, EUR: 5 }, 'CNY');
			expect(result.total).toBe(0);
			expect(result.unconverted).toEqual(['USD', 'EUR']);
		});
	});
}
