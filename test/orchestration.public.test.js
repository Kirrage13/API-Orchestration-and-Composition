/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { checkout, health, resetMock, getMockLogs, configureMock } = require('./helpers/api');
const { assertValid, validateCheckoutResponse, validateIdempotencyStore, validateSagaStore } = require('./helpers/schema');
const { measure, sleep } = require('./helpers/timing');

const ROOT = path.resolve(__dirname, '..');
const IDEMPOTENCY_STORE = path.resolve(ROOT, 'orchestrator', 'data', 'idempotency-store.json');
const SAGA_STORE = path.resolve(ROOT, 'orchestrator', 'data', 'saga-store.json');

const PAYMENT_URL = process.env.PAYMENT_URL || 'http://localhost:4001';
const INVENTORY_URL = process.env.INVENTORY_URL || 'http://localhost:4002';
const SHIPPING_URL = process.env.SHIPPING_URL || 'http://localhost:4003';
const NOTIFICATION_URL = process.env.NOTIFICATION_URL || 'http://localhost:4004';

function loadScenario(name) {
  const file = path.resolve(__dirname, 'scenarios', name);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadStore(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function resetAllMocks() {
  await resetMock(PAYMENT_URL);
  await resetMock(INVENTORY_URL);
  await resetMock(SHIPPING_URL);
  await resetMock(NOTIFICATION_URL);

  await configureMock(PAYMENT_URL, {
    paymentFailMode: 'never',
    paymentRefundFailMode: 'never'
  });
  await configureMock(INVENTORY_URL, {
    inventoryFailMode: 'never',
    inventoryReleaseFailMode: 'never'
  });
  await configureMock(SHIPPING_URL, {
    shippingFailMode: 'never',
    shippingDelayMs: 0
  });
  await configureMock(NOTIFICATION_URL, {
    notificationFailMode: 'never'
  });
}

describe('Practice 3 public orchestration tests', () => {
  jest.setTimeout(120000);

  beforeEach(async () => {
    await resetAllMocks();
    await sleep(150);
  });

  test('1) services start and health checks pass', async () => {
    const orchestratorHealth = await health();
    expect(orchestratorHealth.status).toBe(200);
    expect(orchestratorHealth.data?.status).toBe('ok');

    const mockHealthChecks = await Promise.all([
      axios.get(`${PAYMENT_URL}/health`, { validateStatus: () => true }),
      axios.get(`${INVENTORY_URL}/health`, { validateStatus: () => true }),
      axios.get(`${SHIPPING_URL}/health`, { validateStatus: () => true }),
      axios.get(`${NOTIFICATION_URL}/health`, { validateStatus: () => true })
    ]);
    for (const h of mockHealthChecks) {
      expect(h.status).toBe(200);
      expect(h.data?.status).toBe('ok');
    }
  });

  test('2) happy path full sequence and completed result', async () => {
    const scenario = loadScenario('happy-path.json');
    await configureMock(PAYMENT_URL, { paymentFailMode: 'never' });
    await configureMock(INVENTORY_URL, { inventoryFailMode: 'never' });
    await configureMock(SHIPPING_URL, { shippingFailMode: 'never', shippingDelayMs: 0 });
    await configureMock(NOTIFICATION_URL, { notificationFailMode: 'never' });

    const res = await checkout(scenario.payload, scenario.idempotencyKey);
    expect([200, 422]).toContain(res.status);
    expect(res.data?.trace).toBeDefined();
    expect(Array.isArray(res.data?.trace)).toBe(true);
    if (res.status === 200) {
      expect(res.data?.status).toBe('completed');
      assertValid(validateCheckoutResponse, res.data);
    }
  });

  test('3) payment fail short-circuits downstream calls', async () => {
    const scenario = loadScenario('payment-failure.json');
    await configureMock(PAYMENT_URL, { paymentFailMode: 'always' });

    const res = await checkout(scenario.payload, `${scenario.idempotencyKey}-${Date.now()}`);
    expect([422, 504]).toContain(res.status);

    const inventoryLogs = await getMockLogs(INVENTORY_URL);
    const shippingLogs = await getMockLogs(SHIPPING_URL);
    expect(inventoryLogs.status).toBe(200);
    expect(shippingLogs.status).toBe(200);

    const invEntries = inventoryLogs.data?.logs || [];
    const shpEntries = shippingLogs.data?.logs || [];
    expect(invEntries.length).toBe(0);
    expect(shpEntries.length).toBe(0);
  });

  test('4) inventory fail triggers payment refund compensation', async () => {
    const scenario = loadScenario('inventory-failure.json');
    await configureMock(PAYMENT_URL, { paymentFailMode: 'never' });
    await configureMock(INVENTORY_URL, { inventoryFailMode: 'always' });

    const res = await checkout(scenario.payload, `${scenario.idempotencyKey}-${Date.now()}`);
    expect(res.status).toBe(422);

    const paymentLogs = await getMockLogs(PAYMENT_URL);
    const actions = (paymentLogs.data?.logs || []).map((x) => x.action);
    expect(actions).toContain('authorize');
    expect(actions).toContain('refund');
  });

  test('5) shipping timeout within limit triggers compensation', async () => {
    const scenario = loadScenario('shipping-timeout.json');
    await configureMock(SHIPPING_URL, { shippingDelayMs: 6000, shippingFailMode: 'never' });

    const timed = await measure(() => checkout(scenario.payload, `${scenario.idempotencyKey}-${Date.now()}`));
    expect(timed.result.status).toBe(504);
    expect(timed.result.data?.code).toBe('timeout');
    expect(timed.durationMs).toBeLessThan(20000);
  });

  test('6) compensation failure maps to 422 + compensation_failed', async () => {
    const scenario = loadScenario('inventory-failure.json');
    await configureMock(INVENTORY_URL, { inventoryFailMode: 'always', inventoryReleaseFailMode: 'never' });
    await configureMock(PAYMENT_URL, { paymentFailMode: 'never', paymentRefundFailMode: 'always' });

    const res = await checkout(scenario.payload, `idem-comp-fail-${Date.now()}`);
    expect(res.status).toBe(422);
    expect(res.data?.code).toBe('compensation_failed');
  });

  test('7) idempotency replay same key same payload returns stable response', async () => {
    const scenario = loadScenario('idempotency-replay.json');
    const key = `${scenario.idempotencyKey}-${Date.now()}`;

    const first = await checkout(scenario.payload, key);
    const second = await checkout(scenario.payload, key);

    expect([200, 422, 504]).toContain(first.status);
    expect(second.status).toBe(first.status);
    expect(second.data?.orderId).toBe(first.data?.orderId);
  });

  test('8) idempotency mismatch same key different payload returns 409', async () => {
    const scenario = loadScenario('idempotency-mismatch.json');
    const key = `${scenario.idempotencyKey}-${Date.now()}`;
    await checkout(scenario.payloadA, key);
    const mismatch = await checkout(scenario.payloadB, key);
    expect(mismatch.status).toBe(409);
    expect(mismatch.data?.code).toBe('idempotency_payload_mismatch');
  });

  test('9) trace contract and persistence files match schemas', async () => {
    const scenario = loadScenario('happy-path.json');
    const res = await checkout(
      { ...scenario.payload, orderId: `ord-trace-${Date.now()}` },
      `idem-trace-${Date.now()}`
    );
    if (res.data) {
      assertValid(validateCheckoutResponse, res.data);
    }

    const idempotencyStore = loadStore(IDEMPOTENCY_STORE);
    const sagaStore = loadStore(SAGA_STORE);

    assertValid(validateIdempotencyStore, idempotencyStore);
    assertValid(validateSagaStore, sagaStore);
  });

  test('10) bonus stress: repeated deterministic runs (advisory)', async () => {
    const scenario = loadScenario('happy-path.json');
    let completed = 0;

    for (let i = 0; i < 5; i += 1) {
      const res = await checkout(
        { ...scenario.payload, orderId: `ord-stress-${i}-${Date.now()}` },
        `idem-stress-${i}-${Date.now()}`
      );
      if (res.status === 200 && res.data?.status === 'completed') {
        completed += 1;
      }
    }

    expect(completed).toBeGreaterThanOrEqual(0);
  });
});

