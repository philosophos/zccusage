import type { UsageReportConfig } from '@better-ccusage/terminal/table';
import process from 'node:process';
import { addEmptySeparatorRow, createUsageReportTable, formatTotalsRow, formatUsageDataRow, pushBreakdownRows } from '@better-ccusage/terminal/table';
import { Result } from '@praha/byethrow';
import { define } from 'gunshi';
import { loadConfig, mergeConfigWithArgs } from '../_config-loader-tokens.ts';
import { DEFAULT_LOCALE } from '../_consts.ts';
import { formatDateCompact } from '../_date-utils.ts';
import { processWithJq } from '../_jq-processor.ts';
import { resolveFormat, sharedCommandConfig } from '../_shared-args.ts';
import { buildTree, parseTreeGroup, renderTree } from '../_tree-renderer.ts';
import {
	calculateTotals,
	createTotalsObject,
	getTotalTokens,
} from '../calculate-cost.ts';
import { computeStatsProjection, loadMonthlyUsageData } from '../data-loader.ts';
import { detectMismatches, printMismatchReport } from '../debug.ts';
import { log, logger } from '../logger.ts';

export const monthlyCommand = define({
	name: 'monthly',
	description: 'Show usage report grouped by month',
	...sharedCommandConfig,
	async run(ctx) {
		// Load configuration and merge with CLI arguments
		const config = loadConfig(ctx.values.config, ctx.values.debug);
		const mergedOptions = mergeConfigWithArgs(ctx, config, ctx.values.debug);

		// --jq implies --json
		const useJson = Boolean(mergedOptions.json) || mergedOptions.jq != null;
		if (useJson) {
			logger.level = 0;
		}

		const monthlyData = await loadMonthlyUsageData(mergedOptions);

		if (monthlyData.length === 0) {
			if (useJson) {
				const emptyOutput = {
					monthly: [],
					totals: {
						inputTokens: 0,
						outputTokens: 0,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						totalTokens: 0,
						totalCost: 0,
					},
				};
				log(JSON.stringify(emptyOutput, null, 2));
			}
			else {
				logger.warn('No Claude usage data found.');
			}
			process.exit(0);
		}

		// Calculate totals
		const totals = calculateTotals(monthlyData);

		// Show debug information if requested
		if (mergedOptions.debug && !useJson) {
			const mismatchStats = await detectMismatches(undefined);
			printMismatchReport(mismatchStats, mergedOptions.debugSamples as number | undefined);
		}

		// Tree output format (third format alongside table/json)
		const format = resolveFormat(mergedOptions);
		if (format === 'tree') {
			logger.level = 0;
			const items = monthlyData.map(d => ({
				time: d.month,
				project: d.project,
				providerId: d.providerId,
				inputTokens: d.inputTokens,
				outputTokens: d.outputTokens,
				cacheCreationTokens: d.cacheCreationTokens,
				cacheReadTokens: d.cacheReadTokens,
				totalTokens: getTotalTokens(d),
				totalCost: d.totalCost,
				costByCurrency: d.costByCurrency,
				modelBreakdowns: d.modelBreakdowns,
			}));
			const nodes = buildTree(items, parseTreeGroup(mergedOptions.treeGroup, 'monthly', Boolean(mergedOptions.instances)));
			log(renderTree(nodes, {
				statsCurrency: mergedOptions.statsCurrency,
				paymentsPath: mergedOptions.paymentsPath,
				rate: mergedOptions.rate,
				locale: mergedOptions.locale,
				title: 'Monthly',
			}));
			return;
		}

		if (useJson) {
			// Output JSON format
			const jsonOutput = {
				monthly: monthlyData.map(data => ({
					month: data.month,
					source: data.source,
					inputTokens: data.inputTokens,
					outputTokens: data.outputTokens,
					cacheCreationTokens: data.cacheCreationTokens,
					cacheReadTokens: data.cacheReadTokens,
					totalTokens: getTotalTokens(data),
					totalCost: data.totalCost,
					costByCurrency: data.costByCurrency ?? { USD: data.totalCost },
					...(data.providerId != null ? { providerId: data.providerId } : {}),
					modelsUsed: data.modelsUsed,
					modelBreakdowns: data.modelBreakdowns,
				})),
				totals: { ...createTotalsObject(totals), ...computeStatsProjection(totals, mergedOptions) },
			};

			// Process with jq if specified
			if (mergedOptions.jq != null) {
				const jqResult = await processWithJq(jsonOutput, mergedOptions.jq);
				if (Result.isFailure(jqResult)) {
					logger.error((jqResult.error).message);
					process.exit(1);
				}
				log(jqResult.value);
			}
			else {
				log(JSON.stringify(jsonOutput, null, 2));
			}
		}
		else {
			// Print header
			logger.box('Claude Code Token Usage Report - Monthly');

			// Create table with compact mode support
			const tableConfig: UsageReportConfig = {
				firstColumnName: 'Month',
				dateFormatter: (dateStr: string) => formatDateCompact(dateStr, mergedOptions.timezone, mergedOptions.locale ?? DEFAULT_LOCALE),
				forceCompact: ctx.values.compact,
				statsCurrency: mergedOptions.statsCurrency,
			};
			const table = createUsageReportTable(tableConfig);
			const statsFor = (d: { costByCurrency?: Record<string, number>; totalCost: number }): ReturnType<typeof computeStatsProjection> => computeStatsProjection(d, mergedOptions);

			// Add monthly data
			for (const data of monthlyData) {
			// Main row
				const row = formatUsageDataRow(data.month, {
					source: data.source,
					inputTokens: data.inputTokens,
					outputTokens: data.outputTokens,
					cacheCreationTokens: data.cacheCreationTokens,
					cacheReadTokens: data.cacheReadTokens,
					totalCost: data.totalCost,
					...statsFor(data),
					modelsUsed: data.modelsUsed,
				});
				table.push(row);

				// Add model breakdown rows if flag is set
				if (mergedOptions.breakdown) {
					pushBreakdownRows(table, data.modelBreakdowns, 2, 0);
				}
			}

			// Add empty row for visual separation before totals
			addEmptySeparatorRow(table, 8);

			// Add totals
			const totalsRow = formatTotalsRow({
				inputTokens: totals.inputTokens,
				outputTokens: totals.outputTokens,
				cacheCreationTokens: totals.cacheCreationTokens,
				cacheReadTokens: totals.cacheReadTokens,
				totalCost: totals.totalCost,
				...computeStatsProjection(totals, mergedOptions),
			});
			table.push(totalsRow);

			log(table.toString());

			// Show guidance message if in compact mode
			if (table.isCompactMode()) {
				logger.info('\nRunning in Compact Mode');
				logger.info('Expand terminal width to see cache metrics and total tokens');
			}
		}
	},
});
