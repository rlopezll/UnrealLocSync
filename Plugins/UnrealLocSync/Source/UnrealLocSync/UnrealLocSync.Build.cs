
using UnrealBuildTool;

public class UnrealLocSync : ModuleRules
{
	public UnrealLocSync(ReadOnlyTargetRules Target)
		: base(Target)
	{

		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(
			new string[] {
				"Core",
				"CoreUObject",
				"Engine",
				"AssetRegistry"
			}
		);

		PrivateDependencyModuleNames.AddRange(
			new string[] {
				"AssetTools",
				"Engine",
				"EditorScriptingUtilities",
				"UnrealEd",
				"Json", 
				"JsonUtilities",
			}
		);
	}
}
