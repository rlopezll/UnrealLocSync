#pragma once

#include "CoreMinimal.h"
#include "Modules/ModuleInterface.h"
#include "Modules/ModuleManager.h"

DECLARE_LOG_CATEGORY_EXTERN(LogUnrealLocSync, Log, All);

class FUnrealLocSyncModule : public IModuleInterface
{
public:

	virtual void StartupModule() override { return; }
  
	virtual void ShutdownModule() override { return; }

	bool IsGameModule() const override { return false; }

	static inline FUnrealLocSyncModule& Get()
	{
		return FModuleManager::LoadModuleChecked<FUnrealLocSyncModule>("UnrealLocSync");
	}
};
