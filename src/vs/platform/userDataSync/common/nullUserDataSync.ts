/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from '../../../base/common/event.js';
import { AbstractLogger } from '../../log/common/log.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';

// SyncResource enum (inlined to avoid importing heavy module)
export const enum SyncResource {
	Settings = 'settings',
	Keybindings = 'keybindings',
	Snippets = 'snippets',
	Tasks = 'tasks',
	Extensions = 'extensions',
	GlobalState = 'globalState',
	Profiles = 'profiles',
	WorkspaceState = 'workspaceState'
}

// Null implementation of IIgnoredExtensionsManagementService
export const IIgnoredExtensionsManagementService = createDecorator<IIgnoredExtensionsManagementService>(
	'IIgnoredExtensionsManagementService'
);
export interface IIgnoredExtensionsManagementService {
	readonly _serviceBrand: undefined;
	getIgnoredExtensions(installed: unknown[]): string[];
	hasToNeverSyncExtension(extensionId: string): boolean;
	hasToAlwaysSyncExtension(extensionId: string): boolean;
	updateIgnoredExtensions(ignoredExtensionId: string, ignore: boolean): Promise<void>;
	updateSynchronizedExtensions(ignoredExtensionId: string, sync: boolean): Promise<void>;
}

export class NullIgnoredExtensionsManagementService implements IIgnoredExtensionsManagementService {
	declare readonly _serviceBrand: undefined;
	getIgnoredExtensions(): string[] {
		return [];
	}
	hasToNeverSyncExtension(): boolean {
		return false;
	}
	hasToAlwaysSyncExtension(): boolean {
		return false;
	}
	async updateIgnoredExtensions(): Promise<void> {}
	async updateSynchronizedExtensions(): Promise<void> {}
}

// Null implementation of IUserDataSyncLogService
export const IUserDataSyncLogService = createDecorator<IUserDataSyncLogService>('IUserDataSyncLogService');
export interface IUserDataSyncLogService {
	readonly _serviceBrand: undefined;
	trace(message: string, ...args: unknown[]): void;
	debug(message: string, ...args: unknown[]): void;
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string | Error, ...args: unknown[]): void;
	flush(): void;
}

export class NullUserDataSyncLogService extends AbstractLogger implements IUserDataSyncLogService {
	declare readonly _serviceBrand: undefined;
	trace(): void {}
	debug(): void {}
	info(): void {}
	warn(): void {}
	error(): void {}
	flush(): void {}
}

// Null implementation of IUserDataSyncStoreService
export const IUserDataSyncStoreService = createDecorator<IUserDataSyncStoreService>('IUserDataSyncStoreService');
export interface IUserDataSyncStoreService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeDonotMakeRequestsUntil: Event<void>;
	readonly donotMakeRequestsUntil: Date | undefined;
	readonly onTokenFailed: Event<boolean>;
	readonly onTokenSucceed: Event<void>;
}

export class NullUserDataSyncStoreService implements IUserDataSyncStoreService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeDonotMakeRequestsUntil = Event.None;
	readonly donotMakeRequestsUntil = undefined;
	readonly onTokenFailed = Event.None;
	readonly onTokenSucceed = Event.None;
}

// Null implementation of IUserDataSyncMachinesService
export const IUserDataSyncMachinesService =
	createDecorator<IUserDataSyncMachinesService>('IUserDataSyncMachinesService');
export interface IUserDataSyncMachinesService {
	readonly _serviceBrand: undefined;
}

export class NullUserDataSyncMachinesService implements IUserDataSyncMachinesService {
	declare readonly _serviceBrand: undefined;
}

// Null implementation of IUserDataSyncLocalStoreService
export const IUserDataSyncLocalStoreService = createDecorator<IUserDataSyncLocalStoreService>(
	'IUserDataSyncLocalStoreService'
);
export interface IUserDataSyncLocalStoreService {
	readonly _serviceBrand: undefined;
}

export class NullUserDataSyncLocalStoreService implements IUserDataSyncLocalStoreService {
	declare readonly _serviceBrand: undefined;
}

// Null implementation of IUserDataSyncAccountService
export const IUserDataSyncAccountService = createDecorator<IUserDataSyncAccountService>('IUserDataSyncAccountService');
export interface IUserDataSyncAccountService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeAccount: Event<unknown>;
	readonly account: unknown;
	updateAccount(account: unknown): Promise<void>;
}

export class NullUserDataSyncAccountService implements IUserDataSyncAccountService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeAccount = Event.None;
	readonly account = undefined;
	async updateAccount(): Promise<void> {}
}

// Null implementation of IUserDataSyncService
export const IUserDataSyncService = createDecorator<IUserDataSyncService>('IUserDataSyncService');
export interface IUserDataSyncService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeStatus: Event<unknown>;
	readonly onDidChangeConflicts: Event<unknown>;
	readonly onDidChangeLocal: Event<unknown>;
	readonly onSyncErrors: Event<unknown>;
	readonly status: unknown;
	readonly conflicts: unknown[];
	readonly lastSyncTime: number | undefined;
}

export class NullUserDataSyncService implements IUserDataSyncService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeStatus = Event.None;
	readonly onDidChangeConflicts = Event.None;
	readonly onDidChangeLocal = Event.None;
	readonly onSyncErrors = Event.None;
	readonly status = 'uninitialized';
	readonly conflicts: unknown[] = [];
	readonly lastSyncTime = undefined;
}

// Null implementation of IUserDataSyncResourceProviderService
export const IUserDataSyncResourceProviderService = createDecorator<IUserDataSyncResourceProviderService>(
	'IUserDataSyncResourceProviderService'
);
export interface IUserDataSyncResourceProviderService {
	readonly _serviceBrand: undefined;
}

export class NullUserDataSyncResourceProviderService implements IUserDataSyncResourceProviderService {
	declare readonly _serviceBrand: undefined;
}

// Null implementation of IUserDataAutoSyncService
export const IUserDataAutoSyncService = createDecorator<IUserDataAutoSyncService>('IUserDataAutoSyncService');
export interface IUserDataAutoSyncService {
	readonly _serviceBrand: undefined;
	readonly onError: Event<unknown>;
	turnOn(): Promise<void>;
	turnOff(everywhere: boolean): Promise<void>;
}

export class NullUserDataAutoSyncService implements IUserDataAutoSyncService {
	declare readonly _serviceBrand: undefined;
	readonly onError = Event.None;
	async turnOn(): Promise<void> {}
	async turnOff(): Promise<void> {}
}

// Null implementation of IUserDataSyncEnablementService
export const IUserDataSyncEnablementService = createDecorator<IUserDataSyncEnablementService>(
	'IUserDataSyncEnablementService'
);
export interface IUserDataSyncEnablementService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeEnablement: Event<boolean>;
	isEnabled(): boolean;
	canToggleEnablement(): boolean;
	setEnablement(enabled: boolean): void;
	isResourceEnabled(resource: unknown): boolean;
	setResourceEnablement(resource: unknown, enabled: boolean): void;
	getResourceSyncStateVersion(resource: unknown): string | undefined;
}

export class NullUserDataSyncEnablementService extends Disposable implements IUserDataSyncEnablementService {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidChangeEnablement = this._register(new Emitter<boolean>());
	readonly onDidChangeEnablement = this._onDidChangeEnablement.event;
	isEnabled(): boolean {
		return false;
	}
	canToggleEnablement(): boolean {
		return false;
	}
	setEnablement(): void {}
	isResourceEnabled(): boolean {
		return false;
	}
	setResourceEnablement(): void {}
	getResourceSyncStateVersion(): string | undefined {
		return undefined;
	}
}

// Null implementation of IUserDataSyncStoreManagementService
export const IUserDataSyncStoreManagementService = createDecorator<IUserDataSyncStoreManagementService>(
	'IUserDataSyncStoreManagementService'
);
export interface IUserDataSyncStoreManagementService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeUserDataSyncStore: Event<void>;
	readonly userDataSyncStore: unknown | undefined;
}

export class NullUserDataSyncStoreManagementService extends Disposable implements IUserDataSyncStoreManagementService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeUserDataSyncStore = Event.None;
	readonly userDataSyncStore = undefined;
}

// Register all null singletons
registerSingleton(
	IIgnoredExtensionsManagementService,
	NullIgnoredExtensionsManagementService,
	InstantiationType.Delayed
);
registerSingleton(IUserDataSyncLogService, NullUserDataSyncLogService, InstantiationType.Delayed);
registerSingleton(IUserDataSyncStoreService, NullUserDataSyncStoreService, InstantiationType.Delayed);
registerSingleton(IUserDataSyncMachinesService, NullUserDataSyncMachinesService, InstantiationType.Delayed);
registerSingleton(IUserDataSyncLocalStoreService, NullUserDataSyncLocalStoreService, InstantiationType.Delayed);
registerSingleton(IUserDataSyncAccountService, NullUserDataSyncAccountService, InstantiationType.Delayed);
registerSingleton(IUserDataSyncService, NullUserDataSyncService, InstantiationType.Delayed);
registerSingleton(
	IUserDataSyncResourceProviderService,
	NullUserDataSyncResourceProviderService,
	InstantiationType.Delayed
);
registerSingleton(IUserDataAutoSyncService, NullUserDataAutoSyncService, InstantiationType.Delayed);
registerSingleton(IUserDataSyncEnablementService, NullUserDataSyncEnablementService, InstantiationType.Delayed);
registerSingleton(
	IUserDataSyncStoreManagementService,
	NullUserDataSyncStoreManagementService,
	InstantiationType.Delayed
);
