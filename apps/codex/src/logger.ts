import { createLogger, log as internalLog } from '@zccusage/internal/logger';

import packageJson from '../package.json' with { type: 'json' };

const { name } = packageJson;

export const logger = createLogger(name);

export const log = internalLog;
