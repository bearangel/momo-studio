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

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
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

// Graceful shutdown on SIGTERM (sent by stopConduit). Close outstanding
// connections then exit 0 so the manager's exit handler resolves cleanly.
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
