// resources/conduit/download.ts
// Runs on `pnpm postinstall` at root.
// Downloads pre-built Tuwunel binary (Conduwuit official successor) for Linux.
// macOS/Windows: CI compiles from source, postinstall skips.
// Errors are logged but do NOT fail the install.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const TUWUNEL_VERSION = 'v1.8.2';
const BASE_URL = `https://github.com/matrix-construct/tuwunel/releases/download/${TUWUNEL_VERSION}`;

interface PlatformTarget {
  platform: string;
  arch: string;
  urlFilename: string;
  outputFilename: string;
}

function detectTarget(): PlatformTarget {
  const platform = process.platform;
  const arch = process.arch;
  const map: Record<string, Record<string, PlatformTarget>> = {
    linux: {
      arm64: {
        platform: 'linux', arch: 'arm64',
        urlFilename: `${TUWUNEL_VERSION}-release-all-aarch64-v8-linux-gnu-tuwunel.zst`,
        outputFilename: 'tuwunel-linux-arm64',
      },
      x64: {
        platform: 'linux', arch: 'x64',
        urlFilename: `${TUWUNEL_VERSION}-release-all-x86_64-v1-linux-gnu-tuwunel.zst`,
        outputFilename: 'tuwunel-linux-x64',
      },
    },
  };
  const target = map[platform]?.[arch];
  if (!target) {
    return { platform, arch, urlFilename: '', outputFilename: `UNSUPPORTED-${platform}-${arch}` };
  }
  return target;
}

async function download(target: PlatformTarget): Promise<void> {
  if (target.urlFilename === '') {
    console.warn(`[tuwunel] No pre-built binary for ${target.platform}/${target.arch}.`);
    console.warn('[tuwunel] CI will compile from source.');
    return;
  }

  const outDir = __dirname;
  const outPath = path.join(outDir, target.outputFilename);
  if (fs.existsSync(outPath)) {
    console.log(`[tuwunel] ${target.outputFilename} already exists, skipping download`);
    return;
  }

  const url = `${BASE_URL}/${target.urlFilename}`;
  console.log(`[tuwunel] Downloading ${url}`);
  try {
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }
    const archivePath = path.join(outDir, target.urlFilename);
    await pipeline(
      response.body as unknown as NodeJS.ReadableStream,
      fs.createWriteStream(archivePath),
    );

    try {
      execSync(`zstd -d -f "${archivePath}" -o "${outPath}"`, { stdio: 'pipe' });
    } catch {
      execSync(`python3 -c "
import zstandard
with open('${archivePath}', 'rb') as f:
    data = zstandard.ZstdDecompressor().decompress(f.read())
with open('${outPath}', 'wb') as f:
    f.write(data)
"`, { stdio: 'pipe' });
    }
    fs.unlinkSync(archivePath);
    fs.chmodSync(outPath, 0o755);
    console.log(`[tuwunel] Saved to ${outPath}`);
  } catch (err) {
    console.warn(`[tuwunel] Download failed: ${(err as Error).message}`);
    console.warn('[tuwunel] CI will compile from source instead.');
  }
}

if (require.main === module) {
  (async () => {
    try {
      await download(detectTarget());
    } catch (err) {
      console.error('[tuwunel] Fatal:', err);
      process.exit(0);
    }
  })();
}
