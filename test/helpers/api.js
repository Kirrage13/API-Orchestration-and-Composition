const axios = require('axios');

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://localhost:3000';

const client = axios.create({
  baseURL: ORCHESTRATOR_URL,
  timeout: 15000,
  validateStatus: () => true
});

async function checkout(payload, idempotencyKey) {
  return client.post('/checkout', payload, {
    headers: {
      'Idempotency-Key': idempotencyKey
    }
  });
}

async function health() {
  return client.get('/health');
}

async function resetMock(serviceUrl) {
  return axios.post(`${serviceUrl}/admin/reset`, {}, { validateStatus: () => true, timeout: 10000 });
}

async function getMockLogs(serviceUrl) {
  return axios.get(`${serviceUrl}/admin/logs`, { validateStatus: () => true, timeout: 10000 });
}

async function configureMock(serviceUrl, config) {
  return axios.post(`${serviceUrl}/admin/config`, config, { validateStatus: () => true, timeout: 10000 });
}

module.exports = {
  checkout,
  health,
  resetMock,
  getMockLogs,
  configureMock
};

