// netlify/functions/stripe-webhook.js

const Stripe = require('stripe');

function toSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

// Helper to generate QR code URL
function getQrCodeUrl(url) {
  return `https://quickchart.io/qr?text=${encodeURIComponent(url)}&size=300&margin=1&format=png`;
}

exports.handler = async (event) => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  // Verify the request came from Stripe
  const sig = event.headers['stripe-signature'];
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Signature failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  // ── 1. NEW SIGNUP ─────────────────────────────────────────────────────────
  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;

    const pubName = session.custom_fields
      ?.find(f => f.key === 'pub_name')?.text?.value?.trim() || 'New Pub';
    const passkey = session.custom_fields
      ?.find(f => f.key === 'passkey')?.text?.value?.trim() || 'pool';
    const email   = session.customer_details?.email || '';
    const slug    = `${toSlug(pubName)}-${Math.floor(1000 + Math.random() * 9000)}`;
    const pubUrl  = `https://whosonnext.uk/pubs/${slug}`;
    const qrUrl   = getQrCodeUrl(pubUrl);

    // Raw fetch to Supabase REST API — no JS client needed
    const insertRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/pubs`,
      {
        method: 'POST',
        headers: {
          'apikey':         process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'return=minimal',
        },
        body: JSON.stringify({
          slug,
          name:               pubName,
          passkey,
          email,
          stripe_customer_id: session.customer,
          plan:               'trial',
        }),
      }
    );

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      console.error('Supabase insert failed:', insertRes.status, errText);
      return { statusCode: 500, body: 'Database error' };
    }

    console.log(`Created pub: ${pubName} -> ${pubUrl}`);

    // Send welcome email via Resend
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
            
            <div style="border: 2px solid #D4A441; padding: 20px; border-radius: 12px; text-align: center; margin: 24px 0;">
              <p style="margin-top: 0;"><strong>Scan to manage the queue:</strong></p>
              <img src="${qrUrl}" alt="QR Code for ${pubName}" style="width: 200px; height: 200px; display: block; margin: 0 auto;">
              <p style="margin-bottom: 0;">Or visit: <a href="${pubUrl}">${pubUrl.replace('https://', '')}</a></p>
            </div>

            <p>Stick this QR code on your pool table. Players scan it to join the queue.</p>
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
      console.warn('Welcome email failed:', await emailRes.text());
    }

    // Send notification email to admin
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'WhosOnNext <noreply@whosonnext.uk>',
        to: ['ruairi@whosonnext.uk'],
        subject: `New Signup: ${pubName}`,
        html: `<h1>New Signup!</h1><p><strong>Pub Name:</strong> ${pubName}</p><p><strong>Customer Email:</strong> ${email}</p><p><strong>Passkey:</strong> ${passkey}</p><p><strong>Slug:</strong> ${slug}</p>`
      }),
    });
  }

  // ── 2. TRIAL → PAID ───────────────────────────────────────────────────────
  if (stripeEvent.type === 'invoice.payment_succeeded') {
    const invoice = stripeEvent.data.object;
    if (invoice.billing_reason === 'subscription_cycle' || invoice.billing_reason === 'subscription_update') {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/pubs?stripe_customer_id=eq.${invoice.customer}`, {
        method: 'PATCH',
        headers: {
          'apikey':        process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ plan: 'active' }),
      });
      console.log(`Plan -> active for ${invoice.customer}`);
    }
  }

  // ── 3. SUBSCRIPTION ENDED ─────────────────────────────────────────────────
  if (stripeEvent.type === 'customer.subscription.deleted') {
    const sub = stripeEvent.data.object;
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/pubs?stripe_customer_id=eq.${sub.customer}`, {
      method: 'PATCH',
      headers: {
        'apikey':        process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ plan: 'inactive' }),
    });
    console.log(`Plan -> inactive for ${sub.customer}`);
  }

  return { statusCode: 200, body: 'ok' };
};
