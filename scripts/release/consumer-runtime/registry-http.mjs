export async function registryRequest(endpoint, path, options = {}) {
  const url = new URL(path, endpoint);
  if (url.origin !== new URL(endpoint).origin || url.username || url.password) throw new Error('Request escaped owned registry');
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Local registry response ${response.status}`);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 32 * 1024 * 1024) throw new Error('Registry response exceeds limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
