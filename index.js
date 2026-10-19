const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { google } = require('googleapis');
const config = require('./config.json');

function need(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing ' + name + ' in config.json.');
  return value;
}

function localPath(value, name) {
  return path.resolve(__dirname, need(value, name));
}

function within(root, relative, name) {
  const result = path.resolve(root, need(relative, name));
  const part = path.relative(root, result);
  if (part.startsWith('..') || path.isAbsolute(part)) {
    throw new Error(name + ' must be inside the Unreal project.');
  }
  return result;
}

function cell(row, index) {
  return String(row[index] ?? '');
}

function column(index) {
  let text = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    text = String.fromCharCode(65 + (n - 1) % 26) + text;
  }
  return text;
}

function quotedSheet(title) {
  return "'" + title.replace(/'/g, "''") + "'";
}

function shouldIncludeSheet(sheet, format) {
  return !format.ignoreSheetNames.includes(sheet.title) &&
    !format.ignoreSheetPrefixes.some(prefix => sheet.title.startsWith(prefix));
}

function escapeText(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n/g, '\\n').replace(/\t/g, '\\t');
}

function poContext(namespace, key) {
  return namespace.replace(/,/g, '\\,') + ',' + key.replace(/,/g, '\\,');
}

function csvCell(value) {
  const text = String(value).replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n').replace(/\t/g, '\\t')
    .replace(/"/g, '""');
  return '"' + text + '"';
}

function parseSheet(sheet, rows, format) {
  const first = rows.findIndex(row => row.some(value => String(value).trim() !== ''));
  if (first < 0) return null;
  const headers = rows[first].map(value => String(value).trim());
  const keyIndex = headers.indexOf(format.keyHeader);
  const sourceIndex = headers.indexOf(format.sourceLanguage);
  if (keyIndex < 0 || sourceIndex < 0) {
    throw new Error('Missing ' + format.keyHeader + ' and/or ' +
      format.sourceLanguage + ' column in ' + sheet.title + ', row ' + (first + 1) + '.');
  }
  if (headers.filter(value => value === format.keyHeader).length !== 1) {
    throw new Error('Duplicate Key column in ' + sheet.title + '.');
  }
  const languages = [];
  const cultures = new Set();
  for (let index = 0; index < headers.length; index++) {
    const header = headers[index];
    if (!header || header === format.keyHeader || header === (format.contextHeader || 'Context')) continue;
    const culture = format.cultures[header];
    if (!culture) throw new Error('Language ' + header + ' has no culture configured for ' + sheet.title + '.');
    if (cultures.has(culture)) throw new Error('Duplicate culture ' + culture + ' in ' + sheet.title + '.');
    cultures.add(culture);
    languages.push({ header, culture, index });
  }
  const entries = [];
  const duplicates = [];
  const seen = new Map();
  for (let rowIndex = first + 1; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (!row.some(value => String(value).trim() !== '')) continue;
    const key = cell(row, keyIndex).trim();
    if (!key) throw new Error('Empty Key at ' + sheet.title + '!' + column(keyIndex) + (rowIndex + 1) + '.');
    if (/[\r\n]/.test(key)) {
      throw new Error('Key contains a newline at ' + sheet.title + '!' + column(keyIndex) + (rowIndex + 1) + '.');
    }
    if (seen.has(key)) {
      duplicates.push({ key, firstRow: seen.get(key), row: rowIndex + 1, col: keyIndex });
      continue;
    }
    seen.set(key, rowIndex + 1);
    const translations = {};
    for (const language of languages) translations[language.header] = cell(row, language.index);
    entries.push({ key, row: rowIndex + 1, translations });
  }
  return { title: sheet.title, sheetId: sheet.sheetId, keyIndex, languages, entries, duplicates };
}

function generate(sheets, format, output, unreal) {
  const uproject = localPath(unreal.uproject, 'unreal.uproject');
  const projectRoot = path.dirname(uproject);
  const locDir = within(projectRoot, unreal.localizationDir, 'unreal.localizationDir');
  const files = new Map();
  const keys = [];
  const po = new Map();
  const tables = [];
  const filenames = new Set();
  for (const sheet of sheets) {
    const basename = sheet.title.replace(/[^a-zA-Z0-9_]/g, '_');
    if (!basename || filenames.has(basename.toLowerCase())) {
      throw new Error('Invalid or duplicate sheet name: ' + sheet.title);
    }
    filenames.add(basename.toLowerCase());
    const table = { namespace: sheet.title,
      assetName: need(output.stringTables.assetPrefix, 'output.stringTables.assetPrefix') + basename,
      entries: [] };
    for (const entry of sheet.entries) {
      const source = entry.translations[format.sourceLanguage];
      if (!source) throw new Error('Empty source text in ' + sheet.title + ', key ' + entry.key + '.');
      table.entries.push({ key: entry.key, source });
      keys.push('NSLOCTEXT("' + escapeText(sheet.title) + '", "' +
        escapeText(entry.key) + '", "' + escapeText(source) + '");');
      const line = keys.length;
      for (const language of sheet.languages) {
        if (!po.has(language.culture)) po.set(language.culture, []);
        po.get(language.culture).push(
          '#. Key:\t' + entry.key + '\n' +
          '#. SourceLocation:\t' + output.sourceLocation + ':' + line + '\n' +
          '#: ' + output.sourceLocation + ':' + line + '\n' +
          'msgctxt "' + escapeText(poContext(sheet.title, entry.key)) + '"\n' +
          'msgid "' + escapeText(source) + '"\n' +
          'msgstr "' + escapeText(entry.translations[language.header]) + '"\n'
        );
      }
    }
    if (table.entries.length) tables.push(table);
  }
  files.set(within(locDir, output.keysFile, 'output.keysFile'), keys.join('\n') + '\n');
  for (const [culture, blocks] of po) {
    files.set(within(locDir, path.join(culture, output.poFile), 'PO file'),
      blocks.join('\n') + '\n');
  }
  if (output.stringTables.mode === 'csv') {
    const csvDir = within(projectRoot, output.stringTables.csvDir, 'output.stringTables.csvDir');
    for (const sheet of sheets) {
      const basename = sheet.title.replace(/[^a-zA-Z0-9_]/g, '_');
      const lines = ['Key,SourceString'];
      for (const entry of sheet.entries) {
        lines.push(csvCell(entry.key) + ',' + csvCell(entry.translations[format.sourceLanguage]));
      }
      files.set(within(csvDir, basename + '.csv', 'String Table CSV'), lines.join('\n') + '\n');
    }
  } else if (output.stringTables.mode === 'commandlet') {
    files.set(within(locDir, output.stringTables.dataFile, 'output.stringTables.dataFile'),
      JSON.stringify({ version: 1, tables }, null, 2) + '\n');
  } else {
    throw new Error('output.stringTables.mode must be csv or commandlet.');
  }
  if (unreal.runGatherText) {
    files.set(within(projectRoot, unreal.generatedGatherConfig, 'unreal.generatedGatherConfig'),
      buildGatherConfig(format, output, unreal));
    files.set(within(projectRoot, unreal.generatedImportConfig, 'unreal.generatedImportConfig'),
      buildImportConfig(format, output, unreal));
    files.set(within(projectRoot, unreal.generatedReportsConfig, 'unreal.generatedReportsConfig'),
      buildReportsConfig(format, output, unreal));
    files.set(within(projectRoot, unreal.generatedCompileConfig, 'unreal.generatedCompileConfig'),
      buildCompileConfig(format, output, unreal));
  }
  if (!/^\/Game\/[A-Za-z0-9_/]+$/.test(output.stringTables.assetPath)) {
    throw new Error('output.stringTables.assetPath must be a valid path under /Game/.');
  }
  const assetFiles = output.stringTables.mode === 'commandlet'
    ? tables.map(table => within(projectRoot,
      path.join('Content', output.stringTables.assetPath.replace(/^\/Game\//, ''),
        table.assetName + '.uasset'), 'String Table asset'))
    : [];
  return { files, projectRoot, locDir, uproject, assetFiles };
}

function buildGatherConfig(format, output, unreal) {
  const cultures = [...new Set(Object.values(format.cultures))];
  const lines = [
    '; Generated by UnrealLocSync. Do not edit this file.',
    '[CommonSettings]',
    'SourcePath=' + unreal.localizationDir.replace(/\\/g, '/'),
    'DestinationPath=' + unreal.localizationDir.replace(/\\/g, '/'),
    'ManifestName=' + output.manifestFile,
    'ArchiveName=' + unreal.archiveFile,
    'NativeCulture=' + format.cultures[format.sourceLanguage],
    ...cultures.map(culture => 'CulturesToGenerate=' + culture),
    '',
    '[GatherTextStep0]',
    'CommandletClass=GatherTextFromAssets',
    ...unreal.gatherAssetPaths.map(value => 'IncludePathFilters=' + value),
    'PackageFileNameFilters=*.uasset',
    '',
    '[GatherTextStep1]',
    'CommandletClass=GenerateGatherManifest',
    '',
    '[GatherTextStep2]',
    'CommandletClass=GenerateGatherArchive',
    ''
  ];
  return lines.join('\n');
}

function buildImportConfig(format, output, unreal) {
  const cultures = [...new Set(Object.values(format.cultures))];
  return [
    '; Generated by UnrealLocSync. Do not edit this file.',
    '[CommonSettings]',
    'SourcePath=' + unreal.localizationDir.replace(/\\/g, '/'),
    'DestinationPath=' + unreal.localizationDir.replace(/\\/g, '/'),
    'NativeCulture=' + format.cultures[format.sourceLanguage],
    ...cultures.map(culture => 'CulturesToGenerate=' + culture),
    'ManifestName=' + output.manifestFile,
    'ArchiveName=' + unreal.archiveFile,
    'PortableObjectName=' + output.poFile,
    '',
    '[GatherTextStep0]',
    'CommandletClass=InternationalizationExport',
    'bImportLoc=true',
    'LocalizedTextCollapseMode=ELocalizedTextCollapseMode::IdenticalTextIdAndSource',
    'POFormat=EPortableObjectFormat::Unreal',
    ''
  ].join('\n');
}

function buildReportsConfig(format, output, unreal) {
  const cultures = [...new Set(Object.values(format.cultures))];
  return [
    '; Generated by UnrealLocSync. Do not edit this file.',
    '[CommonSettings]',
    'SourcePath=' + unreal.localizationDir.replace(/\\/g, '/'),
    'DestinationPath=' + unreal.localizationDir.replace(/\\/g, '/'),
    'ManifestName=' + output.manifestFile,
    'ArchiveName=' + unreal.archiveFile,
    ...cultures.map(culture => 'CulturesToGenerate=' + culture),
    '',
    '[GatherTextStep0]',
    'CommandletClass=GenerateTextLocalizationReport',
    'bWordCountReport=true',
    'WordCountReportName=' + unreal.wordCountReportFile,
    'bConflictReport=true',
    'ConflictReportName=' + unreal.conflictReportFile,
    ''
  ].join('\n');
}

function buildCompileConfig(format, output, unreal) {
  const cultures = [...new Set(Object.values(format.cultures))];
  return [
    '; Generated by UnrealLocSync. Do not edit this file.',
    '[CommonSettings]',
    'SourcePath=' + unreal.localizationDir.replace(/\\/g, '/'),
    'DestinationPath=' + unreal.localizationDir.replace(/\\/g, '/'),
    'ManifestName=' + output.manifestFile,
    'ArchiveName=' + unreal.archiveFile,
    'ResourceName=' + unreal.resourceFile,
    'NativeCulture=' + format.cultures[format.sourceLanguage],
    ...cultures.map(culture => 'CulturesToGenerate=' + culture),
    'bSkipSourceCheck=false',
    'bValidateFormatPatterns=true',
    'bValidateSafeWhitespace=false',
    'bValidateRichTextTags=false',
    '',
    '[GatherTextStep0]',
    'CommandletClass=GenerateTextLocalizationResource',
    ''
  ].join('\n');
}

function readUnrealJson(filename) {
  const bytes = fs.readFileSync(filename);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return JSON.parse(bytes.subarray(2).toString('utf16le'));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return JSON.parse(Buffer.from(bytes.subarray(2)).swap16().toString('utf16le'));
  }
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
}

function verifyManifest(filename, sheets, format) {
  const manifest = readUnrealJson(filename);
  const found = new Map();
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.Namespace === 'string' && Array.isArray(node.Children)) {
      const keys = found.get(node.Namespace) ?? new Map();
      for (const child of node.Children) {
        for (const item of child.Keys ?? []) {
          if (typeof item.Key === 'string') keys.set(item.Key, child.Source?.Text);
        }
      }
      found.set(node.Namespace, keys);
    }
    for (const child of node.Subnamespaces ?? []) visit(child);
  }
  visit(manifest);
  for (const sheet of sheets) {
    for (const entry of sheet.entries) {
      if (found.get(sheet.title)?.get(entry.key) !== entry.translations[format.sourceLanguage]) {
        throw new Error('Game.manifest is missing the source text for ' + sheet.title + ',' + entry.key +
          '. Check the GatherText configuration and generated String Tables.');
      }
    }
  }
}

function outputsCurrent(generated, sheets, format, output, unreal) {
  try {
    for (const [filename, contents] of generated.files) {
      if (fs.readFileSync(filename, 'utf8') !== contents) return false;
    }
    if (!generated.assetFiles.every(filename => fs.existsSync(filename))) return false;
    if (unreal.runGatherText && output.stringTables.mode === 'commandlet') {
      verifyManifest(within(generated.locDir, output.manifestFile, 'output.manifestFile'),
        sheets, format);
      for (const culture of new Set(Object.values(format.cultures))) {
        if (!fs.existsSync(within(generated.locDir,
          path.join(culture, unreal.resourceFile), 'unreal.resourceFile'))) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function runUnreal(editor, uproject, projectRoot, args) {
  console.log('Unreal: ' + args.join(' '));
  const result = spawnSync(editor, [uproject, '-unattended', ...args], {
    cwd: projectRoot, stdio: 'inherit', windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Unreal exited with code ' + result.status + '.');
}

async function markDuplicates(api, spreadsheetId, sheets, color) {
  const requests = [];
  for (const sheet of sheets) {
    for (const duplicate of sheet.duplicates) {
      for (const row of [duplicate.firstRow, duplicate.row]) {
        requests.push({ repeatCell: {
          range: { sheetId: sheet.sheetId, startRowIndex: row - 1, endRowIndex: row,
            startColumnIndex: duplicate.col, endColumnIndex: duplicate.col + 1 },
          cell: { userEnteredFormat: { backgroundColor: color } },
          fields: 'userEnteredFormat.backgroundColor'
        } });
      }
    }
  }
  if (requests.length) {
    await api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
    console.log('Cells marked for duplicate keys: ' + requests.length);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--check', '--apply', '--force'].includes(arg)) ||
      (args.includes('--check') && args.includes('--apply'))) {
    throw new Error('Usage: node index.js [--check | --apply] [--force]');
  }
  const apply = args.includes('--apply');
  const { google: account, format, output, unreal } = config;
  const credentials = localPath(account.credentialsFile, 'google.credentialsFile');
  const spreadsheetId = need(account.spreadsheetId, 'google.spreadsheetId');
  if (!fs.existsSync(credentials)) throw new Error('Credentials file does not exist: ' + credentials);
  if (!Array.isArray(account.scopes) || account.scopes.length === 0) {
    throw new Error('Missing google.scopes in config.json.');
  }
  const auth = new google.auth.GoogleAuth({ keyFile: credentials, scopes: account.scopes });
  const api = google.sheets({ version: need(account.apiVersion, 'google.apiVersion'), auth });
  const metadata = await api.spreadsheets.get({ spreadsheetId,
    fields: 'spreadsheetId,properties(title),sheets(properties(sheetId,title))' });
  const allSheets = (metadata.data.sheets ?? []).map(item => item.properties);
  const included = allSheets.filter(sheet => shouldIncludeSheet(sheet, format));
  console.log('Spreadsheet: ' + metadata.data.properties.title);
  console.log('Sheets: ' + included.map(sheet => sheet.title).join(', '));
  const sourceData = [];
  const sheets = [];
  for (const sheet of included) {
    const response = await api.spreadsheets.values.get({ spreadsheetId,
      range: quotedSheet(sheet.title), valueRenderOption: 'FORMATTED_VALUE' });
    const rows = response.data.values ?? [];
    sourceData.push({ title: sheet.title, rows });
    const parsed = parseSheet(sheet, rows, format);
    if (parsed) sheets.push(parsed);
  }
  if (!sheets.some(sheet => sheet.entries.length)) throw new Error('No keys to export.');
  const generated = generate(sheets, format, output, unreal);
  for (const sheet of sheets) {
    console.log(sheet.title + ': ' + sheet.entries.length + ' keys; languages: ' +
      sheet.languages.map(language => language.header).join(', '));
    for (const duplicate of sheet.duplicates) {
      console.warn('Duplicate: ' + sheet.title + '!' + column(duplicate.col) +
        duplicate.firstRow + ' and ' + column(duplicate.col) + duplicate.row + ': ' + duplicate.key);
    }
  }
  console.log('Planned files: ' + generated.files.size);
  if (!apply) {
    console.log('Check completed without changing files or cells.');
    return;
  }
  const editor = localPath(unreal.editorPath, 'unreal.editorPath');
  if (!fs.existsSync(generated.uproject)) throw new Error('Project file does not exist: ' + generated.uproject);
  if ((unreal.runGatherText || output.stringTables.mode === 'commandlet') && !fs.existsSync(editor)) {
    throw new Error('Unreal editor executable does not exist: ' + editor);
  }
  if (unreal.runGatherText) {
    for (const ini of unreal.gatherConfigs) {
      const fullPath = within(generated.projectRoot, ini, 'unreal.gatherConfigs');
      if (!generated.files.has(fullPath) && !fs.existsSync(fullPath)) {
        throw new Error('GatherText configuration does not exist: ' + ini);
      }
    }
  }
  const cachePath = localPath(output.cacheFile, 'output.cacheFile');
  const hash = crypto.createHash('sha256').update(JSON.stringify({
    spreadsheetId, sourceData, format, output, unreal
  })).digest('hex');
  let oldHash = null;
  if (fs.existsSync(cachePath)) {
    try { oldHash = JSON.parse(fs.readFileSync(cachePath, 'utf8')).hash; } catch { /* Rebuild. */ }
  }
  if (oldHash === hash && !args.includes('--force') &&
      outputsCurrent(generated, sheets, format, output, unreal)) {
    console.log('No changes. Use --force to run the synchronization again.');
    return;
  }
  if (output.markDuplicates) {
    await markDuplicates(api, spreadsheetId, sheets, output.duplicateColor);
  }
  for (const [filename, contents] of generated.files) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents, 'utf8');
    console.log('Written: ' + filename);
  }
  if (output.stringTables.mode === 'commandlet') {
    const dataFile = within(generated.locDir, output.stringTables.dataFile,
      'output.stringTables.dataFile');
    runUnreal(editor, generated.uproject, generated.projectRoot,
      ['-run=' + need(output.stringTables.commandlet, 'output.stringTables.commandlet'),
        '-DataJson=' + dataFile,
        '-AssetPath=' + need(output.stringTables.assetPath, 'output.stringTables.assetPath')]);
  }
  if (unreal.runGatherText) {
    for (const ini of unreal.gatherConfigs) {
      runUnreal(editor, generated.uproject, generated.projectRoot,
        ['-run=' + need(unreal.gatherCommandlet, 'unreal.gatherCommandlet'),
          '-config=' + ini.replace(/\\/g, '/')]);
      if (output.stringTables.mode === 'commandlet' && ini === unreal.generatedGatherConfig) {
        verifyManifest(within(generated.locDir, output.manifestFile, 'output.manifestFile'), sheets, format);
      }
    }
  }
  fs.writeFileSync(cachePath, JSON.stringify({ hash, spreadsheetId,
    updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  console.log('Synchronization completed.');
}

if (require.main === module) {
  main().catch(error => {
    const status = error.response?.status;
    const message = error.response?.data?.error?.message ?? error.message;
    console.error('Error' + (status ? ' HTTP ' + status : '') + ': ' + message);
    process.exitCode = 1;
  });
}

module.exports = { shouldIncludeSheet, parseSheet, generate, buildGatherConfig,
  buildImportConfig, buildReportsConfig, buildCompileConfig, verifyManifest,
  outputsCurrent, escapeText, csvCell };
