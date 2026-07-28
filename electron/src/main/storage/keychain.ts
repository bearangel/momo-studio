// electron/src/main/storage/keychain.ts
import type * as Keytar from 'keytar';
import { logger } from '../logger';

const SERVICE_NAME = 'Momo Studio';

export interface KeychainImpl {
  setSecret(key: string, value: string): Promise<void>;
  getSecret(key: string): Promise<string | null>;
  deleteSecret(key: string): Promise<void>;
}

class ProductionKeychainImpl implements KeychainImpl {
  // Lazy-loaded: keytar's native binding (libsecret on Linux, Keychain on macOS,
  // CredMan on Windows) may be absent in CI. Defer the require until first use so
  // the module can be imported and the mock-injection hook can be exercised in tests.
  private loadKeytar(): typeof Keytar {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('keytar') as typeof Keytar;
  }

  async setSecret(key: string, value: string): Promise<void> {
    await this.loadKeytar().setPassword(SERVICE_NAME, key, value);
  }
  async getSecret(key: string): Promise<string | null> {
    return await this.loadKeytar().getPassword(SERVICE_NAME, key);
  }
  async deleteSecret(key: string): Promise<void> {
    await this.loadKeytar().deletePassword(SERVICE_NAME, key);
  }
}

let impl: KeychainImpl = new ProductionKeychainImpl();

export function setKeychainImpl(newImpl: KeychainImpl): void {
  impl = newImpl;
}

export async function setSecret(key: string, value: string): Promise<void> {
  logger.debug('setSecret', { key });
  await impl.setSecret(key, value);
}

export async function getSecret(key: string): Promise<string | null> {
  return await impl.getSecret(key);
}

export async function deleteSecret(key: string): Promise<void> {
  logger.debug('deleteSecret', { key });
  await impl.deleteSecret(key);
}
