const express = require('express');

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 4002);
const DEFAULT_INVENTORY_FAIL_MODE = process.env.INVENTORY_FAIL_MODE || 'never';
const DEFAULT_INVENTORY_RELEASE_FAIL_MODE = process.env.INVENTORY_RELEASE_FAIL_MODE || 'never';

let logs = [];
let sequence = 0;
let config = {
  inventoryFailMode: DEFAULT_INVENTORY_FAIL_MODE,
  inventoryReleaseFailMode: DEFAULT_INVENTORY_RELEASE_FAIL_MODE
};

function shouldFail(mode) {
  if (mode === 'always') return true;
  if (mode === 'random') return Math.random() < 0.5;
  return false;
}

function record(action, req, body, outcome) {
  sequence += 1;
  logs.push({
    seq: sequence,
    at: new Date().toISOString(),
    action,
    orderId: body?.orderId || req.header('x-order-id') || null,
    correlationId: req.header('x-correlation-id') || null,
    outcome
  });
}

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.post('/inventory/reserve', (req, res) => {
  const { orderId, items } = req.body || {};
  if (!orderId || !Array.isArray(items)) {
    record('reserve', req, req.body, 'validation_error');
    res.status(400).json({ code: 'validation_error', message: 'orderId and items[] are required' });
    return;
  }

  if (shouldFail(config.inventoryFailMode)) {
    record('reserve', req, req.body, 'failed');
    res.status(422).json({
      ok: false,
      step: 'inventory',
      code: 'inventory_unavailable',
      orderId
    });
    return;
  }

  record('reserve', req, req.body, 'success');
  res.status(200).json({
    ok: true,
    step: 'inventory',
    reservationId: `inv-${orderId}`,
    orderId
  });
});

app.post('/inventory/release', (req, res) => {
  const { orderId } = req.body || {};
  if (!orderId) {
    record('release', req, req.body, 'validation_error');
    res.status(400).json({ code: 'validation_error', message: 'orderId is required' });
    return;
  }

  if (shouldFail(config.inventoryReleaseFailMode)) {
    record('release', req, req.body, 'failed');
    res.status(422).json({
      ok: false,
      step: 'inventory_release',
      code: 'release_failed',
      orderId
    });
    return;
  }

  record('release', req, req.body, 'success');
  res.status(200).json({
    ok: true,
    step: 'inventory_release',
    releaseId: `rel-${orderId}`,
    orderId
  });
});

app.get('/admin/logs', (_req, res) => {
  res.status(200).json({ service: 'inventory', logs });
});

app.post('/admin/config', (req, res) => {
  const incoming = req.body || {};
  if (typeof incoming.inventoryFailMode === 'string') {
    config.inventoryFailMode = incoming.inventoryFailMode;
  }
  if (typeof incoming.inventoryReleaseFailMode === 'string') {
    config.inventoryReleaseFailMode = incoming.inventoryReleaseFailMode;
  }
  res.status(200).json({ status: 'ok', config });
});

app.post('/admin/reset', (_req, res) => {
  logs = [];
  sequence = 0;
  res.status(200).json({ status: 'ok' });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[inventory] mock listening on ${PORT}`);
});

