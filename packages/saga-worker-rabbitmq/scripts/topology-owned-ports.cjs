const OWNER_LABEL = 'redemeine.fyp3.3.run';

function ownedId(output, name, id, runId) {
  let value;
  try { value = JSON.parse(output); }
  catch { throw new Error('owned Rabbit identity unavailable'); }
  if (value?.Id !== id || value?.Name !== `/${name}` || value?.Config?.Labels?.[OWNER_LABEL] !== runId) {
    throw new Error('owned Rabbit identity mismatch');
  }
  return id;
}

function mappedPort(output) {
  const match = /^127\.0\.0\.1:([0-9]+)$/.exec(output.trim());
  const number = match ? Number(match[1]) : null;
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error('unique localhost Rabbit port required');
  return number;
}

module.exports = { ownedId, mappedPort };
