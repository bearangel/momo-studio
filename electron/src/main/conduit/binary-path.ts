// electron/src/main/conduit/binary-path.ts
import path from 'node:path';

type NodeProcessWithResources = NodeJS.Process & { resourcesPath?: string };
const proc = process as NodeProcessWithResources;

function perOsFilename(): string {
  const platform = process.platform;
  const arch = process.arch;
  // Conduwuit (formerly Conduit) ships Linux static binaries only.
  // macOS/Windows: no native binary — must run Conduwuit via Docker.
  if (platform === 'linux') {
    if (arch === 'arm64') return 'static-aarch64-unknown-linux-musl';
    if (arch === 'x64') return 'static-x86_64-unknown-linux-musl';
  }
  throw new Error(
    `No Conduwuit binary for ${platform}-${arch}. ` +
      'On macOS/Windows, run Conduwuit via Docker and connect to it externally.',
  );
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