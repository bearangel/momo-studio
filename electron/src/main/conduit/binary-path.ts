// electron/src/main/conduit/binary-path.ts
import path from 'node:path';

type NodeProcessWithResources = NodeJS.Process & { resourcesPath?: string };
const proc = process as NodeProcessWithResources;

function perOsFilename(): string {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'linux') {
    if (arch === 'arm64') return 'static-aarch64-unknown-linux-musl';
    if (arch === 'x64') return 'static-x86_64-unknown-linux-musl';
  }
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'conduwuit-darwin-arm64' : 'conduwuit-darwin-x64';
  }
  if (platform === 'win32') {
    return 'conduwuit-windows-x64.exe';
  }
  throw new Error(`No Conduwuit binary for ${platform}-${arch}.`);
}

/**
 * Detect whether we are running inside a *packaged* Electron app. We cannot use
 * electron's `app.isPackaged` here (importing electron would pull the renderer
 * module graph into a Node-only test context and break unit tests), so we infer
 * it from the markers Electron itself injects into the process object:
 *
 *   - `process.defaultApp` is `true` under `electron .` (dev mode) and
 *     unset/false in a packaged build — this is the canonical "dev vs packaged"
 *     signal. Without it, a dev run that happens to set resourcesPath (e.g.
 *     inside a DevContainer) would be misdetected as packaged and the binary
 *     path would resolve to a non-existent resources/conduit location.
 *   - `process.versions.electron` is present in any Electron runtime.
 *   - `process.resourcesPath` is set only for an asar/unpacked packaged build.
 *
 * All three must line up: NOT defaultApp, AND electron present, AND resourcesPath set.
 */
function isPackaged(): boolean {
  return (
    !process.defaultApp &&
    !!proc.resourcesPath &&
    typeof process.versions.electron === 'string'
  );
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