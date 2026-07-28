// resources/conduit/download.ts
// Runs on `pnpm postinstall` at root.
// Downloads pre-built Conduit binary for current OS/arch into ./resources/conduit/
// Errors are logged but do NOT fail the install (dev may be offline).

import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const CONDUIT_VERSION = 'v0.9.0'; // TODO: pin to specific Conduit release tag
const BASE_URL = `https://github.com/girlbossceo/conduit/releases/download/${CONDUIT_VERSION}`;

interface PlatformTarget {
  platform: string;
  arch: string;
  filename: string;
}

function detectTarget(): PlatformTarget {
  const platform = process.platform;
  const arch = process.arch;
  const map: Record<string, Record<string, PlatformTarget>> = {
    darwin: {
      arm64: { platform: 'darwin', arch: 'arm64', filename: 'conduit-darwin-arm64' },
      x64: { platform: 'darwin', arch: 'x64', filename: 'conduit-darwin-x64' },
    },
    linux: {
      x64: { platform: 'linux', arch: 'x64', filename: 'conduit-linux-x64' },
    },
    win32: {
      x64: { platform: 'windows', arch: 'x64', filename: 'conduit-windows-x64.exe' },
    },
  };
  const target = map[platform]?.[arch];
  if (!target) {
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }
  return target;
}

async function download(target: PlatformTarget): Promise<void> {
  const outDir = __dirname;
  const outPath = path.join(outDir, target.filename);
  if (fs.existsSync(outPath)) {
    console.log(`[conduit] ${target.filename} already exists, skipping download`);
    return;
  }
  const url = `${BASE_URL}/${target.filename}`;
  console.log(`[conduit] Downloading ${url}`);
  try {
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }
    await pipeline(
      response.body as unknown as NodeJS.ReadableStream,
      fs.createWriteStream(outPath),
    );
    if (process.platform !== 'win32') {
      fs.chmodSync(outPath, 0o755);
    }
    console.log(`[conduit] Saved to ${outPath}`);
  } catch (err) {
    console.warn(`[conduit] Download failed: ${(err as Error).message}`);
    console.warn(
      '[conduit] You may need to manually place the binary. See docs/dev/conduit-manual.md for instructions.',
    );
  }
}

if (require.main === module) {
  // IIFE: detectTarget() may throw synchronously on unsupported platforms,
  // which would escape .catch(); wrap to keep install non-fatal.
  (async () => {
    try {
      await download(detectTarget());
    } catch (err) {
      console.error('[conduit] Fatal:', err);
      process.exit(0);
    }
  })();
}