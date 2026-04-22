/*---------------------------------------------------------------------------------------------
 *  SideX — Tauri-backed update service.
 *
 *  Mirrors VS Code's `IUpdateService` state machine (see
 *  `platform/update/common/update.ts`). All heavy lifting lives in the
 *  native `sidex-update` crate; this class is a thin bridge that:
 *
 *    1. invokes Rust Tauri commands for each VS Code lifecycle method
 *    2. subscribes to a single `sidex://update/state-change` Tauri event
 *       and re-dispatches it through the workbench `onStateChange` emitter
 *--------------------------------------------------------------------------------------------*/

export interface IUpdateProvider {
	checkForUpdate(): Promise<boolean>;
}

import { Emitter, Event } from '../../../../base/common/event.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IUpdateService, State, UpdateType } from '../../../../platform/update/common/update.js';

const STATE_EVENT = 'sidex://update/state-change';

interface TauriCore {
	invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

interface TauriEvent {
	listen(event: string, handler: (e: { payload: unknown }) => void): Promise<() => void>;
}

async function loadTauri(): Promise<{ core: TauriCore; event: TauriEvent } | undefined> {
	try {
		const [core, event] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
		return { core, event };
	} catch {
		return undefined;
	}
}

export class SidexUpdateService implements IUpdateService {
	declare readonly _serviceBrand: undefined;

	private readonly _onStateChange = new Emitter<State>();
	readonly onStateChange: Event<State> = this._onStateChange.event;

	private _state: State = State.Uninitialized;
	private _tauriReady: Promise<{ core: TauriCore; event: TauriEvent } | undefined>;

	constructor() {
		this._tauriReady = loadTauri();
		this._bootstrap();
	}

	get state(): State {
		return this._state;
	}

	private setState(next: State): void {
		this._state = next;
		this._onStateChange.fire(next);
	}

	private async _bootstrap(): Promise<void> {
		const tauri = await this._tauriReady;
		if (!tauri) {
			this.setState(State.Idle(UpdateType.Archive));
			return;
		}

		try {
			await tauri.event.listen(STATE_EVENT, ({ payload }) => {
				if (isState(payload)) {
					this._state = payload;
					this._onStateChange.fire(payload);
				}
			});
			const current = await tauri.core.invoke<unknown>('update_state');
			if (isState(current)) {
				this.setState(current);
			} else {
				this.setState(State.Idle(UpdateType.Archive));
			}
		} catch (err) {
			console.error('[sidex-update] bootstrap failed:', err);
			this.setState(State.Idle(UpdateType.Archive));
		}
	}

	async isLatestVersion(): Promise<boolean | undefined> {
		const state = this._state;
		if (state.type === 'idle' && state.notAvailable) {
			return true;
		}
		if (state.type === 'available for download' || state.type === 'ready') {
			return false;
		}
		return undefined;
	}

	async checkForUpdates(explicit: boolean): Promise<void> {
		const tauri = await this._tauriReady;
		if (!tauri) {
			return;
		}
		try {
			await tauri.core.invoke('update_check', { explicit });
		} catch (err) {
			console.error('[sidex-update] check failed:', err);
		}
	}

	async downloadUpdate(explicit: boolean): Promise<void> {
		const tauri = await this._tauriReady;
		if (!tauri) {
			return;
		}
		try {
			await tauri.core.invoke('update_download', { explicit });
		} catch (err) {
			console.error('[sidex-update] download failed:', err);
		}
	}

	async applyUpdate(): Promise<void> {
		const tauri = await this._tauriReady;
		if (!tauri) {
			return;
		}
		try {
			await tauri.core.invoke('update_apply');
		} catch (err) {
			console.error('[sidex-update] apply failed:', err);
		}
	}

	async quitAndInstall(): Promise<void> {
		const tauri = await this._tauriReady;
		if (!tauri) {
			return;
		}
		try {
			await tauri.core.invoke('update_quit_and_install');
		} catch (err) {
			console.error('[sidex-update] quit-and-install failed:', err);
		}
	}

	async _applySpecificUpdate(_packagePath: string): Promise<void> {
		// SideX doesn't expose side-loaded update packages; the VS Code flow
		// for this path isn't reachable in our UI.
	}

	async setInternalOrg(_internalOrg: string | undefined): Promise<void> {
		// Internal telemetry orgs are unused; keep the method for interface parity.
	}
}

function isState(value: unknown): value is State {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const type = (value as { type?: unknown }).type;
	return typeof type === 'string';
}

registerSingleton(IUpdateService, SidexUpdateService, InstantiationType.Eager);
