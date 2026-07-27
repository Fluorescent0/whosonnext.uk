// netlify/functions/cancel-subscription.js
//
// Lets a pub owner cancel their WhosOnNext subscription from the
// table manager. The passkey is re-verified server-side here (same
// approach as verify-passkey.js) so knowing/guessing a pub's tables
// URL alone is never enough to cancel someone's subscription.
//
// Cancellation is scheduled for the end of the current billing
// period (cancel_at_period_end: true) rather than immediate — the
// pub keeps full access until then. When the period actually ends,
// Stripe fires `customer.subscription.deleted`, which is already
// handled in stripe-webhook.js and flips `plan` to 'inactive'. No
// changes needed there.

const Stripe = require('stripe');

// --- Basic rate limiting, same shape as verify-passkey.js -------------
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

function sweepStaleEntries() {
  const now = Date.now();
  for (const [key, entry] of attempts) {
    if (now - entry.windowStart > WINDOW_MS) attempts.delete(key);
  }
}

function formatDate(ms) {
  return new Date(ms).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
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
    // Service role key needed to read `passkey` and `stripe_customer_id`.
    const lookupRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/pubs?slug=eq.${encodeURIComponent(slug)}&select=name,email,passkey,plan,stripe_customer_id`,
      {
        headers: {
          'apikey':        process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    if (!lookupRes.ok) {
      console.error('Supabase lookup failed:', lookupRes.status, await lookupRes.text());
      return { statusCode: 500, body: JSON.stringify({ error: 'Lookup failed' }) };
    }

    const rows = await lookupRes.json();
    const pub = rows?.[0];

    // Always run a comparison even if the pub doesn't exist, so
    // response timing doesn't reveal whether a slug is valid.
    const storedPasskey = pub?.passkey ?? '__no_such_pub__';
    const match = storedPasskey.toLowerCase() === passkey.toLowerCase();

    if (!pub || !match) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Incorrect passkey' }),
      };
    }

    if (pub.plan === 'inactive') {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'This subscription has already ended.' }),
      };
    }

    if (!pub.stripe_customer_id) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'No subscription found for this pub. Contact support.' }),
      };
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const subs = await stripe.subscriptions.list({
      customer: pub.stripe_customer_id,
      status:   'all',
      limit:    10,
    });

    const activeSub = subs.data.find(s => ['active', 'trialing', 'past_due'].includes(s.status));

    if (!activeSub) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'No active subscription found. Contact support if this looks wrong.' }),
      };
    }

    // Already scheduled to cancel — don't re-send the email, just
    // report the existing date so the UI can show it.
    if (activeSub.cancel_at_period_end) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: true,
          accessUntil: activeSub.current_period_end * 1000,
          alreadyScheduled: true,
        }),
      };
    }

    const updated = await stripe.subscriptions.update(activeSub.id, {
      cancel_at_period_end: true,
    });

    const accessUntilMs  = updated.current_period_end * 1000;
    const accessUntilStr = formatDate(accessUntilMs);

    // Confirmation email — best-effort. Don't fail the cancellation
    // response if this errors; the cancellation itself already
    // succeeded with Stripe.
    if (pub.email) {
      try {
        const emailRes = await fetch('https://api.resend.com/emails', {
          method:  'POST',
          headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({
            from:    'WhosOnNext <noreply@whosonnext.uk>',
            to:      pub.email,
            subject: 'Your WhosOnNext subscription is set to cancel',
            html: `
              <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">
                <h2 style="color:#D4A441;">Cancellation confirmed for ${pub.name}</h2>
                <p>We've received your request to cancel WhosOnNext from your table manager.</p>

                <div style="background:#f9f5ec;border:1px solid #eadfc5;padding:18px 20px;border-radius:12px;margin:24px 0;">
                  <p style="margin-top:0;"><strong>What happens now</strong></p>
                  <ul style="padding-left:20px;margin-bottom:0;">
                    <li>No further charges will be taken.</li>
                    <li>${pub.name} keeps full access until <strong>${accessUntilStr}</strong>.</li>
                    <li>After that date, the queue and table manager stop working for staff and players.</li>
                  </ul>
                </div>

                <p>Changed your mind? Just reply to this email any time before ${accessUntilStr} and we'll switch you back on — no need to sign up again.</p>

                <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
                <p style="font-size:13px;color:#666;">Questions? Just reply to this email, or see <a href="https://whosonnext.uk/help#how-to-cancel">whosonnext.uk/help</a>.<br>— The WhosOnNext team</p>
              </div>
            `,
          }),
        });
        if (!emailRes.ok) {
          console.warn('Cancellation email failed:', await emailRes.text());
        }
      } catch (emailErr) {
        console.warn('Cancellation email failed:', emailErr);
      }
    }

    console.log(`Subscription cancel scheduled for ${slug} (${pub.stripe_customer_id}), ends ${accessUntilStr}`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, accessUntil: accessUntilMs }),
    };
  } catch (err) {
    console.error('cancel-subscription error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
  }
};
