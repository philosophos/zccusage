import type { UsageReportConfig } from '@better-ccusage/terminal/table';
import process from 'node:process';
import { addEmptySeparatorRow, createUsageReportTable, formatTotalsRow, formatUsageDataRow, pushBreakdownRows } from '@better-ccusage/terminal/table';
import { Result } from '@praha/byethrow';
import { define } from 'gunshi';
import { loadConfig, mergeConfigWithArgs } from '../_config-loader-tokens.ts';
import { WEEK_DAYS } from '../_consts.ts';
import { formatDateCompact } from '../_date-utils.ts';
import { queryWeeklyUsage } from '../_duckdb-query.ts';
import { processWithJq } from '../_jq-processor.ts';
import { buildPlanOverrides, loadProviderProfiles, loadProviderSchedule } from '../_provider-profile-loader.ts';
import { resolveFormat, sharedArgs } from '../_shared-args.ts';
import { attachProfileFields, buildTree, detectTreeSeparator, parseGroup, renderTree, renderTreeTable } from '../_tree-renderer.ts';
import {
	calculateTotals,
	createTotalsObject,
	getTotalTokens,
} from '../calculate-cost.ts';
import { computeStatsProjection, loadWeeklyUsageData } from '../data-loader.ts';
import { detectMismatches, printMismatchReport } from '../debug.ts';
import { log, logger } from '../logger.ts';

export const weeklyCommand = define({
	name: 'weekly',
	description: 'Show usage report grouped by week',
	args: {
		...sharedArgs,
		startOfWeek: {
			type: 'enum',
			short: 'w',
			description: 'Day to start the week on',
			default: 'sunday' as const,
			choices: WEEK_DAYS,
		},
	},
	toKebab: true,
	async run(ctx) {
		// Load configuration and merge with CLI arguments
		const config = loadConfig(ctx.values.config, ctx.values.debug);
		const mergedOptions = mergeConfigWithArgs(ctx, config, ctx.values.debug);

		// --jq implies --json
		const useJson = Boolean(mergedOptions.json) || mergedOptions.jq != null;
		if (useJson) {
			logger.level = 0;
		}

		const weeklyData = mergedOptions.noDuckdb === true
			? await loadWeeklyUsageData(mergedOptions)
			: await queryWeeklyUsage(mergedOptions);

		if (weeklyData.length === 0) {
			if (useJson) {
				const emptyOutput = {
					weekly: [],
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
		const totals = calculateTotals(weeklyData);

		// Show debug information if requested
		if (mergedOptions.debug && !useJson) {
			const mismatchStats = await detectMismatches(undefined);
			printMismatchReport(mismatchStats, mergedOptions.debugSamples as number | undefined);
		}

		// Tree / tree-table output format (alongside table/json)
		const format = resolveFormat(mergedOptions);
		if (format === 'tree' || format === 'tree-table') {
			logger.level = 0;
			const items = weeklyData.map(d => ({
				time: d.week,
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
			const treeDims = parseGroup(mergedOptions.group ?? mergedOptions.treeGroup, 'weekly').dims;
			attachProfileFields(items, await loadProviderProfiles({ ccSwitchDbPath: mergedOptions.ccSwitchDbPath, allAppTypes: treeDims.includes('agent') }), buildPlanOverrides(loadProviderSchedule()));
			const nodes = buildTree(items, treeDims);
			const renderOpts = {
				statsCurrency: mergedOptions.statsCurrency,
				paymentsPath: mergedOptions.paymentsPath,
				rate: mergedOptions.rate,
				locale: mergedOptions.locale,
				separator: detectTreeSeparator(),
				wrap: mergedOptions.wrap ?? mergedOptions.treeWrap,
				title: 'Weekly',
			};
			log(format === 'tree-table' ? renderTreeTable(nodes, renderOpts) : renderTree(nodes, renderOpts));
			return;
		}

		if (useJson) {
			// Output JSON format
			const jsonOutput = {
				weekly: weeklyData.map(data => ({
					week: data.week,
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
			logger.box('Claude Code Token Usage Report - Weekly');

			// Create table with compact mode support
			const tableConfig: UsageReportConfig = {
				firstColumnName: 'Week',
				dateFormatter: (dateStr: string) => formatDateCompact(dateStr, mergedOptions.timezone, mergedOptions.locale ?? undefined),
				forceCompact: ctx.values.compact,
				statsCurrency: mergedOptions.statsCurrency,
			};
			const table = createUsageReportTable(tableConfig);
			const statsFor = (d: { costByCurrency?: Record<string, number>; totalCost: number }): ReturnType<typeof computeStatsProjection> => computeStatsProjection(d, mergedOptions);

			// Add weekly data
			for (const data of weeklyData) {
				// Main row
				const row = formatUsageDataRow(data.week, {
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
				...statsFor(totals),
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
