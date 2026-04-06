/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { AuthenticationSessionAccount } from './authentication.js';

/**
 * Statistics about authentication usage
 */
export interface IAuthenticationUsageStats {
	readonly totalSessions: number;
	readonly totalAccounts: number;
	readonly recentActivity: {
		readonly accountName: string;
		readonly lastUsed: number;
		readonly usageCount: number;
	}[];
}

/**
 * Information about entities using authentication within a provider
 */
export interface IActiveEntities {
	readonly extensions: string[];
}

/**
 * Base query interface with common properties
 */
export interface IBaseQuery {
	readonly providerId: string;
}

/**
 * Query interface for operations on a specific account within a provider
 */
export interface IAccountQuery extends IBaseQuery {
	readonly accountName: string;

	extension(extensionId: string): IAccountExtensionQuery;

	extensions(): IAccountExtensionsQuery;

	entities(): IAccountEntitiesQuery;

	remove(): void;
}

/**
 * Query interface for operations on a specific extension within a specific account
 */
export interface IAccountExtensionQuery extends IBaseQuery {
	readonly accountName: string;
	readonly extensionId: string;

	isAccessAllowed(): boolean | undefined;

	setAccessAllowed(allowed: boolean, extensionName?: string): void;

	addUsage(scopes: readonly string[], extensionName: string): void;

	getUsage(): {
		readonly extensionId: string;
		readonly extensionName: string;
		readonly scopes: readonly string[];
		readonly lastUsed: number;
	}[];

	removeUsage(): void;

	setAsPreferred(): void;

	isPreferred(): boolean;

	isTrusted(): boolean;
}

/**
 * Query interface for operations on all extensions within a specific account
 */
export interface IAccountExtensionsQuery extends IBaseQuery {
	readonly accountName: string;

	getAllowedExtensions(): { id: string; name: string; allowed?: boolean; lastUsed?: number; trusted?: boolean }[];

	allowAccess(extensionIds: string[]): void;

	removeAccess(extensionIds: string[]): void;

	forEach(callback: (extensionQuery: IAccountExtensionQuery) => void): void;
}

/**
 * Query interface for type-agnostic operations on all entities within a specific account
 */
export interface IAccountEntitiesQuery extends IBaseQuery {
	readonly accountName: string;

	hasAnyUsage(): boolean;

	getEntityCount(): { extensions: number; total: number };

	removeAllAccess(): void;

	forEach(callback: (entityId: string, entityType: 'extension') => void): void;
}

/**
 * Query interface for operations on a specific extension within a provider
 */
export interface IProviderExtensionQuery extends IBaseQuery {
	readonly extensionId: string;

	getPreferredAccount(): string | undefined;

	setPreferredAccount(account: AuthenticationSessionAccount): void;

	removeAccountPreference(): void;
}

/**
 * Query interface for provider-scoped operations
 */
export interface IProviderQuery extends IBaseQuery {
	account(accountName: string): IAccountQuery;

	extension(extensionId: string): IProviderExtensionQuery;

	getActiveEntities(): Promise<IActiveEntities>;

	getAccountNames(): Promise<string[]>;

	getUsageStats(): Promise<IAuthenticationUsageStats>;

	forEachAccount(callback: (accountQuery: IAccountQuery) => void): Promise<void>;
}

/**
 * Query interface for extension-scoped operations (cross-provider)
 */
export interface IExtensionQuery {
	readonly extensionId: string;

	getProvidersWithAccess(includeInternal?: boolean): Promise<string[]>;

	getAllAccountPreferences(includeInternal?: boolean): Map<string, string>;

	provider(providerId: string): IProviderExtensionQuery;
}

/**
 * Main authentication query service interface
 */
export const IAuthenticationQueryService = createDecorator<IAuthenticationQueryService>('IAuthenticationQueryService');
export interface IAuthenticationQueryService {
	readonly _serviceBrand: undefined;

	readonly onDidChangePreferences: Event<{
		readonly providerId: string;
		readonly entityType: 'extension';
		readonly entityIds: string[];
	}>;

	readonly onDidChangeAccess: Event<{
		readonly providerId: string;
		readonly accountName: string;
	}>;

	provider(providerId: string): IProviderQuery;

	extension(extensionId: string): IExtensionQuery;

	getProviderIds(): string[];

	clearAllData(confirmation: 'CLEAR_ALL_AUTH_DATA', includeInternal?: boolean): Promise<void>;
}
