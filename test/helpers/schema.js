const fs = require('fs');
const path = require('path');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function loadSchema(relativePath) {
  const absolute = path.resolve(__dirname, '..', '..', 'grading', 'schema', relativePath);
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

const checkoutResponseSchema = loadSchema('checkout-response.schema.json');
const idempotencyStoreSchema = loadSchema('idempotency-store.schema.json');
const sagaStoreSchema = loadSchema('saga-store.schema.json');
const traceItemSchema = loadSchema('trace-item.schema.json');

ajv.addSchema(traceItemSchema, 'trace-item.schema.json');

const validateCheckoutResponse = ajv.compile(checkoutResponseSchema);
const validateIdempotencyStore = ajv.compile(idempotencyStoreSchema);
const validateSagaStore = ajv.compile(sagaStoreSchema);

function assertValid(validator, payload) {
  const ok = validator(payload);
  if (!ok) {
    const text = JSON.stringify(validator.errors || []);
    throw new Error(`Schema validation failed: ${text}`);
  }
}

module.exports = {
  assertValid,
  validateCheckoutResponse,
  validateIdempotencyStore,
  validateSagaStore
};

