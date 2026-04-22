/*---------------------------------------------------------------------------------------------
 *  SideX Extension API Service
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '../../../sidex-bridge.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';
import { CommandsRegistry } from '../../commands/common/commands.js';
import { toDisposable } from '../../../base/common/lifecycle.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExtCommandInfo {
	readonly id: string;
}

export type ExtNamespace =
	| 'window'
	| 'workspace'
	| 'commands'
	| 'languages'
	| 'debug'
	| 'tasks'
	| 'scm'
	| 'tests'
	| 'env';

export type ExtCommandResult = unknown;

// ---------------------------------------------------------------------------
// Service decorator
// ---------------------------------------------------------------------------

export const ISidexExtensionApiService = createDecorator<ISidexExtensionApiService>('sidexExtensionApiService');

export interface ISidexExtensionApiService {
	readonly _serviceBrand: undefined;

	/**
	 * Returns the list of first-class API namespaces registered in the Rust
	 * backend (e.g. `["window","workspace","commands",…]`).
	 */
	getNamespaces(): Promise<ExtNamespace[]>;

	/**
	 * Returns all commands registered in the Rust `CommandRegistry`.
	 * Pass an optional `namespace` prefix to filter results client-side
	 * (e.g. `"window"` keeps only commands whose id starts with `"window/"`
	 * or `"window."`).
	 */
	getCommands(namespace?: string): Promise<ExtCommandInfo[]>;

	/**
	 * Dispatches a command through the extension-host JSON-RPC path.
	 *
	 * The `command` is a fully-qualified id such as `"window/showInformationMessage"`.
	 * `args` is passed verbatim as the `params` payload.
	 */
	callCommand(command: string, args?: unknown): Promise<ExtCommandResult>;

	/**
	 * Pulls the current set of backend commands and registers each with VS
	 * Code's `CommandsRegistry` so they appear in the Command Palette.
	 * Idempotent — re-invoking replaces any previously-registered stubs.
	 */
	syncToCommandPalette(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class SidexExtensionApiService implements ISidexExtensionApiService {
	declare readonly _serviceBrand: undefined;

	/** Disposables for commands currently forwarded into CommandsRegistry. */
	private readonly _registeredCommands = new Map<string, ReturnType<typeof toDisposable>>();

	async getNamespaces(): Promise<ExtNamespace[]> {
		try {
			return ((await invoke<string[]>('ext_api_get_namespaces')) as ExtNamespace[]) ?? [];
		} catch {
			return [];
		}
	}

	async getCommands(namespace?: string): Promise<ExtCommandInfo[]> {
		try {
			const all = (await invoke<ExtCommandInfo[]>('ext_api_get_commands')) ?? [];
			if (!namespace) {
				return all;
			}
			const prefixes = [`${namespace}/`, `${namespace}.`];
			return all.filter(c => prefixes.some(p => c.id.startsWith(p)));
		} catch {
			return [];
		}
	}

	async callCommand(command: string, args?: unknown): Promise<ExtCommandResult> {
		// Commands are dispatched via the extension-host JSON-RPC bridge; the
		// method name uses the "namespace/action" convention that the Rust
		// ExtensionApiHandler.dispatch() expects.
		const [namespace, ...rest] = command.split('/');
		const action = rest.join('/');

		if (!namespace || !action) {
			throw new Error(`[SidexExtensionApiService] malformed command id: "${command}"`);
		}

		return invoke<ExtCommandResult>('ext_api_call', {
			namespace,
			action,
			params: args ?? null
		});
	}

	async syncToCommandPalette(): Promise<void> {
		const commands = await this.getCommands();

		// Tear down stale registrations from a previous sync.
		for (const [id, disposable] of this._registeredCommands) {
			if (!commands.find(c => c.id === id)) {
				disposable.dispose();
				this._registeredCommands.delete(id);
			}
		}

		for (const { id } of commands) {
			if (this._registeredCommands.has(id)) {
				continue;
			}

			// The label shown in the Command Palette is derived from the id by
			// replacing the namespace separator with ': ' and title-casing the
			// action portion (best-effort, no i18n needed for internal commands).
			const label = this._formatCommandLabel(id);

			const disposable = CommandsRegistry.registerCommand({
				id,
				handler: (_accessor, ...args) => {
					const params = args.length === 1 ? args[0] : args.length > 1 ? args : undefined;
					return this.callCommand(id, params);
				},
				metadata: { description: label }
			});

			this._registeredCommands.set(
				id,
				toDisposable(() => disposable.dispose())
			);
		}
	}

	/** Converts `"window/showInformationMessage"` → `"Window: Show Information Message"`. */
	private _formatCommandLabel(id: string): string {
		const sep = id.includes('/') ? '/' : '.';
		const parts = id.split(sep);
		if (parts.length < 2) {
			return id;
		}
		const [namespace, ...rest] = parts;
		const action = rest.join(sep);
		const titleCased = action.replace(/([a-z])([A-Z])/g, '$1 $2');
		return `${this._capitalize(namespace)}: ${this._capitalize(titleCased)}`;
	}

	private _capitalize(s: string): string {
		return s.charAt(0).toUpperCase() + s.slice(1);
	}
}

registerSingleton(ISidexExtensionApiService, SidexExtensionApiService, InstantiationType.Delayed);
