# UnrealLocSync

UnrealLocSync reads a Google spreadsheet, creates Unreal String Table assets, and imports translations. English is the source language and native culture in the supplied configuration. The application code is in `index.js`; project-specific values are in `config.json`.

## Contents

- [Quick start](#quick-start)
- [First run in a new Unreal project](#first-run-in-a-new-unreal-project)
- [Plugin installation](#plugin-installation)
- [Spreadsheet format](#spreadsheet-format)
- [Configuration reference](#configuration-reference)
  - [Google connection](#google-connection)
  - [Spreadsheet parsing](#spreadsheet-parsing)
  - [Generated output](#generated-output)
  - [Unreal project and localization pipeline](#unreal-project-and-localization-pipeline)
- [Google credentials](#google-credentials)
- [Generated files and behavior](#generated-files-and-behavior)
- [Minimal smoke test](#minimal-smoke-test)
- [Verify the result in Unreal](#verify-the-result-in-unreal)
- [Package the translations](#package-the-translations)
- [Troubleshooting](#troubleshooting)

## Quick start

1. Clone this repository and run `npm ci` with Node.js 22 or later.
2. Create a Google spreadsheet with at least one included tab and a `Key`, `en`, `es` header row. See [Spreadsheet format](#spreadsheet-format).
3. Create a Google Cloud service account, enable the Sheets API, save its JSON key as `credentials.json`, and share the spreadsheet with the service account. See [Google credentials](#google-credentials).
4. Copy and enable the bundled plugin in the Unreal project. See [Plugin installation](#plugin-installation).
5. Replace the example spreadsheet ID and Unreal paths in `config.json`, then set the project's Game localization target to English native culture. See [First run in a new Unreal project](#first-run-in-a-new-unreal-project).
6. Run `npm run check`, then `npm run sync` from this repository.
7. Confirm that the String Table and compiled translation exist, then reference a table entry in a Text property. See [Verify the result in Unreal](#verify-the-result-in-unreal).

Use `node index.js --apply --force` to rerun the full pipeline even when the spreadsheet is unchanged. A successful run writes `.cache.json`. Later runs also check the generated files, assets, resources, and manifest before using the cache.

## First run in a new Unreal project

Follow these steps in order when testing with a clean project. You do not need to create a String Table asset or a `Game.manifest` by hand.

1. Create an Unreal project and note the full path to its `.uproject`. Install a C++ toolchain supported by that Unreal Engine version so the source plugin can compile. Close the editor before the first synchronization.
2. Clone this repository. In its root directory, run `npm ci`. The clone does not include `credentials.json` or `.cache.json`.
3. [Copy and enable the plugin](#plugin-installation) at `<YOUR_PROJECT>/Plugins/UnrealLocSync`. Reopen the project and let Unreal compile it if prompted. Close the editor again before running the commandlets.
4. Create a Google spreadsheet. Rename one tab to `UI`; enter this minimal example starting at cell A1:

   | Key | en | es |
   | --- | --- | --- |
   | Play | Play | Jugar |
   | Quit | Quit | Salir |

   The tab name `UI` becomes the namespace and the generated asset is `ST_UI`. A tab named `Format text` or beginning with `_` is skipped. See [Spreadsheet format](#spreadsheet-format) for the complete rules.

5. [Create a service account and enable the Google Sheets API](#google-credentials). Download its JSON key to this repository as `credentials.json`. Share the spreadsheet with the service account's `client_email`. With the supplied `output.markDuplicates: true`, give it Editor access if you want duplicate keys colored; otherwise set `output.markDuplicates` to `false` and Viewer access is sufficient.
6. Edit the existing `config.json`. Its supplied `google.spreadsheetId` and `unreal.uproject`/`unreal.editorPath` point to the original example environment; replace all three. Copy the ID between `/d/` and `/edit` in the sheet URL, not the numeric `gid`. Point `unreal.editorPath` to the `UnrealEditor-Cmd.exe` belonging to the engine used by the new project. Keep `google.credentialsFile` as `./credentials.json` if you used the location above.
7. Keep the supplied `format.sourceLanguage: "en"` and `format.cultures` mapping `en` to `en` and `es` to `es-ES` for this example. Keep `output.stringTables.assetPath: "/Game/Localization/StringTables"` and `unreal.gatherAssetPaths: ["Content/Localization/StringTables/*"]` aligned. Change other paths only if your project uses a different layout. The [configuration reference](#configuration-reference) lists every setting.
8. In Unreal, open **Tools > Localization Dashboard** ([Epic guide](https://dev.epicgames.com/documentation/en-us/unreal-engine/localization-tools-in-unreal-engine)). Use the **Game** target (create it with Game loading policy if it is absent). Set its native culture to `en` and add `es-ES` as a supported culture. Save the project settings. The Node.js tool runs the gather, import, and compile commandlets; you do not need to run those Dashboard actions manually.
9. Run `npm run check` from this repository. Expect the spreadsheet name, `Sheets: UI`, and `UI: 2 keys; languages: en, es`, followed by `Check completed without changing files or cells.` If this fails, fix the credentials, sheet format, or configuration before syncing.
10. Close Unreal Editor and run `npm run sync`. Expect a `Saved String Table /Game/Localization/StringTables/ST_UI (2 entries)` message and `Synchronization completed.` The tool creates the String Table, gathers English source text, imports the PO translations, and compiles `.locres` files.
11. [Verify the asset, the translation files, and a Text property](#verify-the-result-in-unreal). When the sheet changes, rerun `npm run sync`; use `node index.js --apply --force` to force a complete rerun.

## Plugin installation

This repository includes the Node.js tool at its root and the Unreal Editor plugin at `Plugins/UnrealLocSync`. The plugin creates String Table assets from the JSON file generated by the Node.js tool.

1. Copy the entire `Plugins/UnrealLocSync` directory from this repository to `<YOUR_PROJECT>/Plugins/UnrealLocSync`. Create the project's `Plugins` directory if it does not exist. The destination must contain `UnrealLocSync.uplugin` and `Source/UnrealLocSync`.
2. Open the project's `.uproject` in Unreal Editor. Enable **Unreal Localization Sync** in **Edit > Plugins** if it is not already enabled, then restart the editor. The plugin declares **Editor Scripting Utilities** as a dependency.
3. Let Unreal rebuild the plugin for the project's engine version when prompted. A working C++ toolchain is required. This repository ships plugin source; `Binaries` and `Intermediate` are excluded.
4. Set the localization target's native culture in Unreal's Localization Dashboard to the culture mapped from `format.sourceLanguage` (the supplied configuration uses `en`).
5. Configure `unreal.uproject` and `unreal.editorPath` in `config.json` for this project. Check that `output.stringTables.assetPath` and `unreal.gatherAssetPaths` point to the intended String Table content directory.

Run `npm run check` and then `npm run sync` from the repository root. The plugin is an editor module used during synchronization.

## Spreadsheet format

Each included tab becomes one String Table. Its name is the localization namespace. The first nonempty row contains the headers, so the table may start at a cell such as B3. Header names are case-sensitive.

| Key | en | es |
| --- | --- | --- |
| Menu_Play | Play | Jugar |
| Menu_Quit | Quit | Salir |

- `Key` and the configured source language column (`en`) are required. Each data row needs a unique, nonempty key and nonempty English source text.
- Additional language headers must appear in `format.cultures`. The supplied mapping writes `en` to culture `en` and `es` to `es-ES`.
- Completely empty rows and tabs are skipped. Other unexpected headers are treated as language headers and cause an error.
- The tab named exactly `Format text` and tabs whose names start with `_` are ignored. These rules are configurable.
- If a key repeats within a tab, the first row is used. During `--apply`, both Key cells are colored red when `output.markDuplicates` is true. The tool does not read cell colors or clear old marks.
- Tab names are converted to asset-safe names by replacing unsupported characters with `_`. Two tabs that would produce the same asset name are rejected.

English text from the `en` column becomes the source text in each String Table, the PO `msgid`, and the native `en` culture. The `es` column supplies Spanish translations.

To add a language, add a column such as `fr` to the spreadsheet tabs you want to translate, map its header in `format.cultures` (for example, `"fr": "fr-FR"`), and add `fr-FR` to the **Game** target's cultures in Unreal's Localization Dashboard. Keep `en` as the source language, then run `npm run check` and `npm run sync`. For packaged builds, also include the new culture under **Localizations to Package** and select Internationalization Support that covers it.

## Configuration reference

The following example contains **every setting read from `config.json`**. Replace the spreadsheet ID, credentials path, Unreal project path, editor executable path, and any output or culture settings that differ in your project. JSON does not support comments, so explanations follow the example.

```json
{
  "google": {
    "credentialsFile": "./credentials.json",
    "spreadsheetId": "<SPREADSHEET_ID>",
    "apiVersion": "v4",
    "scopes": ["https://www.googleapis.com/auth/spreadsheets"]
  },
  "format": {
    "ignoreSheetNames": ["Format text"],
    "ignoreSheetPrefixes": ["_"],
    "keyHeader": "Key",
    "sourceLanguage": "en",
    "cultures": {
      "en": "en",
      "es": "es-ES"
    }
  },
  "output": {
    "keysFile": "keys.h",
    "poFile": "Game.po",
    "sourceLocation": "Content/Localization/Game/keys.h",
    "manifestFile": "Game.manifest",
    "cacheFile": "./.cache.json",
    "markDuplicates": true,
    "duplicateColor": { "red": 1, "green": 0, "blue": 0 },
    "stringTables": {
      "mode": "commandlet",
      "csvDir": "Content/Localization/StringTables",
      "dataFile": "StringTables.json",
      "assetPath": "/Game/Localization/StringTables",
      "assetPrefix": "ST_",
      "commandlet": "CreateStringTablesCommandlet"
    }
  },
  "unreal": {
    "uproject": "D:/Projects/MyGame/MyGame.uproject",
    "editorPath": "D:/UnrealEngine/Engine/Binaries/Win64/UnrealEditor-Cmd.exe",
    "localizationDir": "Content/Localization/Game",
    "runGatherText": true,
    "gatherCommandlet": "GatherText",
    "archiveFile": "Game.archive",
    "resourceFile": "Game.locres",
    "wordCountReportFile": "Game.csv",
    "conflictReportFile": "Game_Conflicts.txt",
    "generatedGatherConfig": "Config/Localization/UnrealLocSync_Gather.ini",
    "generatedImportConfig": "Config/Localization/UnrealLocSync_Import.ini",
    "generatedReportsConfig": "Config/Localization/UnrealLocSync_Reports.ini",
    "generatedCompileConfig": "Config/Localization/UnrealLocSync_Compile.ini",
    "gatherAssetPaths": ["Content/Localization/StringTables/*"],
    "gatherConfigs": [
      "Config/Localization/UnrealLocSync_Gather.ini",
      "Config/Localization/UnrealLocSync_Import.ini",
      "Config/Localization/UnrealLocSync_Reports.ini",
      "Config/Localization/UnrealLocSync_Import.ini",
      "Config/Localization/UnrealLocSync_Compile.ini"
    ]
  }
}
```

### Google connection

| Setting | What to configure |
| --- | --- |
| `google.credentialsFile` | Path to the service account JSON key, relative to this Node.js directory unless absolute. Keep the key out of Git. |
| `google.spreadsheetId` | ID between `/d/` and `/edit` in the Google Sheets URL. Share that spreadsheet with the service account email. |
| `google.apiVersion` | Google Sheets API version. Use `v4`. |
| `google.scopes` | OAuth scopes requested by the service account. The supplied scope permits reading the sheet and coloring duplicate cells. |

### Spreadsheet parsing

| Setting | What to configure |
| --- | --- |
| `format.ignoreSheetNames` | Exact tab names to skip. |
| `format.ignoreSheetPrefixes` | Prefixes that cause a tab to be skipped. |
| `format.keyHeader` | Header used for localization keys. |
| `format.sourceLanguage` | Required header for source text. Use `en` for an English-native project. |
| `format.cultures` | Map each spreadsheet language header to an Unreal culture. Include the source language. Set the native culture through `format.sourceLanguage`, and use the same culture names in the Unreal Localization Dashboard target. |

### Generated output

| Setting | What to configure |
| --- | --- |
| `output.keysFile` | Legacy source reference file created inside `unreal.localizationDir`. |
| `output.poFile` | PO filename created in each culture subdirectory. |
| `output.sourceLocation` | Location written into PO comments. Keep it aligned with `unreal.localizationDir` and `output.keysFile`. |
| `output.manifestFile` | Manifest filename that GatherText generates and the tool verifies. |
| `output.cacheFile` | Local cache path, relative to this Node.js directory unless absolute. |
| `output.markDuplicates` | Whether `--apply` marks duplicate Key cells. Requires spreadsheet edit access when true. |
| `output.duplicateColor.red/green/blue` | Google Sheets RGB components from 0 to 1 for duplicate cells. |
| `output.stringTables.mode` | `commandlet` creates `.uasset` String Tables; `csv` only writes CSV files for manual import. |
| `output.stringTables.csvDir` | CSV directory relative to the Unreal project root, used in `csv` mode. |
| `output.stringTables.dataFile` | JSON input filename created inside `unreal.localizationDir` for the commandlet. |
| `output.stringTables.assetPath` | Unreal package path for String Table assets. Must start with `/Game/`. |
| `output.stringTables.assetPrefix` | Prefix added to sanitized tab names to form asset names, for example `ST_`. |
| `output.stringTables.commandlet` | Commandlet name supplied by the UnrealLocSync plugin. |

### Unreal project and localization pipeline

| Setting | What to configure |
| --- | --- |
| `unreal.uproject` | Absolute path to the target `.uproject`, or a path relative to this Node.js directory. |
| `unreal.editorPath` | Absolute or Node.js-directory-relative path to `UnrealEditor-Cmd.exe` for that project's engine version. |
| `unreal.localizationDir` | Localization target directory relative to the Unreal project root. |
| `unreal.runGatherText` | Run GatherText, PO import, reports, and resource compilation after creating String Tables. Keep `true` for translated `.locres` output. |
| `unreal.gatherCommandlet` | Unreal localization commandlet name; normally `GatherText`. |
| `unreal.archiveFile` | Archive filename within each culture's localization output. |
| `unreal.resourceFile` | Compiled resource filename within each culture's output. |
| `unreal.wordCountReportFile` | Name for the generated word-count report. |
| `unreal.conflictReportFile` | Name for the generated conflict report. |
| `unreal.generatedGatherConfig` | Project-relative path for the generated asset-gathering INI. |
| `unreal.generatedImportConfig` | Project-relative path for the generated PO-import INI. |
| `unreal.generatedReportsConfig` | Project-relative path for the generated reports INI. |
| `unreal.generatedCompileConfig` | Project-relative path for the generated resource-compilation INI. |
| `unreal.gatherAssetPaths` | Unreal content filters to gather. Include the directory represented by `output.stringTables.assetPath`; add other game assets if they should be localized into this target. |
| `unreal.gatherConfigs` | Project-relative INIs executed in order. The supplied order gathers assets, imports PO files, generates reports, imports PO files again, and compiles resources. Keep the generated paths in sync with the four settings above. |

The four `UnrealLocSync_*.ini` files are generated from `config.json` during `--apply`. The normal sync does not depend on an existing `Game.manifest` or the project's `Game_Gather.ini`. The plugin receives `StringTables.json` directly, then GatherText regenerates the manifest. The tool checks that the new manifest contains every key and its English source text before importing translations. The legacy `-ManifestLoc` commandlet option remains available for manual use with a valid manifest; `-ValidateOnly` checks input without creating assets.

When moving this tool to another Unreal project, also set that project's Localization Dashboard target native culture to the culture mapped from `format.sourceLanguage` (here `en`). The supplied Sewer13 project has been set to English.

## Google credentials

Use a Google Cloud service account; a separate Gmail account is unnecessary.

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project.
2. [Enable the Google Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com) for that project.
3. In [Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts), create a service account and copy its email address.
4. Under the service account's **Keys**, create a new JSON key. Save it at the path configured in `google.credentialsFile`.
5. Share the spreadsheet with the service account email. Viewer access is enough for reading. Editor access is needed to color duplicate keys when `output.markDuplicates` is true and duplicates are found; set it to `false` if the service account has Viewer access only.
6. Copy the spreadsheet ID from its URL into `google.spreadsheetId`.

See Google's [credential guide](https://developers.google.com/workspace/guides/create-credentials) and [Sheets API quickstart](https://developers.google.com/workspace/sheets/api/quickstart/nodejs). Keep `credentials.json` and `.cache.json` out of Git, and do not put the private key in `config.json`.

## Generated files and behavior

`--apply` writes `keys.h`, one PO file per culture, `StringTables.json`, four generated INIs, and String Table `.uasset` files. Unreal then generates the manifest, archives, reports, and `.locres` files. Any Unreal commandlet failure stops the process without updating the cache. A sheet or language removed later is not automatically deleted from previously generated project files; review those files when removing content.

## Minimal smoke test

Use this short test in a new Unreal project after following the installation and configuration steps above. It checks the plugin build, Google connection, generated asset, and a visible translation in that order.

1. Open the Unreal project with the copied plugin enabled. The editor must start without an **incompatible or missing module: UnrealLocSync** message. If compilation fails here, the Google spreadsheet and Node.js tool have not been tested yet.
2. In the shared spreadsheet, create an included tab named `UI` with this data:

   | Key | en | es |
   | --- | --- | --- |
   | Play | Play | Jugar |
   | Quit | Quit | Salir |

3. Set the spreadsheet ID and the new project's `unreal.uproject` and `unreal.editorPath` in `config.json`. Run `npm run check`; expect `Sheets: UI`, `UI: 2 keys; languages: en, es`, and `Check completed without changing files or cells.`
4. Close Unreal Editor and run `npm run sync`. Expect `Saved String Table /Game/Localization/StringTables/ST_UI (2 entries)` and `Synchronization completed.`
5. Reopen the project. Confirm that `Content/Localization/StringTables/ST_UI` contains the `Play` key and that `Content/Localization/Game/es-ES/Game.locres` exists.
6. In a Widget Blueprint, add a Text Block and select the `Play` entry from `ST_UI` using the String Table picker beside its Text property. Set **Preview Game Language** to `es-ES` in **Edit > Editor Preferences > General > Region & Language**. The text should display `Jugar`.

If all six steps pass, the basic English-to-Spanish flow works in that project. The [full first-run guide](#first-run-in-a-new-unreal-project) explains each setup step, and [Troubleshooting](#troubleshooting) covers common failures.

## Verify the result in Unreal

After `npm run sync` succeeds, check these locations in the new project:

| Location | Expected result for the `UI` example |
| --- | --- |
| Content Browser: `Content/Localization/StringTables` | `ST_UI` String Table asset with `Play` and `Quit` entries; the source text is English. |
| `Content/Localization/Game/Game.manifest` | Gathered English source text for namespace `UI`. |
| `Content/Localization/Game/es-ES/Game.po` | Spanish `msgstr` values such as `Jugar`. |
| `Content/Localization/Game/es-ES/Game.locres` | Compiled Spanish localization data used at runtime. |

To see a translation, create a Widget Blueprint with a Text Block. On its Text property, use the String Table picker (the white flag beside the text field) to select `ST_UI` and the `Play` key. In **Edit > Editor Preferences > General > Region & Language**, set **Preview Game Language** to Spanish (`es-ES`) and preview the widget or run Play in Editor. The text should display `Jugar`. A String Table asset existing in the Content Browser does not automatically replace arbitrary text: the Text property must reference its entry.

Epic documents [String Table references](https://dev.epicgames.com/documentation/en-us/unreal-engine/using-string-tables-for-text-in-unreal-engine) and the [Preview Game Language setting](https://dev.epicgames.com/documentation/unreal-engine/managing-the-active-culture-at-runtime).

## Package the translations

For a packaged build, open **Edit > Project Settings > Packaging** and include `en` and `es-ES` under **Localizations to Package**. Choose **Internationalization Support** that includes those cultures. Ensure the String Table asset is referenced by game content so it is cooked; if it is loaded only dynamically, configure that content directory to be cooked. These packaging settings are separate from the synchronization commandlets. See Epic's [Packaging Localization Data](https://dev.epicgames.com/documentation/en-us/unreal-engine/localization-overview-for-unreal-engine#packaginglocalizationdata) guidance.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Missing `credentials.json` or Google HTTP 403/404 | Confirm `google.credentialsFile`, the spreadsheet ID (not `gid`), the Sheets API, and sharing with the service account email. |
| `No keys to export` | Add a non-ignored tab with a `Key`/`en` header and at least one data row with English source text. |
| `Language ... has no culture configured` | Remove unexpected header columns or add their header-to-culture mapping in `format.cultures`. There is no `Category` column in the supplied format. |
| Unreal editor executable does not exist | Set `unreal.editorPath` to the new project's matching `UnrealEditor-Cmd.exe`. |
| Unreal cannot find `CreateStringTablesCommandlet` | Confirm that the bundled plugin is installed, enabled, and successfully compiled for that project. |
| `Game.manifest is missing the source text` | Confirm the String Table asset was saved and `unreal.gatherAssetPaths` includes its content directory. |
| String Table exists but Spanish is not visible | Confirm the Text property references the table entry, `es-ES/Game.locres` exists, and Preview Game Language is set to `es-ES`. |
