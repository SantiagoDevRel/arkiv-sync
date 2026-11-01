// Origin is a serialized origin, never a general URL. Forwarded headers do not select trust.
function sameDeploymentOrigin(origin, host) {
  if (typeof origin !== 'string' || typeof host !== 'string' || !host || !(origin.startsWith('https://') || origin.startsWith('http://'))) return false;
  const parsed = new URL(origin);
  const hostname = host.split(':', 1)[0].toLowerCase();
  const scheme = hostname === 'localhost' || hostname === '127.0.0.1' ? 'http://' : 'https://';
  const deployment = new URL(scheme + host);
  if (/[/\\?#@\s]/.test(host) || deployment.username || deployment.password || deployment.pathname !== '/' || deployment.search || deployment.hash) return false;
  return !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash && parsed.origin === origin && parsed.origin === deployment.origin;
}

export function rejectBrowserRequest(req, res) {
  const reject = (status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(body)); return true; };
  const origin = req.headers?.origin;
  if (origin !== undefined) {
    try {
      if (!sameDeploymentOrigin(origin, req.headers?.host)) return reject(403, { error: 'Origin not allowed.' });
    } catch { return reject(403, { error: 'Origin not allowed.' }); }
  }
  if (String(req.headers?.['sec-fetch-site'] ?? '').split(',').some(site => site.trim().toLowerCase() === 'cross-site')) return reject(403, { error: 'Origin not allowed.' });
  const contentType = req.headers?.['content-type'];
  if (req.method === 'POST' && (typeof contentType !== 'string' || contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json')) return reject(415, { error: 'Use application/json for read requests.' });
  return false;
}
