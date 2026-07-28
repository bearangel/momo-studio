// electron/tests/conduit/config.test.ts
import { describe, it, expect } from 'vitest';
import { generateConduitConfig } from '../../src/main/conduit/config';

describe('conduit/config', () => {
  it('generateConduitConfig produces valid TOML with the given values', () => {
    const toml = generateConduitConfig({
      port: 8008,
      serverName: 'localhost',
      dataDir: '/tmp/conduit-data',
    });
    expect(toml).toContain('[global]');
    expect(toml).toContain('server_name = "localhost"');
    expect(toml).toContain('port = 8008');
    expect(toml).toContain('database_path = "/tmp/conduit-data"');
    expect(toml).toContain('allow_registration = true');
  });
});