// netlify/functions/verify-passkey.js
//
// Checks a submitted passkey against the stored value for a pub,
// entirely server-side. The actual passkey value is never sent
// back to the browser — only a true/false result.
//
// Uses the service role key, which bypasses RLS and column grants,
// so this is the one place in the codebase that's still allowed
// to read the `passkey` column directly.

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
