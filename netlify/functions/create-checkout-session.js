const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: "Method Not Allowed" };

  // Debugging: Check if vars exist
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID) {
    console.error("Missing ENV Vars");
    return { statusCode: 500, body: JSON.stringify({ error: "Configuration Error" }) };
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      mode: 'subscription',
      success_url: 'https://whosonnext.uk/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://whosonnext.uk/cancelled',
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (error) {
    console.error("Stripe Error:", error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
