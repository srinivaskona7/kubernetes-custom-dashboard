
/**
 * The fleet API compresses what it sends to the browser.
 *
 * `k8s.js` has asked Kubernetes for `Accept-Encoding: gzip` for a long time, and that hop was
 * measured — 1.3 MB down to 487 kB, a third faster. The hop *out* of this API had no compression
 * at all, and nothing noticed because every measurement in this repo is taken over localhost,
 * where 417 kB and 40 kB both arrive in about two milliseconds. Over the internet to an approuter
 * they do not, and no amount of server-side caching changes the byte count.
 *
 * Four properties, one test each, because each one fails in its own silent way:
 *
 *  - **A large body is actually compressed** — measured in bytes on the socket, not by trusting
 *    the header. A response that sets `Content-Encoding: gzip` over an uncompressed body is a
 *    broken response, and asserting on the header alone would pass for it.
 *  - **A client that does not ask gets plain JSON.** Every verification recipe in this repo is
 *    `curl -s BASE_URL/api/RESOURCE | jq .`, and `curl` without `--compressed` sends
 *    `Accept-Encoding: identity` or nothing at all. If that path returned gzip, the documented
 *    way to check this API would print binary.
 *  - **`Vary: Accept-Encoding` is always set**, on the compressed and the plain answer alike.
 *    Without it a shared cache is entitled to serve the gzipped variant to a client that asked
 *    for identity, which fails on somebody else's machine and never on the developer's.
 *  - **A small body stays plain**, so an error, `/me` and a typed 404 remain readable with a
 *    plain `curl` and greppable in a proxy log.
 *
 * Requests here go through `node:http` rather than the harness's `get()`, because `fetch`
 * transparently decodes the body and reports the decoded length — exactly the measurement that
 * cannot distinguish a compressed response from an uncompressed one.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';

import _router_harness from './helpers/router-harness.js';
const { withRouter } = _router_harness;

/** A route whose fixture body is comfortably over the 1 kB threshold. */
const BIG = '/clusters/platformsbx/overview';
/** A route whose body is a few hundred bytes — the identity of the caller and nothing else. */
const SMALL = '/me';

/**
 * One request, reported by what actually crossed the socket.
 *
 * `wire` is the summed length of the raw chunks, so a `Content-Encoding` header over an
 * uncompressed body cannot pass as compression. `body` is decoded here, deliberately after
 * measuring, so a test can assert on both at once.
 */
function raw(url, headers) {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const encoding = res.headers['content-encoding'];
          let text;
          try {
            text = encoding === 'gzip' ? zlib.gunzipSync(buffer).toString('utf8') : buffer.toString('utf8');
          } catch (err) {
            return reject(new Error(`${url} claimed content-encoding=${encoding} over a body that is not gzip: ${err.message}`));
          }
          resolve({
            status: res.statusCode,
            encoding,
            vary: res.headers.vary,
            contentLength: res.headers['content-length'],
            wire: buffer.length,
            text,
            body: text ? JSON.parse(text) : null
          });
        });
      })
      .on('error', reject);
  });
}

test('a large response is gzipped for a client that asks, and the bytes prove it', async () => {
  await withRouter(async ({ baseUrl }) => {
    const gz = await raw(`${baseUrl}${BIG}`, { 'accept-encoding': 'gzip' });
    assert.equal(gz.status, 200);
    assert.equal(gz.encoding, 'gzip');

    // The decoded payload is what the browser ends up parsing; the socket carried far less.
    const plainBytes = Buffer.byteLength(gz.text);
    assert.ok(plainBytes > 1024, `the fixture overview is only ${plainBytes} bytes — pick a bigger route for this test`);
    assert.ok(
      gz.wire < plainBytes / 2,
      `content-encoding said gzip but ${gz.wire} bytes crossed the socket for a ${plainBytes}-byte body — that is not compression`
    );
    // A wrong Content-Length is worse than none: the client either truncates or hangs.
    assert.equal(gz.contentLength, String(gz.wire));
    // The compressed body still has to be the API's own answer, not a differently-shaped one.
    assert.ok(gz.body && gz.body.cluster && gz.body.data, 'the gzipped body is not the overview envelope');
  });
});

test('a client that does not ask for gzip gets plain JSON', async () => {
  await withRouter(async ({ baseUrl }) => {
    // `identity` and no header at all are both what a plain `curl` sends, and both must stay plain.
    for (const headers of [{ 'accept-encoding': 'identity' }, {}]) {
      const res = await raw(`${baseUrl}${BIG}`, headers);
      assert.equal(res.status, 200);
      assert.equal(res.encoding, undefined, `accept-encoding: ${headers['accept-encoding'] ?? '(absent)'} got a compressed body`);
      assert.ok(res.body && res.body.data, 'the plain body is not the overview envelope');
    }
  });
});

test('every response carries Vary: Accept-Encoding', async () => {
  await withRouter(async ({ baseUrl }) => {
    for (const headers of [{ 'accept-encoding': 'gzip' }, { 'accept-encoding': 'identity' }]) {
      const res = await raw(`${baseUrl}${BIG}`, headers);
      assert.match(
        res.vary || '',
        /accept-encoding/i,
        'a cache without this header may serve the gzipped variant to a client that asked for identity'
      );
    }
  });
});

test('a small response stays plain even when gzip is offered', async () => {
  await withRouter(async ({ baseUrl }) => {
    const res = await raw(`${baseUrl}${SMALL}`, { 'accept-encoding': 'gzip' });
    assert.equal(res.status, 200);
    assert.ok(Buffer.byteLength(res.text) < 1024, `/me is ${Buffer.byteLength(res.text)} bytes — the threshold this test relies on has moved`);
    assert.equal(res.encoding, undefined, 'framing a few hundred bytes costs more than it saves and makes the body unreadable in a log');
  });
});
