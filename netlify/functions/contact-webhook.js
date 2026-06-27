exports.handler = async (event) => {
try {
const payload = JSON.parse(event.body);

```
const name = payload.name || "there";
const email = payload.email;
const subject = payload.subject || "General Enquiry";
const message = payload.message || "";

if (!email) {
  return {
    statusCode: 400,
    body: "Missing email"
  };
}

const resendResponse = await fetch(
  "https://api.resend.com/emails",
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: "WhosOnNext <noreply@whosonnext.uk>",
      to: [email],
      subject: "We've received your enquiry",
      html: `
        <h2>🎱 Thanks for contacting WhosOnNext</h2>

        <p>Hi ${name},</p>

        <p>
          We've received your enquiry and will get back to you as soon as possible.
        </p>

        <h3>Your submission</h3>

        <ul>
          <li><strong>Name:</strong> ${name}</li>
          <li><strong>Email:</strong> ${email}</li>
          <li><strong>Subject:</strong> ${subject}</li>
        </ul>

        <p>
          <strong>Message:</strong>
        </p>

        <blockquote style="border-left:3px solid #D4A441;padding-left:12px;">
          ${message}
        </blockquote>

        <p>
          Thanks,<br>
          WhosOnNext
        </p>
      `
    })
  }
);

const data = await resendResponse.json();

return {
  statusCode: 200,
  body: JSON.stringify(data)
};
```

} catch (err) {
console.error(err);

```
return {
  statusCode: 500,
  body: JSON.stringify({
    error: err.message
  })
};
```

}
};
