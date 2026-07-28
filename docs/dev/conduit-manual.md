# Manual Conduit binary placement

If `pnpm postinstall` failed to download Conduit (offline, firewall, etc.), you can place the binary manually.

## 1. Identify your target

| Platform | Filename |
|---|---|
| macOS arm64 | `conduit-darwin-arm64` |
| macOS x64 | `conduit-darwin-x64` |
| Linux x64 | `conduit-linux-x64` |
| Windows x64 | `conduit-windows-x64.exe` |

## 2. Download from GitHub releases

<https://github.com/girlbossceo/conduit/releases>

Pick the version pinned in `resources/conduit/download.ts` (`CONDUIT_VERSION`). Using a different version may break the IPC contract the Electron app expects.

## 3. Place the binary

```bash
mv ~/Downloads/conduit-darwin-arm64 /workspace/resources/conduit/
chmod +x /workspace/resources/conduit/conduit-darwin-arm64   # macOS/Linux only
```

On macOS, the first launch will be blocked by Gatekeeper (unsigned binary). Right-click → Open the first time, or run `xattr -d com.apple.quarantine /workspace/resources/conduit/conduit-darwin-arm64`.

## 4. Verify

```bash
/workspace/resources/conduit/conduit-darwin-arm64 --version
```

Should print Conduit's version.

## 5. Re-run dev

```bash
pnpm dev
```

The Electron app detects the binary and starts Conduit as a child process. Watch `~/.agent-platform/logs/main.log` for the startup line.