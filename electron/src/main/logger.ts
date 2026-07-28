// electron/src/main/logger.ts
import log from 'electron-log';
import { resolveLogsDir } from './paths';

log.transports.file.resolvePathFn = () => `${resolveLogsDir()}/main.log`;
log.transports.file.maxSize = 5 * 1024 * 1024; // 5 MB
log.transports.console.level = process.env.NODE_ENV === 'production' ? 'info' : 'debug';
log.transports.file.level = 'info';

export const logger = log.scope('main');
export default logger;
