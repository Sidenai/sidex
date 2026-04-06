/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { AuthenticationSessionAccount, IAuthenticationService, IAuthenticationExtensionsService, INTERNAL_AUTH_PROVIDER_PREFIX } from '../common/authentication.js';
import {
	IAuthenticationQueryService,
	IProviderQuery,
	IAccountQuery,
	IAccountExtensionQuery,
	IAccountExtensionsQuery,
	IAccountEntitiesQuery,
	IProviderExtensionQuery,
	IExtensionQuery,
	IActiveEntities,
	IAuthenticationUsageStats,
	IBaseQuery
} from '../common/authenticationQuery.js';
import { IAuthenticationUsageService } from './authenticationUsageService.js';
import { IAuthenticationAccessService } from './authenticationAccessService.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';

/**
 * Base implementation for query interfaces
 */
abstract class BaseQuery implements IBaseQuery {
	constructor(
		public readonly providerId: string,
		protected readonly queryService: AuthenticationQueryService
	) { }
}

/**
 * Implementation of account-extension query operations
 */
class AccountExtensionQuery extends BaseQuery implements IAccountExtensionQuery {
	constructor(
		providerId: string,
		public readonly accountName: string,
		public readonly extensionId: string,
		queryService: AuthenticationQueryService
	) {
		super(providerId, queryService);
	}

	isAccessAllowed(): boolean | undefined {
		return this.queryService.authenticationAccessService.isAccessAllowed(this.providerId, this.accountName, this.extensionId);
	}

	setAccessAllowed(allowed: boolean, extensionName?: string): void {
		this.queryService.authenticationAccessService.updateAllowedExtensions(
			this.providerId,
			this.accountName,
			[{ id: this.extensionId, name: extensionName || this.extensionId, allowed }]
		);
	}

	addUsage(scopes: readonly string[], extensionName: string): void {
		this.queryService.authenticationUsageService.addAccountUsage(
			this.providerId,
			this.accountName,
			scopes,
			this.extensionId,
			extensionName
		);
	}

	getUsage(): {
		readonly extensionId: string;
		readonly extensionName: string;
		readonly scopes: readonly string[];
		readonly lastUsed: number;
	}[] {
		const allUsages = this.queryService.authenticationUsageService.readAccountUsages(this.providerId, this.accountName);
		return allUsages
			.filter(usage => usage.extensionId === ExtensionIdentifier.toKey(this.extensionId))
			.map(usage => ({
				extensionId: usage.extensionId,
				extensionName: usage.extensionName,
				scopes: usage.scopes || [],
				lastUsed: usage.lastUsed
			}));
	}

	removeUsage(): void {
		// Get current usages, filter out this extension, and store the rest
		const allUsages = this.queryService.authenticationUsageService.readAccountUsages(this.providerId, this.accountName);
		const filteredUsages = allUsages.filter(usage => usage.extensionId !== this.extensionId);

		// Clear all usages and re-add the filtered ones
		this.queryService.authenticationUsageService.removeAccountUsage(this.providerId, this.accountName);
		for (const usage of filteredUsages) {
			this.queryService.authenticationUsageService.addAccountUsage(
				this.providerId,
				this.accountName,
				usage.scopes || [],
				usage.extensionId,
				usage.extensionName
			);
		}
	}

	setAsPreferred(): void {
		this.queryService.authenticationExtensionsService.updateAccountPreference(
			this.extensionId,
			this.providerId,
			{ label: this.accountName, id: this.accountName }
		);
	}

	isPreferred(): boolean {
		const preferredAccount = this.queryService.authenticationExtensionsService.getAccountPreference(this.extensionId, this.providerId);
		return preferredAccount === this.accountName;
	}

	isTrusted(): boolean {
		const allowedExtensions = this.queryService.authenticationAccessService.readAllowedExtensions(this.providerId, this.accountName);
		const extension = allowedExtensions.find(ext => ext.id === this.extensionId);
		return extension?.trusted === true;
	}
}

/**
 * Implementation of account-extensions query operations
 */
class AccountExtensionsQuery extends BaseQuery implements IAccountExtensionsQuery {
	constructor(
		providerId: string,
		public readonly accountName: string,
		queryService: AuthenticationQueryService
	) {
		super(providerId, queryService);
	}

	getAllowedExtensions(): { id: string; name: string; allowed?: boolean; lastUsed?: number; trusted?: boolean }[] {
		const allowedExtensions = this.queryService.authenticationAccessService.readAllowedExtensions(this.providerId, this.accountName);
		const usages = this.queryService.authenticationUsageService.readAccountUsages(this.providerId, this.accountName);

		return allowedExtensions
			.filter(ext => ext.allowed !== false)
			.map(ext => {
				// Find the most recent usage for this extension
				const extensionUsages = usages.filter(usage => usage.extensionId === ext.id);
				const lastUsed = extensionUsages.length > 0 ? Math.max(...extensionUsages.map(u => u.lastUsed)) : undefined;

				// Check if trusted through the extension query
				const extensionQuery = new AccountExtensionQuery(this.providerId, this.accountName, ext.id, this.queryService);
				const trusted = extensionQuery.isTrusted();

				return {
					id: ext.id,
					name: ext.name,
					allowed: ext.allowed,
					lastUsed,
					trusted
				};
			});
	}

	allowAccess(extensionIds: string[]): void {
		const extensionsToAllow = extensionIds.map(id => ({ id, name: id, allowed: true }));
		this.queryService.authenticationAccessService.updateAllowedExtensions(this.providerId, this.accountName, extensionsToAllow);
	}

	removeAccess(extensionIds: string[]): void {
		const extensionsToRemove = extensionIds.map(id => ({ id, name: id, allowed: false }));
		this.queryService.authenticationAccessService.updateAllowedExtensions(this.providerId, this.accountName, extensionsToRemove);
	}

	forEach(callback: (extensionQuery: IAccountExtensionQuery) => void): void {
		const usages = this.queryService.authenticationUsageService.readAccountUsages(this.providerId, this.accountName);
		const allowedExtensions = this.queryService.authenticationAccessService.readAllowedExtensions(this.providerId, this.accountName);

		// Combine extensions from both usage and access data
		const extensionIds = new Set<string>();
		usages.forEach(usage => extensionIds.add(usage.extensionId));
		allowedExtensions.forEach(ext => extensionIds.add(ext.id));

		for (const extensionId of extensionIds) {
			const extensionQuery = new AccountExtensionQuery(this.providerId, this.accountName, extensionId, this.queryService);
			callback(extensionQuery);
		}
	}
}

/**
 * Implementation of account-entities query operations for type-agnostic operations
 */
class AccountEntitiesQuery extends BaseQuery implements IAccountEntitiesQuery {
	constructor(
		providerId: string,
		public readonly accountName: string,
		queryService: AuthenticationQueryService
	) {
		super(providerId, queryService);
	}

	hasAnyUsage(): boolean {
		const extensionUsages = this.queryService.authenticationUsageService.readAccountUsages(this.providerId, this.accountName);
		if (extensionUsages.length > 0) {
			return true;
		}

		const allowedExtensions = this.queryService.authenticationAccessService.readAllowedExtensions(this.providerId, this.accountName);
		if (allowedExtensions.some(ext => ext.allowed !== false)) {
			return true;
		}

		return false;
	}

	getEntityCount(): { extensions: number; total: number } {
		const extensionUsages = this.queryService.authenticationUsageService.readAccountUsages(this.providerId, this.accountName);
		const allowedExtensions = this.queryService.authenticationAccessService.readAllowedExtensions(this.providerId, this.accountName).filter(ext => ext.allowed);
		const extensionIds = new Set<string>();
		extensionUsages.forEach(usage => extensionIds.add(usage.extensionId));
		allowedExtensions.forEach(ext => extensionIds.add(ext.id));

		return {
			extensions: extensionIds.size,
			total: extensionIds.size
		};
	}

	removeAllAccess(): void {
		const extensionsQuery = new AccountExtensionsQuery(this.providerId, this.accountName, this.queryService);
		const extensions = extensionsQuery.getAllowedExtensions();
		const extensionIds = extensions.map(ext => ext.id);
		if (extensionIds.length > 0) {
			extensionsQuery.removeAccess(extensionIds);
		}
	}

	forEach(callback: (entityId: string, entityType: 'extension') => void): void {
		const extensionsQuery = new AccountExtensionsQuery(this.providerId, this.accountName, this.queryService);
		extensionsQuery.forEach(extensionQuery => {
			callback(extensionQuery.extensionId, 'extension');
		});
	}
}

/**
 * Implementation of account query operations
 */
class AccountQuery extends BaseQuery implements IAccountQuery {
	constructor(
		providerId: string,
		public readonly accountName: string,
		queryService: AuthenticationQueryService
	) {
		super(providerId, queryService);
	}

	extension(extensionId: string): IAccountExtensionQuery {
		return new AccountExtensionQuery(this.providerId, this.accountName, extensionId, this.queryService);
	}

	extensions(): IAccountExtensionsQuery {
		return new AccountExtensionsQuery(this.providerId, this.accountName, this.queryService);
	}

	entities(): IAccountEntitiesQuery {
		return new AccountEntitiesQuery(this.providerId, this.accountName, this.queryService);
	}

	remove(): void {
		this.queryService.authenticationAccessService.removeAllowedExtensions(this.providerId, this.accountName);
		this.queryService.authenticationUsageService.removeAccountUsage(this.providerId, this.accountName);
	}
}

/**
 * Implementation of provider-extension query operations
 */
class ProviderExtensionQuery extends BaseQuery implements IProviderExtensionQuery {
	constructor(
		providerId: string,
		public readonly extensionId: string,
		queryService: AuthenticationQueryService
	) {
		super(providerId, queryService);
	}

	getPreferredAccount(): string | undefined {
		return this.queryService.authenticationExtensionsService.getAccountPreference(this.extensionId, this.providerId);
	}

	setPreferredAccount(account: AuthenticationSessionAccount): void {
		this.queryService.authenticationExtensionsService.updateAccountPreference(this.extensionId, this.providerId, account);
	}

	removeAccountPreference(): void {
		this.queryService.authenticationExtensionsService.removeAccountPreference(this.extensionId, this.providerId);
	}
}

/**
 * Implementation of provider query operations
 */
class ProviderQuery extends BaseQuery implements IProviderQuery {
	constructor(
		providerId: string,
		queryService: AuthenticationQueryService
	) {
		super(providerId, queryService);
	}

	account(accountName: string): IAccountQuery {
		return new AccountQuery(this.providerId, accountName, this.queryService);
	}

	extension(extensionId: string): IProviderExtensionQuery {
		return new ProviderExtensionQuery(this.providerId, extensionId, this.queryService);
	}

	async getActiveEntities(): Promise<IActiveEntities> {
		const extensions: string[] = [];

		try {
			const accounts = await this.queryService.authenticationService.getAccounts(this.providerId);

			for (const account of accounts) {
				const extensionUsages = this.queryService.authenticationUsageService.readAccountUsages(this.providerId, account.label);
				for (const usage of extensionUsages) {
					if (!extensions.includes(usage.extensionId)) {
						extensions.push(usage.extensionId);
					}
				}
			}
		} catch {
		}

		return { extensions };
	}

	async getAccountNames(): Promise<string[]> {
		try {
			const accounts = await this.queryService.authenticationService.getAccounts(this.providerId);
			return accounts.map(account => account.label);
		} catch {
			return [];
		}
	}

	async getUsageStats(): Promise<IAuthenticationUsageStats> {
		const recentActivity: { accountName: string; lastUsed: number; usageCount: number }[] = [];
		let totalSessions = 0;
		let totalAccounts = 0;

		try {
			const accounts = await this.queryService.authenticationService.getAccounts(this.providerId);
			totalAccounts = accounts.length;

			for (const account of accounts) {
				const allUsages = this.queryService.authenticationUsageService.readAccountUsages(this.providerId, account.label);

				const usageCount = allUsages.length;
				const lastUsed = Math.max(...allUsages.map(u => u.lastUsed), 0);

				if (usageCount > 0) {
					recentActivity.push({ accountName: account.label, lastUsed, usageCount });
				}
			}

			// Sort by most recent activity
			recentActivity.sort((a, b) => b.lastUsed - a.lastUsed);

			// Count total sessions (approximate)
			totalSessions = recentActivity.reduce((sum, activity) => sum + activity.usageCount, 0);
		} catch {
			// Return default stats if there's an error
		}

		return { totalSessions, totalAccounts, recentActivity };
	}

	async forEachAccount(callback: (accountQuery: IAccountQuery) => void): Promise<void> {
		try {
			const accounts = await this.queryService.authenticationService.getAccounts(this.providerId);
			for (const account of accounts) {
				const accountQuery = new AccountQuery(this.providerId, account.label, this.queryService);
				callback(accountQuery);
			}
		} catch {
			// Silently handle errors in enumeration
		}
	}
}

/**
 * Implementation of extension query operations (cross-provider)
 */
class ExtensionQuery implements IExtensionQuery {
	constructor(
		public readonly extensionId: string,
		private readonly queryService: AuthenticationQueryService
	) { }

	async getProvidersWithAccess(includeInternal?: boolean): Promise<string[]> {
		const providersWithAccess: string[] = [];
		const providerIds = this.queryService.authenticationService.getProviderIds();

		for (const providerId of providerIds) {
			// Skip internal providers unless explicitly requested
			if (!includeInternal && providerId.startsWith(INTERNAL_AUTH_PROVIDER_PREFIX)) {
				continue;
			}

			try {
				const accounts = await this.queryService.authenticationService.getAccounts(providerId);
				const hasAccess = accounts.some(account => {
					const accessAllowed = this.queryService.authenticationAccessService.isAccessAllowed(providerId, account.label, this.extensionId);
					return accessAllowed === true;
				});

				if (hasAccess) {
					providersWithAccess.push(providerId);
				}
			} catch {
				// Skip providers that error
			}
		}

		return providersWithAccess;
	}

	getAllAccountPreferences(includeInternal?: boolean): Map<string, string> {
		const preferences = new Map<string, string>();
		const providerIds = this.queryService.authenticationService.getProviderIds();

		for (const providerId of providerIds) {
			// Skip internal providers unless explicitly requested
			if (!includeInternal && providerId.startsWith(INTERNAL_AUTH_PROVIDER_PREFIX)) {
				continue;
			}

			const preferredAccount = this.queryService.authenticationExtensionsService.getAccountPreference(this.extensionId, providerId);
			if (preferredAccount) {
				preferences.set(providerId, preferredAccount);
			}
		}

		return preferences;
	}

	provider(providerId: string): IProviderExtensionQuery {
		return new ProviderExtensionQuery(providerId, this.extensionId, this.queryService);
	}
}

/**
 * Main implementation of the authentication query service
 */
export class AuthenticationQueryService extends Disposable implements IAuthenticationQueryService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangePreferences = this._register(new Emitter<{
		readonly providerId: string;
		readonly entityType: 'extension';
		readonly entityIds: string[];
	}>());
	readonly onDidChangePreferences = this._onDidChangePreferences.event;

	private readonly _onDidChangeAccess = this._register(new Emitter<{
		readonly providerId: string;
		readonly accountName: string;
	}>());
	readonly onDidChangeAccess = this._onDidChangeAccess.event;

	constructor(
		@IAuthenticationService public readonly authenticationService: IAuthenticationService,
		@IAuthenticationUsageService public readonly authenticationUsageService: IAuthenticationUsageService,
		@IAuthenticationAccessService public readonly authenticationAccessService: IAuthenticationAccessService,
		@IAuthenticationExtensionsService public readonly authenticationExtensionsService: IAuthenticationExtensionsService,
		@ILogService public readonly logService: ILogService
	) {
		super();

		this._register(this.authenticationExtensionsService.onDidChangeAccountPreference(e => {
			this._onDidChangePreferences.fire({
				providerId: e.providerId,
				entityType: 'extension',
				entityIds: e.extensionIds
			});
		}));

		this._register(this.authenticationAccessService.onDidChangeExtensionSessionAccess(e => {
			this._onDidChangeAccess.fire({
				providerId: e.providerId,
				accountName: e.accountName
			});
		}));
	}

	provider(providerId: string): IProviderQuery {
		return new ProviderQuery(providerId, this);
	}

	extension(extensionId: string): IExtensionQuery {
		return new ExtensionQuery(extensionId, this);
	}

	getProviderIds(includeInternal?: boolean): string[] {
		return this.authenticationService.getProviderIds().filter(providerId => {
			// Filter out internal providers unless explicitly included
			return includeInternal || !providerId.startsWith(INTERNAL_AUTH_PROVIDER_PREFIX);
		});
	}

	async clearAllData(confirmation: 'CLEAR_ALL_AUTH_DATA', includeInternal: boolean = true): Promise<void> {
		if (confirmation !== 'CLEAR_ALL_AUTH_DATA') {
			throw new Error('Must provide confirmation string to clear all authentication data');
		}

		const providerIds = this.getProviderIds(includeInternal);

		for (const providerId of providerIds) {
			try {
				const accounts = await this.authenticationService.getAccounts(providerId);

				for (const account of accounts) {
					this.authenticationAccessService.removeAllowedExtensions(providerId, account.label);
					this.authenticationUsageService.removeAccountUsage(providerId, account.label);
				}
			} catch (error) {
				this.logService.error(`Error clearing data for provider ${providerId}:`, error);
			}
		}

		this.logService.info('All authentication data cleared');
	}
}

registerSingleton(IAuthenticationQueryService, AuthenticationQueryService, InstantiationType.Delayed);
