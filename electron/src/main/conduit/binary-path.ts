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

/**
 * Detect whether we are running inside a *packaged* Electron app. We cannot use
 * electron's `app.isPackaged` here (importing electron would pull the renderer
 * module graph into a Node-only test context and break unit tests), so we infer
 * it from the two markers Electron itself injects into the process object:
 * `process.versions.electron` is present in any Electron runtime, and
 * `process.resourcesPath` is set only for an asar/unpacked packaged build.
 */
function isPackaged(): boolean {
  return typeof process.versions.electron === 'string' && !!proc.resourcesPath;
}

export function resolveConduitBinaryPath(): string {
  const filename = perOsFilename();
  if (isPackaged() && proc.resourcesPath) {
    return path.join(proc.resourcesPath, 'conduit', filename);
  }
  // Dev mode: walk up from this compiled file to repo root.
  // electron/dist/main/conduit/binary-path.js → ../../../resources/conduit/
  return path.resolve(__dirname, '..', '..', '..', '..', 'resources', 'conduit', filename);
}