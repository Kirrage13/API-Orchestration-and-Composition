const express = require('express');

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 4004);
const DEFAULT_NOTIFICATION_FAIL_MODE = process.env.NOTIFICATION_FAIL_MODE || 'never';

let logs = [];
let sequence = 0;
let config = {
  notificationFailMode: DEFAULT_NOTIFICATION_FAIL_MODE
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

app.post('/notification/send', (req, res) => {
  const { orderId, recipient } = req.body || {};
  if (!orderId || !recipient) {
    record('send', req, req.body, 'validation_error');
    res.status(400).json({ code: 'validation_error', message: 'orderId and recipient are required' });
    return;
  }

  if (shouldFail(config.notificationFailMode)) {
    record('send', req, req.body, 'failed');
    res.status(422).json({
      ok: false,
      step: 'notification',
      code: 'notification_failed',
      orderId
    });
    return;
  }

  record('send', req, req.body, 'success');
  res.status(200).json({
    ok: true,
    step: 'notification',
    notificationId: `ntf-${orderId}`,
    orderId
  });
});

app.get('/admin/logs', (_req, res) => {
  res.status(200).json({ service: 'notification', logs });
});

app.post('/admin/config', (req, res) => {
  const incoming = req.body || {};
  if (typeof incoming.notificationFailMode === 'string') {
    config.notificationFailMode = incoming.notificationFailMode;
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
  console.log(`[notification] mock listening on ${PORT}`);
});

