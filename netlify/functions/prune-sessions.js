// netlify/functions/prune-sessions.js
//
// Scheduled function — runs automatically on the cron defined below.
// Deletes session rows older than RETENTION_DAYS to keep the `sessions`
// table from growing unbounded. Pub/table config (the `pubs` table) is
// never touched — only historical session rows.

const { schedule } = require('@netlify/functions');

const RETENTION_DAYS = 7;

const handler = async () => {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffDate = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD

  try {
    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/sessions?date=lt.${cutoffDate}`,
      {
        method: 'DELETE',
        headers: {
          'apikey':        process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'return=representation', // so we can count what was deleted
        },
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error('Prune failed:', res.status, errText);
      return { statusCode: 500, body: 'Prune failed' };
    }

    const deleted = await res.json();
    console.log(`Pruned ${deleted.length} session(s) older than ${cutoffDate}`);

    return { statusCode: 200, body: `Pruned ${deleted.length} session(s)` };
  } catch (err) {
    console.error('Prune error:', err);
    return { statusCode: 500, body: 'Prune error' };
  }
};

// Run once a day at 03:15 UTC — quiet hours for a UK pub app.
exports.handler = schedule('15 3 * * *', handler);
