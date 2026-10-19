const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('../chatgpt_api');

test('usa el token de ChatGPT y lee eventos SSE aunque lleguen fragmentados', async () => {
  const oldFetch = global.fetch;
  const bytes = new TextEncoder().encode(
    'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"Hola"}\r\n\r\n' +
    'data: {"type":"response.completed"}\r\n\r\ndata: [DONE]\r\n\r\n');
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 21));
        controller.enqueue(bytes.slice(21, 79));
        controller.enqueue(bytes.slice(79));
        controller.close();
      },
    }) };
  };
  try {
    const client = createClient({ getAccessToken: async () => 'oauth-token' });
    const body = { model: 'gpt-6.1-sol', input: [{ role: 'user', content: 'Hola' }], store: false, stream: true };
    const events = [];
    for await (const event of await client.responses.create(body)) events.push(event);
    assert.equal(request.url, 'https://api.openai.com/v1/responses');
    assert.equal(request.options.headers.Authorization, 'Bearer oauth-token');
    assert.deepEqual(JSON.parse(request.options.body), body);
    assert.deepEqual(events.map(event => event.type), ['response.output_text.delta', 'response.completed']);
    assert.equal(events[0].delta, 'Hola');
  } finally {
    global.fetch = oldFetch;
  }
});

test('propaga los errores HTTP antes de escribir una traducción', async () => {
  const oldFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 429,
    text: async () => JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }) });
  try {
    const client = createClient({ getAccessToken: async () => 'oauth-token' });
    await assert.rejects(client.responses.create({}), /HTTP 429: subscription_sharing_usage_limit_exceeded/);
  } finally {
    global.fetch = oldFetch;
  }
});
