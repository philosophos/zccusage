import { defineConfig } from 'tsdown';
import Macros from 'unplugin-macros/rolldown';
import { copyPricingPlugin } from '../../scripts/copy-pricing-plugin.ts';

export default defineConfig({
	entry: [
		'./src/calculate-cost.ts',
		'./src/data-loader.ts',
		'./src/debug.ts',
		'./src/index.ts',
		'./src/logger.ts',
		'!./src/**/*.test.ts', // Exclude test files
		'!./src/_pricing-fetcher.ts', // Exclude problematic file
		'!./src/_*.ts', // Exclude other internal files with underscore prefix
	],
	outDir: 'dist',
	format: 'esm',
	// @duckdb/node-api ships native .node prebuilds that cannot be bundled —
	// keep it as a runtime require resolved from node_modules (it is listed
	// in package.json `dependencies` so npm installs it alongside dist).
	external: ['@duckdb/node-api'],
	clean: true,
	sourcemap: false,
	minify: 'dce-only',
	treeshake: true,
	dts: true,
	publint: true,
	unused: true,
	fixedExtension: false,
	exports: {
		devExports: true,
	},
	nodeProtocol: true,
	plugins: [
		Macros({
			include: ['src/index.ts', 'src/pricing-fetcher.ts'],
		}),
		copyPricingPlugin('zccusage'),
	],
	define: {
		'import.meta.vitest': 'undefined',
	},
});
