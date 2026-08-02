const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('node:http');
const path = require('node:path');

const { app } = require('../server');

test('serves the app shell from the root route', async () => {
  const server = createServer(app);
  server.listen(0);
  await once(server, 'listening');

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Bloom Notes/);
  } finally {
    server.close();
    await once(server, 'close').catch(() => {});
  }
});
