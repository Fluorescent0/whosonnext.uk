// netlify/functions/create-checkout-session.js
// Creates a Stripe Checkout session and returns the redirect URL.

const Stripe = require('stripe');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],

      line_items: [{
        price:    process.env.STRIPE_PRICE_ID, // your £25/month price ID
        quantity: 1,
      }],

      subscription_data: {
        trial_period_days: 30,
      },

      // Collect pub name + passkey during Stripe checkout (max 3 custom fields)
      custom_fields: [
        {
          key:   'pub_name',
          label: { type: 'custom', custom: 'Pub name' },
          type:  'text',
        },
        {
          key:   'passkey',
          label: { type: 'custom', custom: 'Create admin passkey (staff use this to manage the app)' },
          type:  'text',
        },
      ],

      success_url: 'https://whosonnext.uk/welcome?session_id={CHECKOUT_SESSION_ID}',
      cancel_url:  'https://whosonnext.uk/#signup',
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url }),
    };

  } catch (err) {
    console.error('Stripe error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
