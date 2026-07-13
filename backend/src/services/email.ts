// Transactional email via Resend — the retention channel web push can't be
// (iOS PWAs drop pushes; everyone reads email).
//
// Fully gated: without RESEND_API_KEY + EMAIL_FROM nothing sends and the
// weekly digest cron is a no-op, so the code can ship before the account
// exists. To activate: create a Resend account, verify the octomind.win
// domain (DNS records), then set the two env vars on Railway.

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!emailConfigured()) throw new Error('Email not configured (RESEND_API_KEY / EMAIL_FROM)');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, html }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
