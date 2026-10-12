#include "CreateStringTablesCommandlet.h"
#include "UnrealLocSync.h"

#include "AssetRegistry/AssetData.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetToolsModule.h"
#include "Dom/JsonObject.h"
#include "Factories/StringTableFactory.h"
#include "Internationalization/StringTable.h"
#include "Internationalization/StringTableCore.h"
#include "Misc/CommandLine.h"
#include "Misc/EngineVersionComparison.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "PackageHelperFunctions.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/SoftObjectPath.h"

namespace
{
	const TCHAR* DefaultAssetPath = TEXT("/Game/Localization/StringTables");

	bool ReadRequiredString(const TSharedPtr<FJsonObject>& Object, const TCHAR* Field, FString& OutValue)
	{
		return Object.IsValid() && Object->TryGetStringField(Field, OutValue) && !OutValue.IsEmpty();
	}
}

int32 UCreateStringTablesCommandlet::Main(const FString& Params)
{
	FString InputFile;
	const bool bHasDataJson = FParse::Value(*Params, TEXT("-DataJson="), InputFile);
	if (!bHasDataJson && !FParse::Value(*Params, TEXT("-ManifestLoc="), InputFile))
	{
		UE_LOG(LogUnrealLocSync, Error, TEXT("Provide -DataJson=<file> or -ManifestLoc=<file>."));
		return 1;
	}

	Tables.Reset();
	if (!ParseInputFile(InputFile, !bHasDataJson))
	{
		return 1;
	}

	if (FParse::Param(*Params, TEXT("ValidateOnly")))
	{
		UE_LOG(LogUnrealLocSync, Display, TEXT("Validated %d String Tables."), Tables.Num());
		return 0;
	}

	FString AssetPath;
	if (!FParse::Value(*Params, TEXT("-AssetPath="), AssetPath))
	{
		AssetPath = DefaultAssetPath;
	}
	AssetPath.RemoveFromEnd(TEXT("/"));
	if (!FPackageName::IsValidLongPackageName(AssetPath))
	{
		UE_LOG(LogUnrealLocSync, Error, TEXT("Invalid asset path: %s"), *AssetPath);
		return 1;
	}

	return SaveStringTables(AssetPath) ? 0 : 1;
}

bool UCreateStringTablesCommandlet::ParseInputFile(const FString& Filename, const bool bLegacyManifest)
{
	FString JsonRaw;
	if (!FFileHelper::LoadFileToString(JsonRaw, *Filename))
	{
		UE_LOG(LogUnrealLocSync, Error, TEXT("Cannot read localization input: %s"), *Filename);
		return false;
	}

	TSharedPtr<FJsonObject> Root;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(JsonRaw);
	if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
	{
		UE_LOG(LogUnrealLocSync, Error, TEXT("Invalid localization JSON: %s"), *Filename);
		return false;
	}

	const TArray<TSharedPtr<FJsonValue>>* JsonTables = nullptr;
	if (!Root->TryGetArrayField(bLegacyManifest ? TEXT("Subnamespaces") : TEXT("tables"), JsonTables) || !JsonTables || JsonTables->IsEmpty())
	{
		UE_LOG(LogUnrealLocSync, Error, TEXT("No String Tables found in %s. Use -DataJson when Game.manifest is empty."), *Filename);
		return false;
	}

	TSet<FString> SeenAssets;
	for (const TSharedPtr<FJsonValue>& JsonTable : *JsonTables)
	{
		const TSharedPtr<FJsonObject> TableObject = JsonTable.IsValid() ? JsonTable->AsObject() : nullptr;
		FTableData Table;
		if (!ReadRequiredString(TableObject, bLegacyManifest ? TEXT("Namespace") : TEXT("namespace"), Table.Namespace))
		{
			UE_LOG(LogUnrealLocSync, Error, TEXT("String Table has no namespace in %s."), *Filename);
			return false;
		}
		if (bLegacyManifest)
		{
			Table.AssetName = TEXT("ST_") + Table.Namespace;
		}
		else if (!ReadRequiredString(TableObject, TEXT("assetName"), Table.AssetName))
		{
			UE_LOG(LogUnrealLocSync, Error, TEXT("String Table %s has no assetName."), *Table.Namespace);
			return false;
		}

		if (SeenAssets.Contains(Table.AssetName))
		{
			UE_LOG(LogUnrealLocSync, Error, TEXT("Duplicate String Table asset name: %s"), *Table.AssetName);
			return false;
		}
		SeenAssets.Add(Table.AssetName);

		const TArray<TSharedPtr<FJsonValue>>* JsonEntries = nullptr;
		if (!TableObject->TryGetArrayField(bLegacyManifest ? TEXT("Children") : TEXT("entries"), JsonEntries) || !JsonEntries || JsonEntries->IsEmpty())
		{
			UE_LOG(LogUnrealLocSync, Error, TEXT("String Table %s has no entries."), *Table.Namespace);
			return false;
		}

		TSet<FString> SeenKeys;
		for (const TSharedPtr<FJsonValue>& JsonEntry : *JsonEntries)
		{
			const TSharedPtr<FJsonObject> EntryObject = JsonEntry.IsValid() ? JsonEntry->AsObject() : nullptr;
			if (!EntryObject.IsValid())
			{
				UE_LOG(LogUnrealLocSync, Error, TEXT("Invalid entry in String Table %s."), *Table.Namespace);
				return false;
			}

			FString Source;
			if (bLegacyManifest)
			{
				const TSharedPtr<FJsonObject>* SourceObject = nullptr;
				if (!EntryObject->TryGetObjectField(TEXT("Source"), SourceObject) || !SourceObject ||
					!(*SourceObject).IsValid() || !(*SourceObject)->TryGetStringField(TEXT("Text"), Source))
				{
					UE_LOG(LogUnrealLocSync, Error, TEXT("Missing source text in String Table %s."), *Table.Namespace);
					return false;
				}

				const TArray<TSharedPtr<FJsonValue>>* JsonKeys = nullptr;
				if (!EntryObject->TryGetArrayField(TEXT("Keys"), JsonKeys) || !JsonKeys || JsonKeys->IsEmpty())
				{
					UE_LOG(LogUnrealLocSync, Error, TEXT("Missing keys in String Table %s."), *Table.Namespace);
					return false;
				}
				for (const TSharedPtr<FJsonValue>& JsonKey : *JsonKeys)
				{
					const TSharedPtr<FJsonObject> KeyObject = JsonKey.IsValid() ? JsonKey->AsObject() : nullptr;
					FKeyValue Entry;
					if (!ReadRequiredString(KeyObject, TEXT("Key"), Entry.Key) || SeenKeys.Contains(Entry.Key))
					{
						UE_LOG(LogUnrealLocSync, Error, TEXT("Invalid or duplicate key in String Table %s."), *Table.Namespace);
						return false;
					}
					Entry.Source = Source;
					SeenKeys.Add(Entry.Key);
					Table.Entries.Add(MoveTemp(Entry));
				}
			}
			else
			{
				FKeyValue Entry;
				if (!ReadRequiredString(EntryObject, TEXT("key"), Entry.Key) ||
					!EntryObject->TryGetStringField(TEXT("source"), Entry.Source) || SeenKeys.Contains(Entry.Key))
				{
					UE_LOG(LogUnrealLocSync, Error, TEXT("Invalid or duplicate key in String Table %s."), *Table.Namespace);
					return false;
				}
				SeenKeys.Add(Entry.Key);
				Table.Entries.Add(MoveTemp(Entry));
			}
		}
		Tables.Add(MoveTemp(Table));
	}

	return true;
}

bool UCreateStringTablesCommandlet::SaveStringTables(const FString& AssetPath)
{
	for (const FTableData& Table : Tables)
	{
		const FString PackageName = AssetPath + TEXT("/") + Table.AssetName;
		if (!FPackageName::IsValidLongPackageName(PackageName))
		{
			UE_LOG(LogUnrealLocSync, Error, TEXT("Invalid String Table asset name: %s"), *PackageName);
			return false;
		}

		UStringTable* Asset = CreateOrLoadStringTable(AssetPath, Table.AssetName);
		if (!Asset)
		{
			return false;
		}

		FStringTableRef StringTable = Asset->GetMutableStringTable();
		StringTable->ClearSourceStrings();
		StringTable->SetNamespace(Table.Namespace);
		for (const FKeyValue& Entry : Table.Entries)
		{
#if WITH_EDITORONLY_DATA && UE_VERSION_NEWER_THAN_OR_EQUAL(5, 8, 0)
			StringTable->SetSourceString(Entry.Key, Entry.Source, FString());
#else
			StringTable->SetSourceString(Entry.Key, Entry.Source);
#endif
		}

		UPackage* Package = Asset->GetOutermost();
		if (!Package)
		{
			UE_LOG(LogUnrealLocSync, Error, TEXT("String Table %s has no package."), *Table.AssetName);
			return false;
		}
		Package->MarkPackageDirty();
		const FString Filename = FPackageName::LongPackageNameToFilename(PackageName, FPackageName::GetAssetPackageExtension());
		if (!SavePackageHelper(Package, Filename))
		{
			UE_LOG(LogUnrealLocSync, Error, TEXT("Failed to save String Table %s to %s."), *Table.AssetName, *Filename);
			return false;
		}
		UE_LOG(LogUnrealLocSync, Display, TEXT("Saved String Table %s (%d entries)."), *PackageName, Table.Entries.Num());
	}
	return true;
}

UStringTable* UCreateStringTablesCommandlet::CreateOrLoadStringTable(const FString& AssetPath, const FString& AssetName) const
{
	const FString PackageName = AssetPath + TEXT("/") + AssetName;
	const FString ObjectPath = PackageName + TEXT(".") + AssetName;
	const FAssetData ExistingData = FAssetRegistryModule::GetRegistry().GetAssetByObjectPath(FSoftObjectPath(ObjectPath));
	if (ExistingData.IsValid())
	{
		UStringTable* Existing = Cast<UStringTable>(ExistingData.GetAsset());
		if (!Existing)
		{
			UE_LOG(LogUnrealLocSync, Error, TEXT("Asset %s exists but is not a String Table."), *ObjectPath);
		}
		return Existing;
	}

	if (UObject* ExistingObject = LoadObject<UObject>(nullptr, *ObjectPath))
	{
		UStringTable* Existing = Cast<UStringTable>(ExistingObject);
		if (!Existing)
		{
			UE_LOG(LogUnrealLocSync, Error, TEXT("Asset %s exists but is not a String Table."), *ObjectPath);
		}
		return Existing;
	}

	if (FPackageName::DoesPackageExist(PackageName))
	{
		UE_LOG(LogUnrealLocSync, Error, TEXT("Package %s exists but the String Table could not be loaded."), *PackageName);
		return nullptr;
	}

	FAssetToolsModule& AssetTools = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools"));
	UStringTableFactory* Factory = NewObject<UStringTableFactory>();
	UStringTable* NewAsset = Cast<UStringTable>(AssetTools.Get().CreateAsset(AssetName, AssetPath, UStringTable::StaticClass(), Factory));
	if (!NewAsset)
	{
		UE_LOG(LogUnrealLocSync, Error, TEXT("Failed to create String Table %s."), *ObjectPath);
	}
	return NewAsset;
}
