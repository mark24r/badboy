export function normalizeWebhookForwardUrl(value) {
  if (!value) return null;
  let url;
  try {
    url = new URL(String(value));
  } catch {
    const error = new Error('The existing Paystack webhook forwarding URL is invalid.');
    error.status = 500;
    throw error;
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    const error = new Error('The existing Paystack webhook forwarding URL must be HTTPS without embedded credentials.');
    error.status = 500;
    throw error;
  }
  url.hash = '';
  return url.toString();
}

export async function forwardPaystackWebhook({
  url,
  rawBody,
  signature,
  fetchImpl = fetch,
  timeoutMs = 10_000,
}) {
  const target = normalizeWebhookForwardUrl(url);
  if (!target || !rawBody || !signature) {
    const error = new Error('Signed webhook forwarding is not configured correctly.');
    error.status = 500;
    throw error;
  }

  let response;
  try {
    response = await fetchImpl(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-paystack-signature': String(signature),
      },
      body: rawBody,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const error = new Error('Could not reach the existing Paystack webhook receiver.');
    error.status = 502;
    error.cause = cause;
    throw error;
  }

  if (!response.ok) {
    const error = new Error(`The existing Paystack webhook receiver returned HTTP ${response.status}.`);
    error.status = 502;
    throw error;
  }
  return { ok: true, status: response.status };
}
