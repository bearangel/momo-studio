// resources/conduit/download.ts
// Runs on `pnpm postinstall` at root.
// Downloads pre-built Conduwuit (formerly Conduit) binary for current OS/arch.
// NOTE: Conduwuit only ships Linux static binaries. macOS/Windows users must
// run Conduwuit via Docker (see docs/dev/conduwuit-docker.md).
// Errors are logged but do NOT fail the install (dev may be offline).

import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const CONDUWUIT_VERSION = 'v0.4.6';
const BASE_URL = `https://github.com/girlbossceo/conduwuit/releases/download/${CONDUWUIT_VERSION}`;

interface PlatformTarget {
  platform: string;
  arch: string;
  filename: string;
}

function detectTarget(): PlatformTarget {
  const platform = process.platform;
  const arch = process.arch;
  // Conduwuit only ships Linux static binaries.
  // On macOS/Windows, return a sentinel that download() will skip with guidance.
  const map: Record<string, Record<string, PlatformTarget>> = {
    linux: {
      arm64: {
        platform: 'linux',
        arch: 'arm64',
        filename: 'static-aarch64-unknown-linux-musl',
      },
      x64: {
        platform: 'linux',
        arch: 'x64',
        filename: 'static-x86_64-unknown-linux-musl',
      },
    },
  };
  const target = map[platform]?.[arch];
  if (!target) {
    return {
      platform,
      arch,
      filename: `UNSUPPORTED-${platform}-${arch}`,
    };
  }
  return target;
}

async function download(target: PlatformTarget): Promise<void> {
  if (target.filename.startsWith('UNSUPPORTED-')) {
    console.warn(
      `[conduwuit] No pre-built binary for ${target.platform}/${target.arch}.`,
    );
    console.warn(
      '[conduwuit] Conduwuit only ships Linux binaries. On macOS/Windows, run Conduwuit via Docker:',
    );
    console.warn('  docker run -d --name conduwuit -p 8008:8008 \\');
    console.warn(
      '    -v ~/.agent-platform/conduwuit-data:/data \\',
    );
    console.warn(
      '    ghcr.io/girlbossceo/conduwuit:latest',
    );
    console.warn(
      '[conduwuit] Then configure the app to connect to your Docker-hosted Conduwuit.',
    );
    return;
  }

  const outDir = __dirname;
  const outPath = path.join(outDir, target.filename);
  if (fs.existsSync(outPath)) {
    console.log(`[conduwuit] ${target.filename} already exists, skipping download`);
    return;
  }
  const url = `${BASE_URL}/${target.filename}`;
  console.log(`[conduwuit] Downloading ${url}`);
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
    console.log(`[conduwuit] Saved to ${outPath}`);
  } catch (err) {
    console.warn(`[conduwuit] Download failed: ${(err as Error).message}`);
    console.warn(
      '[conduwuit] You may need to manually place the binary. See docs/dev/conduwuit-docker.md for Docker alternative.',
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
      console.error('[conduwuit] Fatal:', err);
      process.exit(0);
    }
  })();
}
