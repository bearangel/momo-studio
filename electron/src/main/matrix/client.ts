// electron/src/main/matrix/client.ts
import { MatrixClient, createClient } from 'matrix-js-sdk';
import { logger } from '../logger';

export interface CreateClientOptions {
  baseUrl: string;
  userId?: string;
  accessToken?: string;
  deviceId?: string;
}

export function createMatrixClient(opts: CreateClientOptions): MatrixClient {
  logger.debug('Creating Matrix client', { baseUrl: opts.baseUrl, userId: opts.userId });
  return createClient({
    baseUrl: opts.baseUrl,
    userId: opts.userId,
    accessToken: opts.accessToken,
    deviceId: opts.deviceId,
    useAuthorizationHeader: true,
  });
}

export { MatrixClient };
