function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function measure(asyncFn) {
  const startedAt = Date.now();
  const result = await asyncFn();
  const durationMs = Date.now() - startedAt;
  return { result, durationMs };
}

module.exports = {
  sleep,
  measure
};

