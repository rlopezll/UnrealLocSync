#pragma once

#include "Commandlets/Commandlet.h"
#include "CreateStringTablesCommandlet.generated.h"

class UStringTable;

UCLASS()
class UCreateStringTablesCommandlet : public UCommandlet
{
	GENERATED_BODY()

public:

  virtual int32 Main(const FString& Params) override;

private:

	struct FKeyValue
	{
		FString Key;
		FString Source;
	};
	struct FTableData
	{
		FString Namespace;
		FString AssetName;
		TArray<FKeyValue> Entries;
	};
	TArray<FTableData> Tables;

	bool ParseInputFile(const FString& Filename, bool bLegacyManifest);
	bool SaveStringTables(const FString& AssetPath);
	UStringTable* CreateOrLoadStringTable(const FString& AssetPath, const FString& AssetName) const;
};
