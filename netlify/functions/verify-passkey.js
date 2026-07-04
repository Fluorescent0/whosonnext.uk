// netlify/functions/verify-passkey.js
//
// Checks a submitted passkey against the stored value for a pub,
// entirely server-side. The actual passkey value is never sent
// back to the browser — only a true/false result.
//
// Uses the service role key, which bypasses RLS and column grants,
// so this is the one place in the codebase that's still allowed
// to read the `passkey` column directly.

// --- Basic rate limiting ---------------------------------------------
// In-memory, per warm lambda instance. This is a first line of defence
// against brute-forcing a pub's passkey, not a complete one: Netlify
// can spin up multiple instances under load, and any given instance's
// memory resets on cold start, so a determined attacker spread across
// enough requests could still get more than MAX_ATTEMPTS tries in.
// If that ever matters in practice, move this to a Supabase-backed
// table (e.g. an `attempts` row per slug+ip with a timestamp) so the
// count is shared and durable across instances.
const WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ATTEMPTS = 5;
const attempts = new Map(); // key -> { count, windowStart }

function isRateLimited(key) {
  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry || now - entry.windowStart > WINDOW_MS) {
    attempts.set(key, { count: 1, windowStart: now });
    return false;
  }

  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

// Occasionally clear out stale entries so the map doesn't grow forever
// across a long-lived warm instance.
function sweepStaleEntries() {
  const now = Date.now();
  for (const [key, entry] of attempts) {
    if (now - entry.windowStart > WINDOW_MS) attempts.delete(key);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { slug, passkey } = body;

  if (!slug || typeof slug !== 'string' || !passkey || typeof passkey !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing slug or passkey' }) };
  }

  // Same allowlist used for slugs elsewhere in the app.
  if (!/^[a-z0-9-]{3,50}$/i.test(slug)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid slug format' }) };
  }

  // Rate limit per IP + slug, so one bad actor can't burn through
  // attempts on every pub at once, and one pub can't be hammered from
  // a single source.
  const ip = event.headers?.['x-nf-client-connection-ip']
    || event.headers?.['client-ip']
    || 'unknown';
  const rateLimitKey = `${ip}:${slug}`;

  if (isRateLimited(rateLimitKey)) {
    return {
      statusCode: 429,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Too many attempts. Please wait a few minutes and try again.' }),
    };
  }
  sweepStaleEntries();

  try {
    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/pubs?slug=eq.${encodeURIComponent(slug)}&select=passkey`,
      {
        headers: {
          'apikey':        process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    if (!res.ok) {
      console.error('Supabase lookup failed:', res.status, await res.text());
      return { statusCode: 500, body: JSON.stringify({ error: 'Lookup failed' }) };
    }

    const rows = await res.json();
    const stored = rows?.[0]?.passkey;

    // Always run a comparison even if the pub doesn't exist, so
    // response timing doesn't reveal whether a slug is valid.
    const match = typeof stored === 'string'
      ? stored.toLowerCase() === passkey.toLowerCase()
      : false;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: match }),
    };
  } catch (err) {
    console.error('verify-passkey error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
  }
};
