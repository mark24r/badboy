const requiredConfig = [
  'MPESA_CONSUMER_KEY',
  'MPESA_CONSUMER_SECRET',
  'MPESA_SHORTCODE',
  'MPESA_PASSKEY',
  'MPESA_CALLBACK_URL',
];

export function darajaConfigured() {
  return requiredConfig.every((key) => Boolean(process.env[key]));
}

function apiBase() {
  return process.env.MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';
}

function timestamp() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}${values.hour}${values.minute}${values.second}`;
}

async function darajaResponse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.errorMessage || body.error || 'Daraja request failed.');
    error.status = response.status;
    throw error;
  }
  return body;
}

async function accessToken() {
  const credentials = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`,
  ).toString('base64');
  const response = await fetch(`${apiBase()}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` },
    signal: AbortSignal.timeout(12_000),
  });
  const body = await darajaResponse(response);
  if (!body.access_token) throw new Error('Daraja did not return an access token.');
  return body.access_token;
}

export async function initiateStkPush({ phone, amount, entryId }) {
  if (!darajaConfigured()) {
    const error = new Error('Live M-Pesa is not configured. Add the Daraja server environment variables.');
    error.status = 503;
    throw error;
  }

  const token = await accessToken();
  const time = timestamp();
  const shortcode = process.env.MPESA_SHORTCODE;
  const password = Buffer.from(`${shortcode}${process.env.MPESA_PASSKEY}${time}`).toString('base64');
  const response = await fetch(`${apiBase()}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: time,
      TransactionType: process.env.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: phone,
      PartyB: shortcode,
      PhoneNumber: phone,
      CallBackURL: process.env.MPESA_CALLBACK_URL,
      AccountReference: 'DettySpin',
      TransactionDesc: `Detty Dezemba entry ${entryId.slice(0, 8)}`,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await darajaResponse(response);
  if (body.ResponseCode !== '0') {
    throw new Error(body.ResponseDescription || 'M-Pesa could not start this payment.');
  }
  return body;
}
