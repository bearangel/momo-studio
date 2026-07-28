// electron/src/main/conduit/binary-path.ts
import path from 'node:path';

type NodeProcessWithResources = NodeJS.Process & { resourcesPath?: string };
const proc = process as NodeProcessWithResources;

function perOsFilename(): string {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'win32') return 'conduit-windows-x64.exe';
  if (platform === 'darwin') return arch === 'arm64' ? 'conduit-darwin-arm64' : 'conduit-darwin-x64';
  if (platform === 'linux') return 'conduit-linux-x64';
  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

export function resolveConduitBinaryPath(): string {
  // From electron/src/main/conduit/, walk up to <root>/resources/conduit/<binary>
  // In production (packaged), this lives under process.resourcesPath.
  const filename = perOsFilename();
  if (proc.env.NODE_ENV === 'production' && proc.resourcesPath) {
    return path.join(proc.resourcesPath, 'conduit', filename);
  }
  // Dev mode: walk up from this compiled file to repo root.
  // electron/dist/main/conduit/binary-path.js → ../../../resources/conduit/
  return path.resolve(__dirname, '..', '..', '..', '..', 'resources', 'conduit', filename);
}