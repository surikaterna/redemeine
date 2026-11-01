import { get } from 'node:http';

export function request(port: number | undefined, path: string): Promise<{ status: number | undefined; text: string }> {
  if (port === undefined) return Promise.reject(new Error('missing_test_port'));
  return new Promise((resolve, reject) => {
    const req = get({ host: '127.0.0.1', port, path, agent: false }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk.toString(); });
      response.on('end', () => resolve({ status: response.statusCode, text }));
      response.on('error', reject);
    });
    req.on('error', reject);
  });
}
