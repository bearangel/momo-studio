// electron/tests/conduit/fake-binary.ts
// Spawned by manager.test.ts via `node --import tsx fake-binary.ts` as a stand-in
// for the real Conduit binary. It listens on 127.0.0.1 and responds to GET /health
// with HTTP 200, which is the contract the lifecycle manager polls.
//
// Port selection: the manager hardcodes port 8008 for v1 (matching real Conduit's
// default). The fake must bind the same port so the health check reaches it. We
// therefore default FAKE_CONDUIT_PORT to 8008 rather than 0 (random) so the test
// never needs to coordinate ports out-of-band. Override via env if a test wants
// a different port in the future.
import http from 'node:http';

const port = parseInt(process.env.FAKE_CONDUIT_PORT ?? '8008', 10);
const ignoreSigterm = process.env.FAKE_IGNORE_SIGTERM === '1';
// When set, /health holds the socket open forever (never responds). Used to
// exercise stopConduit's SIGKILL escalation and healthCheck's per-request
// timeout clamping: the client must abort via AbortSignal.timeout.
const noHealth = process.env.FAKE_NO_HEALTH === '1';

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    if (noHealth) {
      // Intentionally never call res.end(): the connection hangs until the
      // client aborts it. This is the "unhealthy / hung endpoint" shape.
      return;
    }
    res.writeHead(200).end('OK');
  } else {
    res.writeHead(404).end();
  }
});

server.on('error', (err) => {
  // EADDRINUSE etc. — fail loudly so the test sees a health-check timeout
  // rather than silently hanging.
  process.stderr.write(`fake-conduit: server error: ${err.message}\n`);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const actual = (server.address() as { port: number }).port;
  process.stdout.write(`READY:${actual}\n`);
});

if (ignoreSigterm) {
  // Swallow SIGTERM so only SIGKILL (which cannot be caught) can stop us.
  // Verifies stopConduit's force-kill escalation path.
  process.on('SIGTERM', () => {
    process.stdout.write('fake-conduit: ignoring SIGTERM\n');
  });
} else {
  // Graceful shutdown on SIGTERM (sent by stopConduit). Close outstanding
  // connections then exit 0 so the manager's exit handler resolves cleanly.
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
  });
}
