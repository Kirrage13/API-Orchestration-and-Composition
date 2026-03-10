const express = require('express');

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 4001);
const DEFAULT_PAYMENT_FAIL_MODE = process.env.PAYMENT_FAIL_MODE || 'never';
const DEFAULT_PAYMENT_REFUND_FAIL_MODE = process.env.PAYMENT_REFUND_FAIL_MODE || 'never';

let logs = [];
let sequence = 0;
let config = {
  paymentFailMode: DEFAULT_PAYMENT_FAIL_MODE,
  paymentRefundFailMode: DEFAULT_PAYMENT_REFUND_FAIL_MODE
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

app.post('/payment/authorize', (req, res) => {
  const { orderId, amount } = req.body || {};
  if (!orderId || typeof amount !== 'number') {
    record('authorize', req, req.body, 'validation_error');
    res.status(400).json({ code: 'validation_error', message: 'orderId and numeric amount are required' });
    return;
  }

  if (shouldFail(config.paymentFailMode)) {
    record('authorize', req, req.body, 'failed');
    res.status(422).json({
      ok: false,
      step: 'payment',
      code: 'payment_declined',
      orderId
    });
    return;
  }

  record('authorize', req, req.body, 'success');
  res.status(200).json({
    ok: true,
    step: 'payment',
    authorizationId: `pay-${orderId}`,
    orderId
  });
});

app.post('/payment/refund', (req, res) => {
  const { orderId } = req.body || {};
  if (!orderId) {
    record('refund', req, req.body, 'validation_error');
    res.status(400).json({ code: 'validation_error', message: 'orderId is required' });
    return;
  }

  if (shouldFail(config.paymentRefundFailMode)) {
    record('refund', req, req.body, 'failed');
    res.status(422).json({
      ok: false,
      step: 'payment_refund',
      code: 'refund_failed',
      orderId
    });
    return;
  }

  record('refund', req, req.body, 'success');
  res.status(200).json({
    ok: true,
    step: 'payment_refund',
    refundId: `refund-${orderId}`,
    orderId
  });
});

app.get('/admin/logs', (_req, res) => {
  res.status(200).json({ service: 'payment', logs });
});

app.post('/admin/config', (req, res) => {
  const incoming = req.body || {};
  if (typeof incoming.paymentFailMode === 'string') {
    config.paymentFailMode = incoming.paymentFailMode;
  }
  if (typeof incoming.paymentRefundFailMode === 'string') {
    config.paymentRefundFailMode = incoming.paymentRefundFailMode;
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
  console.log(`[payment] mock listening on ${PORT}`);
});

