/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

export const DEFAULT_ACCOUNT_SIGN_IN_COMMAND = 'workbench.actions.accounts.signIn';

// Inline type definitions to avoid importing heavy modules
export interface IDefaultAccountAuthenticationProvider {
	readonly id: string;
	readonly name: string;
	readonly enterprise?: boolean;
}

export interface IPolicyData {
	readonly chat_preview_features_enabled?: boolean;
	readonly chat_agent_enabled?: boolean;
}

export interface IDefaultAccount {
	readonly authenticationProvider: IDefaultAccountAuthenticationProvider;
	readonly accountName: string;
	readonly sessionId: string;
	readonly enterprise: boolean;
	readonly entitlementsData?: unknown;
}

export interface IDefaultAccountProvider {
	readonly defaultAccount: IDefaultAccount | null;
	readonly onDidChangeDefaultAccount: Event<IDefaultAccount | null>;
	readonly policyData: IPolicyData | null;
	readonly onDidChangePolicyData: Event<IPolicyData | null>;
	getDefaultAccountAuthenticationProvider(): IDefaultAccountAuthenticationProvider;
	refresh(): Promise<IDefaultAccount | null>;
	signIn(options?: { additionalScopes?: readonly string[];[key: string]: unknown }): Promise<IDefaultAccount | null>;
	signOut(): Promise<void>;
}

export const IDefaultAccountService = createDecorator<IDefaultAccountService>('defaultAccountService');

export interface IDefaultAccountService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeDefaultAccount: Event<IDefaultAccount | null>;
	readonly onDidChangePolicyData: Event<IPolicyData | null>;
	readonly policyData: IPolicyData | null;
	getDefaultAccount(): Promise<IDefaultAccount | null>;
	getDefaultAccountAuthenticationProvider(): IDefaultAccountAuthenticationProvider;
	setDefaultAccountProvider(provider: IDefaultAccountProvider): void;
	refresh(): Promise<IDefaultAccount | null>;
	signIn(options?: { additionalScopes?: readonly string[];[key: string]: unknown }): Promise<IDefaultAccount | null>;
	signOut(): Promise<void>;
}

export class NullDefaultAccountService extends Disposable implements IDefaultAccountService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeDefaultAccount = this._register(new Emitter<IDefaultAccount | null>());
	readonly onDidChangeDefaultAccount = this._onDidChangeDefaultAccount.event;

	private readonly _onDidChangePolicyData = this._register(new Emitter<IPolicyData | null>());
	readonly onDidChangePolicyData = this._onDidChangePolicyData.event;

	readonly policyData: IPolicyData | null = null;

	async getDefaultAccount(): Promise<IDefaultAccount | null> {
		return null;
	}

	getDefaultAccountAuthenticationProvider(): IDefaultAccountAuthenticationProvider {
		return { id: '', name: '', enterprise: false };
	}

	setDefaultAccountProvider(_provider: IDefaultAccountProvider): void {
		// No-op
	}

	async refresh(): Promise<IDefaultAccount | null> {
		return null;
	}

	async signIn(_options?: { additionalScopes?: readonly string[];[key: string]: unknown }): Promise<IDefaultAccount | null> {
		return null;
	}

	async signOut(): Promise<void> {
		// No-op
	}
}

registerSingleton(IDefaultAccountService, NullDefaultAccountService, InstantiationType.Delayed);
