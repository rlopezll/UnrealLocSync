const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const config = require('../config.json');
const { shouldIncludeSheet, parseSheet, generate, verifyManifest,
  outputsCurrent } = require('../index.js');

test('ignores Format text and sheet names starting with _', () => {
  const format = config.format;
  assert.equal(shouldIncludeSheet({ title: 'Format text' }, format), false);
  assert.equal(shouldIncludeSheet({ title: '_Notas' }, format), false);
  assert.equal(shouldIncludeSheet({ title: 'Intro' }, format), true);
});

test('reads an offset header and keeps the first duplicate key', () => {
  const rows = [
    [],
    [],
    ['', 'Key', 'en', 'es'],
    ['', 'Start', 'Start', 'Empezar'],
    ['', 'Start', 'Again', 'Otra vez'],
    ['', 'Exit', 'Exit', 'Salir'],
  ];
  const sheet = parseSheet({ title: 'Intro', sheetId: 7 }, rows, config.format);
  assert.equal(sheet.entries.length, 2);
  assert.deepEqual(sheet.duplicates, [{ key: 'Start', firstRow: 4, row: 5, col: 1 }]);
  assert.deepEqual(sheet.languages.map(item => item.culture), ['en', 'es-ES']);
});

test('generates PO and CSV with escaped quotes and newlines', () => {
  const rows = [
    ['Key', 'en', 'es'],
    ['Quote', 'Say "hello"', 'Di "hola"'],
    ['Line', 'Two lines', 'Dos\nlíneas'],
  ];
  const sheet = parseSheet({ title: 'Intro', sheetId: 7 }, rows, config.format);
  const csvOutput = structuredClone(config.output);
  csvOutput.stringTables.mode = 'csv';
  const output = generate([sheet], config.format, csvOutput, config.unreal);
  const contents = [...output.files.entries()];
  const es = contents.find(([filename]) => filename.endsWith(path.join('es-ES', 'Game.po')))?.[1];
  const csv = contents.find(([filename]) => filename.endsWith('Intro.csv'))?.[1];
  assert.match(es, /msgid "Say \\"hello\\""/);
  assert.match(es, /msgctxt "Intro,Quote"/);
  assert.match(es, /msgstr "Di \\"hola\\""/);
  assert.match(es, /msgid "Two lines"/);
  assert.match(csv, /"Say ""hello"""/);
  assert.match(csv, /"Two lines"/);
});

test('generates English source data and independent Unreal configs', () => {
  const sheet = parseSheet({ title: 'Intro', sheetId: 7 },
    [['Key', 'en', 'es'], ['Start', 'Start', 'Empezar']], config.format);
  const generated = generate([sheet], config.format, config.output, config.unreal);
  const data = JSON.parse([...generated.files.entries()]
    .find(([filename]) => filename.endsWith('StringTables.json'))[1]);
  const gather = [...generated.files.entries()]
    .find(([filename]) => filename.endsWith('UnrealLocSync_Gather.ini'))[1];
  const importConfig = [...generated.files.entries()]
    .find(([filename]) => filename.endsWith('UnrealLocSync_Import.ini'))[1];
  const reportsConfig = [...generated.files.entries()]
    .find(([filename]) => filename.endsWith('UnrealLocSync_Reports.ini'))[1];
  const compileConfig = [...generated.files.entries()]
    .find(([filename]) => filename.endsWith('UnrealLocSync_Compile.ini'))[1];
  const esPo = [...generated.files.entries()]
    .find(([filename]) => filename.endsWith(path.join('es-ES', 'Game.po')))[1];
  assert.deepEqual(data.tables[0], {
    namespace: 'Intro', assetName: 'ST_Intro',
    entries: [{ key: 'Start', source: 'Start' }]
  });
  assert.match(gather, /CommandletClass=GatherTextFromAssets/);
  assert.match(gather, /NativeCulture=en/);
  assert.match(importConfig, /NativeCulture=en/);
  assert.match(reportsConfig, /CommandletClass=GenerateTextLocalizationReport/);
  assert.match(compileConfig, /NativeCulture=en/);
  assert.match(esPo, /msgid "Start"/);
  assert.match(esPo, /msgstr "Empezar"/);
  assert.equal(generated.assetFiles.length, 1);
});

test('validates a UTF-16 manifest written by Unreal', () => {
  const sheet = parseSheet({ title: 'Intro', sheetId: 7 },
    [['Key', 'en', 'es'], ['Start', 'Start', 'Empezar']], config.format);
  const filename = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'unreallocsync-')), 'Game.manifest');
  const manifest = { Namespace: '', Subnamespaces: [{ Namespace: 'Intro',
    Children: [{ Source: { Text: 'Start' }, Keys: [{ Key: 'Start' }] }] }] };
  try {
    fs.writeFileSync(filename, Buffer.concat([
      Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(manifest), 'utf16le')]));
    assert.doesNotThrow(() => verifyManifest(filename, [sheet], config.format));
    manifest.Subnamespaces[0].Children[0].Source.Text = 'Incorrect';
    fs.writeFileSync(filename, Buffer.concat([
      Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(manifest), 'utf16le')]));
    assert.throws(() => verifyManifest(filename, [sheet], config.format),
      /is missing the source text/);
  } finally {
    fs.unlinkSync(filename);
    fs.rmdirSync(path.dirname(filename));
  }
});

test('reruns synchronization when a generated file changes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unreallocsync-'));
  const filename = path.join(directory, 'Gather.ini');
  const generated = { files: new Map([[filename, 'correct']]),
    assetFiles: [], locDir: directory };
  const output = { stringTables: { mode: 'csv' } };
  const unreal = { runGatherText: false };
  try {
    assert.equal(outputsCurrent(generated, [], config.format, output, unreal), false);
    fs.writeFileSync(filename, 'correct');
    assert.equal(outputsCurrent(generated, [], config.format, output, unreal), true);
    fs.writeFileSync(filename, 'incorrect');
    assert.equal(outputsCurrent(generated, [], config.format, output, unreal), false);
  } finally {
    fs.unlinkSync(filename);
    fs.rmdirSync(directory);
  }
});
