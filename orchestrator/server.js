const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function readRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function loadConfig() {
  return {
    port: Number(process.env.ORCHESTRATOR_PORT || 3000),
    paymentUrl: readRequiredEnv('PAYMENT_URL'),
    inventoryUrl: readRequiredEnv('INVENTORY_URL'),
    shippingUrl: readRequiredEnv('SHIPPING_URL'),
    notificationUrl: readRequiredEnv('NOTIFICATION_URL'),
    requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 2500)
  };
}

const config = loadConfig();

const DATA_DIR = '/data';
const IDEMPOTENCY_STORE_PATH = path.join(DATA_DIR, 'idempotency-store.json');
const SAGA_STORE_PATH = path.join(DATA_DIR, 'saga-store.json');

function ensureJsonFile(filePath, initialData) {
  const dirPath = path.dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(initialData, null, 2), 'utf8');
  }
}

function readJsonFile(filePath) {
  ensureJsonFile(filePath, {});
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw || '{}');
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function nowIso() {
  return new Date().toISOString();
}

function payloadHash(payload) {
  const normalized = JSON.stringify(payload);
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  return `sha256:${hash}`;
}

function validateCheckoutPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return 'Request body must be a JSON object';
  }
  if (typeof payload.orderId !== 'string' || payload.orderId.trim() === '') {
    return 'Field "orderId" is required and must be a non-empty string';
  }
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    return 'Field "items" is required and must be a non-empty array';
  }
  if (typeof payload.amount !== 'number') {
    return 'Field "amount" is required and must be numeric';
  }
  if (typeof payload.recipient !== 'string' || payload.recipient.trim() === '') {
    return 'Field "recipient" is required and must be a non-empty string';
  }
  return null;
}

function bootstrapStores() {
  ensureJsonFile(IDEMPOTENCY_STORE_PATH, { records: {} });
  ensureJsonFile(SAGA_STORE_PATH, { sagas: {} });
}
function ensureIdempotencyStoreShape(store) {
  if (!store.records || typeof store.records !== 'object') {
    store.records = {};
  }
  return store;
}

function ensureSagaStoreShape(store) {
  if (!store.sagas || typeof store.sagas !== 'object') {
    store.sagas = {};
  }
  return store;
}

function saveSaga(orderId, patch) {
  const sagaStore = ensureSagaStoreShape(readJsonFile(SAGA_STORE_PATH));
  const existing = sagaStore.sagas[orderId] || {};
  sagaStore.sagas[orderId] = {
    ...existing,
    ...patch,
    updatedAt: nowIso()
  };
  writeJsonFile(SAGA_STORE_PATH, sagaStore);
  return sagaStore.sagas[orderId];
}

function saveIdempotencyRecord(idempotencyKey, patch) {
  const store = ensureIdempotencyStoreShape(readJsonFile(IDEMPOTENCY_STORE_PATH));
  const existing = store.records[idempotencyKey] || {};
  store.records[idempotencyKey] = {
    ...existing,
    ...patch,
    updatedAt: nowIso()
  };
  writeJsonFile(IDEMPOTENCY_STORE_PATH, store);
  return store.records[idempotencyKey];
}

function makeTraceEntry(step, status, startedAt, finishedAt) {
  return {
    step,
    status,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime())
  };
}

function isTimeoutError(error) {
  return (
    error?.code === 'ECONNABORTED' ||
    /timeout/i.test(error?.message || '') ||
    error?.response?.status === 504 ||
    error?.response?.data?.code === 'timeout' ||
    /timeout/i.test(error?.response?.data?.message || '')
  );
}

async function postWithTimeout(url, body) {
  return axios.post(url, body, {
    timeout: config.requestTimeoutMs,
    headers: {
      'Content-Type': 'application/json'
    }
  });
}

async function refundPayment(payload) {
  return postWithTimeout(`${config.paymentUrl}/payment/refund`, {
    ...payload,
    orderId: payload.orderId
  });
}

async function releaseInventory(payload) {
  return postWithTimeout(`${config.inventoryUrl}/inventory/release`, {
    ...payload,
    orderId: payload.orderId
  });
}

async function runCompensationStep(trace, stepName, fn) {
  const startedAt = nowIso();
  try {
    await fn();
    const finishedAt = nowIso();
    trace.push(makeTraceEntry(stepName, 'success', startedAt, finishedAt));
    return { ok: true };
  } catch (error) {
    const finishedAt = nowIso();
    trace.push(makeTraceEntry(stepName, 'failed', startedAt, finishedAt));
    return { ok: false, error };
  }
}

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/debug/trace/:orderId', (req, res) => {
  const sagaStore = readJsonFile(SAGA_STORE_PATH);
  const saga = sagaStore?.sagas?.[req.params.orderId];
  if (!saga) {
    res.status(404).json({ code: 'not_found', message: 'No saga found for this orderId' });
    return;
  }
  res.status(200).json(saga);
});

app.post('/checkout', async (req, res) => {
  const idempotencyKey = req.header('Idempotency-Key');
  if (!idempotencyKey) {
    res.status(400).json({
      code: 'validation_error',
      message: 'Idempotency-Key header is required'
    });
    return;
  }

  const validationError = validateCheckoutPayload(req.body);
  if (validationError) {
    res.status(400).json({
      code: 'validation_error',
      message: validationError
    });
    return;
  }

  const requestHash = payloadHash(req.body);
  const idempotencyStore = readJsonFile(IDEMPOTENCY_STORE_PATH);
  if (!idempotencyStore.records) {
    idempotencyStore.records = {};
  }

  const existing = idempotencyStore.records[idempotencyKey];
  if (existing) {
    if (existing.requestHash !== requestHash) {
      res.status(409).json({
        code: 'idempotency_payload_mismatch',
        message: 'This Idempotency-Key is already used for a different payload'
      });
      return;
    }

    if (existing.state === 'in_progress') {
      res.status(409).json({
        code: 'idempotency_conflict',
        message: 'A request with this Idempotency-Key is already in progress'
      });
      return;
    }

    res.status(existing.httpStatus || 200).json(existing.response);
    return;
  }

  const orderId = req.body.orderId;
  idempotencyStore.records[idempotencyKey] = {
    requestHash,
    state: 'in_progress',
    httpStatus: 202,
    response: {
      orderId,
      status: 'in_progress'
    },
    updatedAt: nowIso()
  };
  writeJsonFile(IDEMPOTENCY_STORE_PATH, idempotencyStore);

  const trace = [];

  saveSaga(orderId, {
  idempotencyKey,
  orderId,
  state: 'failed',
  request: req.body,
  steps: trace
});

  let paymentDone = false;
  let inventoryDone = false;
  let currentStep = null;

  try {
    currentStep = 'payment';
    const paymentStartedAt = nowIso();
    await postWithTimeout(`${config.paymentUrl}/payment/authorize`, {
      ...req.body,
      orderId
    });
    const paymentFinishedAt = nowIso();
    trace.push(makeTraceEntry('payment', 'success', paymentStartedAt, paymentFinishedAt));
    paymentDone = true;
    

    currentStep = 'inventory';
    const inventoryStartedAt = nowIso();
    await postWithTimeout(`${config.inventoryUrl}/inventory/reserve`, {
      ...req.body,
      orderId
    });
    const inventoryFinishedAt = nowIso();
    trace.push(makeTraceEntry('inventory', 'success', inventoryStartedAt, inventoryFinishedAt));
    inventoryDone = true;
   

    currentStep = 'shipping';
    const shippingStartedAt = nowIso();
    await postWithTimeout(`${config.shippingUrl}/shipping/create`, {
      ...req.body,
      orderId
    });
    const shippingFinishedAt = nowIso();
    trace.push(makeTraceEntry('shipping', 'success', shippingStartedAt, shippingFinishedAt));
  

    currentStep = 'notification';
    const notificationStartedAt = nowIso();
    await postWithTimeout(`${config.notificationUrl}/notification/send`, {
      ...req.body,
      orderId
    });
    const notificationFinishedAt = nowIso();
    trace.push(makeTraceEntry('notification', 'success', notificationStartedAt, notificationFinishedAt));

    const successResponse = {
  orderId,
  status: 'completed',
  trace
};

saveSaga(orderId, {
  state: 'completed',
  steps: trace,
  response: successResponse
});

saveIdempotencyRecord(idempotencyKey, {
  requestHash,
  state: 'completed',
  httpStatus: 200,
  response: successResponse
});

res.status(200).json(successResponse);
return;

  } catch (error) {
    const timeout = isTimeoutError(error);

    if (currentStep) {
      const failedStartedAt = nowIso();
      const failedFinishedAt = nowIso();
      trace.push(makeTraceEntry(currentStep, timeout ? 'timeout' : 'failed', failedStartedAt, failedFinishedAt));
    }

    const shouldReleaseInventory =
      inventoryDone && (currentStep === 'shipping' || currentStep === 'notification');

    const shouldRefundPayment =
      paymentDone && (currentStep === 'inventory' || currentStep === 'shipping' || currentStep === 'notification');

    const compensationNeeded = shouldReleaseInventory || shouldRefundPayment;

    if (shouldReleaseInventory) {
      const releaseResult = await runCompensationStep(trace, 'inventory_release', async () => {
        await releaseInventory(req.body);
      });

      if (!releaseResult.ok) {
        const compFailResponse = {
          orderId,
          status: 'failed',
          code: 'compensation_failed',
          message: releaseResult.error.message,
          trace
        };

        saveSaga(orderId, {
  state: 'failed',
  steps: trace,
  response: compFailResponse
});

        saveIdempotencyRecord(idempotencyKey, {
          requestHash,
          state: 'failed',
          httpStatus: 422,
          response: compFailResponse
        });

        res.status(422).json(compFailResponse);
        return;
      }
    }

    if (shouldRefundPayment) {
      const refundResult = await runCompensationStep(trace, 'payment_refund', async () => {
        await refundPayment(req.body);
      });

      if (!refundResult.ok) {
        const compFailResponse = {
          orderId,
          status: 'failed',
          code: 'compensation_failed',
          message: refundResult.error.message,
          trace
        };

        saveSaga(orderId, {
  state: 'failed',
  steps: trace,
  response: compFailResponse
});

        saveIdempotencyRecord(idempotencyKey, {
          requestHash,
          state: 'failed',
          httpStatus: 422,
          response: compFailResponse
        });

        res.status(422).json(compFailResponse);
        return;
      }
    }

    const failedResponse = {
  orderId,
  status: 'failed',
  code: timeout ? 'timeout' : 'business_failure',
  message: timeout ? 'Downstream service timeout' : error.message,
  trace
};

const httpStatus = timeout ? 504 : 422;

saveSaga(orderId, {
  state: compensationNeeded ? 'compensated' : 'failed',
  steps: trace,
  response: failedResponse
});

saveIdempotencyRecord(idempotencyKey, {
  requestHash,
  state: 'failed',
  httpStatus,
  response: failedResponse
});

res.status(httpStatus).json(failedResponse);
return;
  }
});

bootstrapStores();

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`[orchestrator] listening on port ${config.port}`);
  console.log('[orchestrator] downstream targets loaded from env', {
    paymentUrl: config.paymentUrl,
    inventoryUrl: config.inventoryUrl,
    shippingUrl: config.shippingUrl,
    notificationUrl: config.notificationUrl,
    requestTimeoutMs: config.requestTimeoutMs
  });
});