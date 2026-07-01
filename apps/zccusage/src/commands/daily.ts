import type { UsageReportConfig } from '@better-ccusage/terminal/table';
import process from 'node:process';
import { addEmptySeparatorRow, createUsageReportTable, formatTotalsRow, formatUsageDataRow, pushBreakdownRows } from '@better-ccusage/terminal/table';
import { Result } from '@praha/byethrow';
import { define } from 'gunshi';
import pc from 'picocolors';
import { loadConfig, mergeConfigWithArgs } from '../_config-loader-tokens.ts';
import { groupByProject, groupDataByProject } from '../_daily-grouping.ts';
import { formatDateCompact } from '../_date-utils.ts';
import { queryDailyUsage } from '../_duckdb-query.ts';
import { processWithJq } from '../_jq-processor.ts';
import { formatProjectName } from '../_project-names.ts';
import { buildPlanOverrides, loadProviderProfiles, loadProviderSchedule } from '../_provider-profile-loader.ts';
import { resolveFormat, sharedCommandConfig } from '../_shared-args.ts';
import { attachProfileFields, buildTree, detectTreeSeparator, parseGroup, renderTree, renderTreeTable } from '../_tree-renderer.ts';
import {
	calculateTotals,
	createTotalsObject,
	getTotalTokens,
} from '../calculate-cost.ts';
import { computeStatsProjection, loadDailyUsageData } from '../data-loader.ts';
import { detectMismatches, printMismatchReport } from '../debug.ts';
import { log, logger } from '../logger.ts';

export const dailyCommand = define({
	name: 'daily',
	description: 'Show usage report grouped by date',
	...sharedCommandConfig,
	args: {
		...sharedCommandConfig.args,
		instances: {
			type: 'boolean',
			short: 'i',
			description: 'Show usage breakdown by project/instance',
			default: false,
		},
		project: {
			type: 'string',
			short: 'p',
			description: 'Filter to specific project name',
		},
		projectAliases: {
			type: 'string',
			description: 'Comma-separated project aliases (e.g., \'better-ccusage=Usage Tracker,myproject=My Project\')',
			hidden: true,
		},
	},
	async run(ctx) {
		// Load configuration and merge with CLI arguments
		const config = loadConfig(ctx.values.config, ctx.values.debug);
		const mergedOptions = mergeConfigWithArgs(ctx, config, ctx.values.debug);

		// Convert projectAliases to Map if it exists
		// Parse comma-separated key=value pairs
		let projectAliases: Map<string, string> | undefined;
		if (mergedOptions.projectAliases != null && typeof mergedOptions.projectAliases === 'string') {
			projectAliases = new Map();
			const pairs = mergedOptions.projectAliases.split(',').map(pair => pair.trim()).filter(pair => pair !== '');
			for (const pair of pairs) {
				const parts = pair.split('=').map(s => s.trim());
				const rawName = parts[0];
				const alias = parts[1];
				if (rawName != null && alias != null && rawName !== '' && alias !== '') {
					projectAliases.set(rawName, alias);
				}
			}
		}

		// --jq implies --json
		const useJson = Boolean(mergedOptions.json) || mergedOptions.jq != null;
		if (useJson) {
			logger.level = 0;
		}

		const dailyData = mergedOptions.noDuckdb === true
			? await loadDailyUsageData({
					...mergedOptions,
					groupByProject: mergedOptions.instances,
				})
			: await queryDailyUsage({
					...mergedOptions,
					groupByProject: mergedOptions.instances,
				});

		if (dailyData.length === 0) {
			if (useJson) {
				log(JSON.stringify([]));
			}
			else {
				logger.warn('No Claude usage data found.');
			}
			process.exit(0);
		}

		// Calculate totals
		const totals = calculateTotals(dailyData);

		// Show debug information if requested
		if (mergedOptions.debug && !useJson) {
			const mismatchStats = await detectMismatches(undefined);
			printMismatchReport(mismatchStats, mergedOptions.debugSamples as number | undefined);
		}

		// Tree / tree-table output format (alongside table/json)
		const format = resolveFormat(mergedOptions);
		if (format === 'tree' || format === 'tree-table') {
			logger.level = 0;
			const items = dailyData.map(d => ({
				time: d.date,
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
			const treeDims = parseGroup(mergedOptions.group ?? mergedOptions.treeGroup, 'daily').dims;
			attachProfileFields(items, await loadProviderProfiles({ ccSwitchDbPath: mergedOptions.ccSwitchDbPath, allAppTypes: treeDims.includes('agent') }), buildPlanOverrides(loadProviderSchedule()));
			const nodes = buildTree(items, treeDims);
			const renderOpts = {
				statsCurrency: mergedOptions.statsCurrency,
				paymentsPath: mergedOptions.paymentsPath,
				rate: mergedOptions.rate,
				locale: mergedOptions.locale,
				separator: detectTreeSeparator(),
				wrap: mergedOptions.wrap ?? mergedOptions.treeWrap,
				title: 'Daily',
			};
			log(format === 'tree-table' ? renderTreeTable(nodes, renderOpts) : renderTree(nodes, renderOpts));
			return;
		}

		if (useJson) {
			// Output JSON format - group by project if instances flag is used
			const jsonOutput = Boolean(mergedOptions.instances) && dailyData.some(d => d.project != null)
				? {
						projects: groupByProject(dailyData),
						totals: { ...createTotalsObject(totals), ...computeStatsProjection(totals, mergedOptions) },
					}
				: {
						daily: dailyData.map(data => ({
							date: data.date,
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
							...(data.project !== null ? { project: data.project } : {}),
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
			logger.box('Claude Code Token Usage Report - Daily');

			// Create table with compact mode support
			const tableConfig: UsageReportConfig = {
				firstColumnName: 'Date',
				dateFormatter: (dateStr: string) => formatDateCompact(dateStr, mergedOptions.timezone, mergedOptions.locale ?? undefined),
				forceCompact: ctx.values.compact,
				statsCurrency: mergedOptions.statsCurrency,
			};
			const table = createUsageReportTable(tableConfig);
			// Per-row statistics-currency projection (no-op when statsCurrency is unset/USD)
			const statsFor = (d: { costByCurrency?: Record<string, number>; totalCost: number }): ReturnType<typeof computeStatsProjection> => computeStatsProjection(d, mergedOptions);

			// Add daily data - group by project if instances flag is used
			if (Boolean(mergedOptions.instances) && dailyData.some(d => d.project != null)) {
				// Group data by project for visual separation
				const projectGroups = groupDataByProject(dailyData);

				let isFirstProject = true;
				for (const [projectName, projectData] of Object.entries(projectGroups)) {
					// Add project section header
					if (!isFirstProject) {
						// Add empty row for visual separation between projects
						table.push(['', '', '', '', '', '', '', '']);
					}

					// Add project header row
					table.push([
						pc.cyan(`Project: ${formatProjectName(projectName, projectAliases)}`),
						'',
						'',
						'',
						'',
						'',
						'',
						'',
					]);

					// Add data rows for this project
					for (const data of projectData) {
						const hasMultipleModels = (data.modelsUsed?.length ?? 0) > 1;

						const row = formatUsageDataRow(data.date, {
							inputTokens: data.inputTokens,
							outputTokens: data.outputTokens,
							cacheCreationTokens: data.cacheCreationTokens,
							cacheReadTokens: data.cacheReadTokens,
							totalCost: data.totalCost,
							...statsFor(data),
							modelsUsed: data.modelsUsed,
							source: data.source,
						});
						table.push(row);

						if (hasMultipleModels || mergedOptions.breakdown) {
							pushBreakdownRows(table, data.modelBreakdowns, 2, 0);
						}
					}

					isFirstProject = false;
				}
			}
			else {
				// Standard display without project grouping
				for (const data of dailyData) {
					const hasMultipleModels = (data.modelsUsed?.length ?? 0) > 1;

					const row = formatUsageDataRow(data.date, {
						inputTokens: data.inputTokens,
						outputTokens: data.outputTokens,
						cacheCreationTokens: data.cacheCreationTokens,
						cacheReadTokens: data.cacheReadTokens,
						totalCost: data.totalCost,
						...statsFor(data),
						modelsUsed: data.modelsUsed,
						source: data.source,
					});
					table.push(row);

					if (hasMultipleModels || mergedOptions.breakdown) {
						pushBreakdownRows(table, data.modelBreakdowns, 2, 0);
					}
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
