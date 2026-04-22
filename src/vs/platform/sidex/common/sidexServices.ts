export { SideXEditorBridge } from './sidexEditorService.js';
export { SideXSyntaxService } from './sidexSyntaxService.js';
export { SideXGitService } from './sidexGitService.js';
export { SideXSearchService } from './sidexSearchService.js';
export { SideXSettingsService } from './sidexSettingsService.js';
export { SideXThemeService } from './sidexThemeService.js';
export { SideXExtensionService } from './sidexExtensionService.js';
export { SideXKeymapService } from './sidexKeymapService.js';
export { SideXTaskService, ISideXTaskService } from './sidexTaskService.js';
export type {
	DetectedTask,
	TaskDefinition,
	TaskSpawnOptions,
	TaskOutputEvent,
	TaskExitEvent
} from './sidexTaskService.js';
export { SideXFileSystemProvider } from '../browser/sidexFileSystemProvider.js';
export { ISidexExtensionApiService, SidexExtensionApiService } from './sidexExtensionApiService.js';
export type { ExtCommandInfo, ExtNamespace, ExtCommandResult } from './sidexExtensionApiService.js';
