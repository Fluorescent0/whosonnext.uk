// netlify/functions/stripe-webhook.js
// Receives Stripe events. On completed checkout:
//   1. Inserts a new row into the Supabase pubs table
//   2. Emails the pub their link and passkey via Resend

const Stripe                     = require('stripe');
const { createClient }           = require('@supabase/supabase-js');

// Converts "The Red Lion" → "the-red-lion"
function toSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

exports.handler = async (event) => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  // Service role key bypasses RLS — safe here because this only runs server-side
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Verify the request actually came from Stripe
  const sig = event.headers['stripe-signature'];
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;

    // Pull values from the Stripe custom fields
    const pubName = session.custom_fields
      ?.find(f => f.key === 'pub_name')?.text?.value?.trim() || 'New Pub';
    const passkey = session.custom_fields
      ?.find(f => f.key === 'passkey')?.text?.value?.trim() || 'pool';
    const email   = session.customer_details?.email || '';

    // Build a unique slug e.g. "the-red-lion-4821"
    const slug   = `${toSlug(pubName)}-${Math.floor(1000 + Math.random() * 9000)}`;
    const pubUrl = `https://whosonnext.uk/pubs/${slug}`;

    // Insert the new pub into Supabase
    const { error: dbError } = await supabase.from('pubs').insert({
      slug,
      name:               pubName,
      passkey,
      email,
      stripe_customer_id: session.customer,
      plan:               'trial',
    });

    if (dbError) {
      console.error('Supabase insert failed:', dbError);
      return { statusCode: 500, body: 'Database error' };
    }

    console.log(`✓ Created pub: ${pubName} → ${pubUrl}`);

    // Send welcome email via Resend (resend.com, free tier is plenty)
    const emailRes = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    'WhosOnNext <welcome@whosonnext.uk>',
        to:      email,
        subject: `${pubName} is live on WhosOnNext 🎱`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">
            <h2 style="color:#D4A441;">You're on the board, ${pubName}!</h2>
            <p>Your WhosOnNext page is live:</p>
            <p style="margin:24px 0;">
              <a href="${pubUrl}" style="background:#D4A441;color:#0D0800;font-weight:700;
                padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">
                ${pubUrl}
              </a>
            </p>
            <p>Stick this link on a QR code and put it on the table. Players scan it to join the queue.</p>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
            <p><strong>Admin passkey:</strong>
              <code style="background:#f4f4f4;padding:2px 8px;border-radius:4px;">${passkey}</code>
            </p>
            <p style="font-size:13px;color:#666;">Keep this safe — bar staff use it to manage the queue.</p>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
            <p style="font-size:13px;color:#666;">Questions? Just reply to this email.<br>— The WhosOnNext team</p>
          </div>
        `,
      }),
    });

    if (!emailRes.ok) {
      // Pub is created — don't fail the webhook just because email had a hiccup
      console.warn('Welcome email failed:', await emailRes.text());
    }
  }

  return { statusCode: 200, body: 'ok' };
};
