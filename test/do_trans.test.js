const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, planRow, run, translate } = require('../do_trans');

const testConfig = {
  google: { spreadsheetId: 'test-sheet' },
  translation: {},
  format: { ignoreSheetNames: ['Format text'], ignoreSheetPrefixes: ['_'] },
};

const rows = [
  [],
  ['Category', 'Key', 'en', 'es', 'fr'],
  ['UI', 'StartButton', 'Start {player}', 'Iniciar {player}', ''],
];

test('solo admite el inicio de sesión de ChatGPT', () => {
  assert.equal(parseArgs(['--login']).login, true);
  assert.throws(() => parseArgs(['--new-account']), /requiere --login/);
  assert.throws(() => parseArgs(['--provider', 'api']), /Argumento desconocido/);
});

test('ChatGPT usa Responses en streaming y espera a response.completed', async () => {
  const plan = planRow(rows, parseArgs(['--sheet', 'UI', '--row', '3', '--langs', 'fr']));
  let request;
  const client = { responses: { create: async input => {
    request = input;
    return (async function* () {
      yield { type: 'response.output_text.delta', delta: '{"fr":"Démarrer {player}"}' };
      yield { type: 'response.completed' };
    })();
  } } };
  assert.deepEqual(await translate(client, 'gpt-6.1-sol', plan),
    { fr: 'Démarrer {player}' });
  assert.equal(request.store, false);
  assert.equal(request.stream, true);
  assert.deepEqual(JSON.parse(request.input[0].content).targetLanguages, ['fr']);
  assert.equal(request.model, 'gpt-6.1-sol');
  const broken = { responses: { create: async () => (async function* () {
    yield { type: 'response.output_text.delta', delta: '{"fr":"Démarrer"}' };
  })() } };
  await assert.rejects(translate(broken, 'gpt-6.1-sol', plan), /sin confirmación/);
});

test('selecciona solo las traducciones vacías y exige idiomas existentes', () => {
  const options = parseArgs(['--sheet', 'UI', '--row', '3', '--langs', 'es,fr']);
  const plan = planRow(rows, options);
  assert.equal(plan.source, 'Start {player}');
  assert.deepEqual(plan.pending.map(item => item.lang), ['fr']);
  assert.deepEqual(plan.skipped.map(item => item.lang), ['es']);
  assert.throws(() => planRow(rows, { ...options, langs: ['de'] }), /No existe la columna de/);
});

test('escribe solo la celda de destino, con la hoja escapada', async () => {
  const calls = [];
  const sheets = { spreadsheets: { values: {
    get: async request => {
      calls.push(['get', request]);
      return { data: { values: request.range.includes('A3:') ? [rows[2]] : rows } };
    },
    batchUpdate: async request => { calls.push(['write', request]); },
  } } };
  const chatgpt = { responses: { create: async request => {
    calls.push(['translate', request]);
    return (async function* () {
      yield { type: 'response.output_text.delta', delta: JSON.stringify({ fr: 'Démarrer {player}' }) };
      yield { type: 'response.completed' };
    })();
  } } };
  const options = parseArgs(['--sheet', "L'interface", '--row', '3', '--langs', 'es,fr']);
  await run(options, testConfig, { sheets, chatgpt });
  assert.equal(calls[0][1].range, "'L''interface'!A1:ZZ3");
  assert.deepEqual(JSON.parse(calls[1][1].input[0].content).targetLanguages, ['fr']);
  assert.equal(calls[1][1].store, false);
  assert.equal(calls[1][1].stream, true);
  assert.deepEqual(calls[3][1].requestBody.data, [
    { range: "'L''interface'!E3", values: [['Démarrer {player}']] },
  ]);
});

test('si todos los idiomas tienen texto, no llama a OpenAI ni escribe', async () => {
  let translations = 0;
  let writes = 0;
  const sheets = { spreadsheets: { values: {
    get: async () => ({ data: { values: rows } }),
    batchUpdate: async () => { writes++; },
  } } };
  const chatgpt = { responses: { create: async () => { translations++; } } };
  const options = parseArgs(['--sheet', 'UI', '--row', '3', '--langs', 'es']);
  await run(options, testConfig, { sheets, chatgpt });
  assert.equal(translations, 0);
  assert.equal(writes, 0);
});

test('la vista previa no escribe', async () => {
  let writes = 0;
  const sheets = { spreadsheets: { values: {
    get: async () => ({ data: { values: rows } }),
    batchUpdate: async () => { writes++; },
  } } };
  const chatgpt = { responses: { create: async () => (async function* () {
    yield { type: 'response.output_text.delta', delta: '{"fr":"Démarrer"}' };
    yield { type: 'response.completed' };
  })() } };
  const options = parseArgs(['--sheet', 'UI', '--row', '3', '--langs', 'fr', '--dry-run']);
  await run(options, testConfig, { sheets, chatgpt });
  assert.equal(writes, 0);
});

test('cancela la escritura si la fila cambia durante la llamada a OpenAI', async () => {
  let writes = 0;
  const sheets = { spreadsheets: { values: {
    get: async request => ({ data: { values: request.range.includes('A3:')
      ? [['UI', 'StartButton', 'Start {player}', 'Iniciar {player}', 'Démarrer']]
      : rows } }),
    batchUpdate: async () => { writes++; },
  } } };
  const chatgpt = { responses: { create: async () => (async function* () {
    yield { type: 'response.output_text.delta', delta: '{"fr":"Démarrer {player}"}' };
    yield { type: 'response.completed' };
  })() } };
  const options = parseArgs(['--sheet', 'UI', '--row', '3', '--langs', 'fr']);
  await assert.rejects(
    run(options, testConfig, { sheets, chatgpt }),
    /cambió mientras se traducía/,
  );
  assert.equal(writes, 0);
});

test('sin --sheet ni --row recorre todas las hojas y filas, enviando solo celdas vacías', async () => {
  const sheetRows = {
    UI: [[], ['Key', 'en', 'Context', 'es', 'fr'],
      ['Start', 'Start', 'Label on the main menu', 'Iniciar', ''],
      ['Exit', 'Exit', 'Button that closes the game', '', 'Quitter']],
    Menu: [['Key', 'en', 'es'], ['Play', 'Play', '']],
    Notes: [['Notes'], ['No localization here']],
  };
  const calls = [];
  const sheets = { spreadsheets: {
    get: async () => ({ data: { sheets: Object.keys(sheetRows).map(title => ({ properties: { title } })) } }),
    values: {
      get: async ({ range }) => {
        const title = range.slice(1, range.indexOf("'!"));
        const selected = sheetRows[title];
        const match = range.match(/!A(\d+):ZZ(\d+)$/);
        return { data: { values: match ? [selected[Number(match[1]) - 1]] : selected } };
      },
      batchUpdate: async request => { calls.push(['write', request.requestBody.data]); },
    },
  } };
  const chatgpt = { responses: { create: async request => {
    const payload = JSON.parse(request.input[0].content);
    const langs = payload.targetLanguages;
    calls.push(['translate', payload]);
    return (async function* () {
      yield { type: 'response.output_text.delta', delta: JSON.stringify(Object.fromEntries(langs.map(lang => [lang, `translated-${lang}`]))) };
      yield { type: 'response.completed' };
    })();
  } } };
  const options = parseArgs(['--langs', 'es,fr', '--context', 'Fantasy game']);
  const total = await run(options, testConfig, { sheets, chatgpt });
  assert.equal(total, 3);
  const requests = calls.filter(call => call[0] === 'translate').map(call => call[1]);
  assert.deepEqual(requests.map(request => request.targetLanguages), [['fr'], ['es'], ['es']]);
  assert.deepEqual(requests.map(request => request.context), [
    'Label on the main menu', 'Button that closes the game', '',
  ]);
  assert.deepEqual(requests.map(request => request.generalContext), [
    'Fantasy game', 'Fantasy game', 'Fantasy game',
  ]);
  assert.deepEqual(calls.filter(call => call[0] === 'write').flatMap(call => call[1].map(item => item.range)), [
    "'UI'!E3", "'UI'!D4", "'Menu'!C2",
  ]);
});
