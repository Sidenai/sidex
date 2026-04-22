/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepClone } from '../../../base/common/objects.js';
import { Event, Emitter } from '../../../base/common/event.js';
import type * as vscode from 'vscode';
import { ExtHostWorkspace, IExtHostWorkspace } from './extHostWorkspace.js';
import {
	ExtHostConfigurationShape,
	MainThreadConfigurationShape,
	IConfigurationInitData,
	MainContext
} from './extHost.protocol.js';
import { ConfigurationTarget as ExtHostConfigurationTarget } from './extHostTypes.js';
import {
	ConfigurationTarget,
	IConfigurationChange,
	IConfigurationData,
	IConfigurationOverrides
} from '../../../platform/configuration/common/configuration.js';
import { Configuration, ConfigurationChangeEvent } from '../../../platform/configuration/common/configurationModels.js';
import { ConfigurationScope } from '../../../platform/configuration/common/configurationRegistry.js';
import { IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
import { Barrier } from '../../../base/common/async.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IExtHostRpcService } from './extHostRpcService.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { Workspace } from '../../../platform/workspace/common/workspace.js';

export type ConfigurationInspect<T> = {
	key: string;

	defaultValue?: T;
	globalLocalValue?: T;
	globalRemoteValue?: T;
	globalValue?: T;
	workspaceValue?: T;
	workspaceFolderValue?: T;

	defaultLanguageValue?: T;
	globalLocalLanguageValue?: T;
	globalRemoteLanguageValue?: T;
	globalLanguageValue?: T;
	workspaceLanguageValue?: T;
	workspaceFolderLanguageValue?: T;

	languageIds?: string[];
};

export class ExtHostConfiguration implements ExtHostConfigurationShape {
	readonly _serviceBrand: undefined;

	private readonly _proxy: MainThreadConfigurationShape;
	private readonly _logService: ILogService;
	private readonly _extHostWorkspace: ExtHostWorkspace;
	private readonly _barrier: Barrier;
	private _actual: ExtHostConfigProvider | null;

	constructor(
		@IExtHostRpcService extHostRpc: IExtHostRpcService,
		@IExtHostWorkspace extHostWorkspace: IExtHostWorkspace,
		@ILogService logService: ILogService
	) {
		this._proxy = extHostRpc.getProxy(MainContext.MainThreadConfiguration);
		this._extHostWorkspace = extHostWorkspace;
		this._logService = logService;
		this._barrier = new Barrier();
		this._actual = null;
	}

	public getConfigProvider(): Promise<ExtHostConfigProvider> {
		return this._barrier.wait().then(_ => this._actual!);
	}

	$initializeConfiguration(data: IConfigurationInitData): void {
		this._actual = new ExtHostConfigProvider(this._proxy, this._extHostWorkspace, data, this._logService);
		this._barrier.open();
	}

	$acceptConfigurationChanged(data: IConfigurationInitData, change: IConfigurationChange): void {
		this.getConfigProvider().then(provider => provider.$acceptConfigurationChanged(data, change));
	}
}

export class ExtHostConfigProvider {
	private readonly _onDidChangeConfiguration = new Emitter<vscode.ConfigurationChangeEvent>();
	private readonly _proxy: MainThreadConfigurationShape;
	private readonly _extHostWorkspace: ExtHostWorkspace;
	private _configurationScopes: Map<string, ConfigurationScope | undefined>;
	private _configuration: Configuration;
	private _logService: ILogService;

	constructor(
		proxy: MainThreadConfigurationShape,
		extHostWorkspace: ExtHostWorkspace,
		data: IConfigurationInitData,
		logService: ILogService
	) {
		this._proxy = proxy;
		this._logService = logService;
		this._extHostWorkspace = extHostWorkspace;
		this._configuration = Configuration.parse(data, logService);
		this._configurationScopes = this._toMap(data.configurationScopes);
	}

	get onDidChangeConfiguration(): Event<vscode.ConfigurationChangeEvent> {
		return this._onDidChangeConfiguration && this._onDidChangeConfiguration.event;
	}

	$acceptConfigurationChanged(data: IConfigurationInitData, change: IConfigurationChange) {
		const previous = { data: this._configuration.toData(), workspace: this._extHostWorkspace.workspace };
		this._configuration = Configuration.parse(data, this._logService);
		this._configurationScopes = this._toMap(data.configurationScopes);
		this._onDidChangeConfiguration.fire(this._toConfigurationChangeEvent(change, previous));
	}

	getConfiguration(
		section?: string,
		_scope?: vscode.ConfigurationScope | null,
		_extensionDescription?: IExtensionDescription
	): vscode.WorkspaceConfiguration {
		const overrides: IConfigurationOverrides = {};
		const config = deepClone(this._configuration.getValue(section, overrides, this._extHostWorkspace.workspace));

		const result: vscode.WorkspaceConfiguration = {
			has(key: string): boolean {
				return typeof config === 'object' && config !== null && key in (config as Record<string, unknown>);
			},
			get: <T>(key: string, defaultValue?: T) => {
				let val: unknown = config;
				if (typeof config === 'object' && config !== null) {
					val = (config as Record<string, unknown>)[key];
				}
				return (val !== undefined ? val : defaultValue) as T;
			},
			update: (
				key: string,
				value: unknown,
				extHostConfigurationTarget: ExtHostConfigurationTarget | boolean,
				scopeToLanguage?: boolean
			) => {
				key = section ? `${section}.${key}` : key;
				let target: ConfigurationTarget | null = null;
				if (typeof extHostConfigurationTarget === 'boolean') {
					target = extHostConfigurationTarget ? ConfigurationTarget.USER : ConfigurationTarget.WORKSPACE;
				} else if (extHostConfigurationTarget === ExtHostConfigurationTarget.Global) {
					target = ConfigurationTarget.USER;
				} else if (extHostConfigurationTarget === ExtHostConfigurationTarget.Workspace) {
					target = ConfigurationTarget.WORKSPACE;
				} else if (extHostConfigurationTarget === ExtHostConfigurationTarget.WorkspaceFolder) {
					target = ConfigurationTarget.WORKSPACE_FOLDER;
				}
				if (value !== undefined) {
					return this._proxy.$updateConfigurationOption(target, key, value, overrides, scopeToLanguage);
				} else {
					return this._proxy.$removeConfigurationOption(target, key, overrides, scopeToLanguage);
				}
			},
			inspect: <T>(_key: string): ConfigurationInspect<T> | undefined => {
				return undefined;
			}
		};

		return Object.freeze(result);
	}

	private _toConfigurationChangeEvent(
		change: IConfigurationChange,
		previous: { data: IConfigurationData; workspace: Workspace | undefined }
	): vscode.ConfigurationChangeEvent {
		const event = new ConfigurationChangeEvent(
			change,
			previous,
			this._configuration,
			this._extHostWorkspace.workspace,
			this._logService
		);
		return Object.freeze({
			affectsConfiguration: (section: string, scope?: vscode.ConfigurationScope) =>
				event.affectsConfiguration(section, scope ? {} : undefined)
		});
	}

	private _toMap(scopes: [string, ConfigurationScope | undefined][]): Map<string, ConfigurationScope | undefined> {
		return scopes.reduce((result, scope) => {
			result.set(scope[0], scope[1]);
			return result;
		}, new Map<string, ConfigurationScope | undefined>());
	}
}

export const IExtHostConfiguration = createDecorator<IExtHostConfiguration>('IExtHostConfiguration');
export interface IExtHostConfiguration extends ExtHostConfiguration {}
