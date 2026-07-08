const test = require('node:test');
const assert = require('node:assert');

const spec = require('../openapi.json');

// Every route the router exposes — update together with router/router.js.
const EXPECTED = {
  '/sms/send': ['post'],
  '/sms/status/{id}': ['get'],
  '/sms/sent': ['get'],
  '/sms/messages': ['get'],
  '/sms/inbox': ['get'],
  '/sms/balance': ['get'],
  '/sms/metrics': ['get'],
  '/sms/health': ['get'],
};

test('spec covers exactly the routes the gateway serves', () => {
  assert.deepStrictEqual(Object.keys(spec.paths).sort(), Object.keys(EXPECTED).sort());
  for (const [path, methods] of Object.entries(EXPECTED)) {
    assert.deepStrictEqual(Object.keys(spec.paths[path]).sort(), methods.sort(), path);
  }
});

test('both auth schemes are declared and applied globally', () => {
  assert.strictEqual(spec.components.securitySchemes.ApiKeyAuth.name, 'x-api-key');
  assert.strictEqual(spec.components.securitySchemes.BearerAuth.scheme, 'bearer');
  assert.deepStrictEqual(spec.security, [{ ApiKeyAuth: [] }, { BearerAuth: [] }]);
});

test('every $ref points at an existing component', () => {
  const refs = [];
  (function collect(node) {
    if (Array.isArray(node)) return node.forEach(collect);
    if (node && typeof node === 'object') {
      if (typeof node.$ref === 'string') refs.push(node.$ref);
      Object.values(node).forEach(collect);
    }
  })(spec);

  assert.ok(refs.length > 0);
  for (const ref of refs) {
    assert.match(ref, /^#\//, ref);
    const target = ref
      .slice(2)
      .split('/')
      .reduce((node, key) => (node == null ? node : node[key]), spec);
    assert.ok(target, `unresolved $ref: ${ref}`);
  }
});

test('send request documents the same phone rule the router enforces', () => {
  const { PHONE_RE } = require('../utils/sms-encoding');
  const documented = spec.components.schemas.SendRequest.properties.to.pattern;
  assert.strictEqual(new RegExp(documented).source, PHONE_RE.source);
});
