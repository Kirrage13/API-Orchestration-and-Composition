const express = require('express');

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 4003);
const DEFAULT_SHIPPING_FAIL_MODE = process.env.SHIPPING_FAIL_MODE || 'never';
const DEFAULT_SHIPPING_DELAY_MS = Number(process.env.SHIPPING_DELAY_MS || 0);

let logs = [];
let sequence = 0;
let config = {
  shippingFailMode: DEFAULT_SHIPPING_FAIL_MODE,
  shippingDelayMs: DEFAULT_SHIPPING_DELAY_MS
};

function shouldFail(mode) {
  if (mode === 'always') return true;
  if (mode === 'random') return Math.random() < 0.5;
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function record(action, req, body, outcome) {
  sequence += 1;
  logs.push({
    seq: sequence,
    at: new Date().toISOString(),
    action,
    orderId: body?.orderId || req.header('x-order-id') || null,
    correlationId: req.header('x-correlation-id') || null,
    outcome,
    delayMs: config.shippingDelayMs
  });
}

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.post('/shipping/create', async (req, res) => {
  const { orderId } = req.body || {};
  if (!orderId) {
    record('create', req, req.body, 'validation_error');
    res.status(400).json({ code: 'validation_error', message: 'orderId is required' });
    return;
  }

  if (config.shippingDelayMs > 0) {
    await sleep(config.shippingDelayMs);
  }

  if (shouldFail(config.shippingFailMode)) {
    record('create', req, req.body, 'failed');
    res.status(422).json({
      ok: false,
      step: 'shipping',
      code: 'shipping_unavailable',
      orderId
    });
    return;
  }

  record('create', req, req.body, 'success');
  res.status(200).json({
    ok: true,
    step: 'shipping',
    shipmentId: `shp-${orderId}`,
    orderId
  });
});

app.get('/admin/logs', (_req, res) => {
  res.status(200).json({ service: 'shipping', logs });
});

app.post('/admin/config', (req, res) => {
  const incoming = req.body || {};
  if (typeof incoming.shippingFailMode === 'string') {
    config.shippingFailMode = incoming.shippingFailMode;
  }
  if (typeof incoming.shippingDelayMs === 'number' && Number.isFinite(incoming.shippingDelayMs)) {
    config.shippingDelayMs = Math.max(0, Math.floor(incoming.shippingDelayMs));
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
  console.log(`[shipping] mock listening on ${PORT}`);
});

