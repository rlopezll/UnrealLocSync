const RESPONSES_URL = 'https://api.openai.com/v1/responses';

function parseEvent(block) {
  const data = block.split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n');
  if (!data || data === '[DONE]') return null;
  return JSON.parse(data);
}

async function* responseEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      let boundary;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, boundary);
        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)[0];
        buffer = buffer.slice(boundary + separator.length);
        const event = parseEvent(block);
        if (event) yield event;
      }
      if (done) {
        const event = parseEvent(buffer);
        if (event) yield event;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function createClient(auth) {
  return { responses: { create: async request => {
    const token = await auth.getAccessToken();
    const response = await fetch(RESPONSES_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      const text = await response.text();
      let reason;
      try {
        const body = JSON.parse(text);
        reason = body.error?.code || body.error?.message || body.detail;
      } catch { /* The status remains available below. */ }
      throw new Error(`ChatGPT HTTP ${response.status}${reason ? `: ${String(reason).slice(0, 200)}` : ''}`);
    }
    if (!response.body) throw new Error('ChatGPT no devolvió un flujo de respuesta');
    return responseEvents(response.body);
  } } };
}

module.exports = { createClient, responseEvents };
