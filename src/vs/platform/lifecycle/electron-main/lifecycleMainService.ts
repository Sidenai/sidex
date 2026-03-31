/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '@tauri-apps/api/core';
import { exit } from '@tauri-apps/plugin-process';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getAllWindows } from '@tauri-apps/api/window';
import { validatedIpcMain } from '../../../base/parts/ipc/electron-main/ipcMain.js';
import { Barrier, Promises, timeout } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { isMacintosh, isWindows } from '../../../base/common/platform.js';
import { cwd } from '../../../base/common/process.js';
import { assertReturnsDefined } from '../../../base/common/types.js';
import { NativeParsedArgs } from '../../environment/common/argv.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';
import { IStateService } from '../../state/node/state.js';
import { ICodeWindow, LoadReason, UnloadReason } from '../../window/electron-main/window.js';
import { ISingleFolderWorkspaceIdentifier, IWorkspaceIdentifier } from '../../workspace/common/workspace.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { IAuxiliaryWindow } from '../../auxiliaryWindow/electron-main/auxiliaryWindow.js';

export const ILifecycleMainService = createDecorator<ILifecycleMainService>('lifecycleMainService');

interface WindowLoadEvent {

	/**
	 * The window that is loaded to a new workspace.
	 */
	readonly window: ICodeWindow;

	/**
	 * The workspace the window is loaded into.
	 */
	readonly workspace: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier | undefined;

	/**
	 * More details why the window loads to a new workspace.
	 */
	readonly reason: LoadReason;
}

export const enum ShutdownReason {

	/**
	 * The application exits normally.
	 */
	QUIT = 1,

	/**
	 * The application exits abnormally and is being
	 * killed with an exit code (e.g. from integration
	 * test run)
	 */
	KILL
}

export interface ShutdownEvent {

	/**
	 * More details why the application is shutting down.
	 */
	reason: ShutdownReason;

	/**
	 * Allows to join the shutdown. The promise can be a long running operation but it
	 * will block the application from closing.
	 */
	join(id: string, promise: Promise<void>): void;
}

export interface IRelaunchHandler {

	/**
	 * Allows a handler to deal with relaunching the application. The return
	 * value indicates if the relaunch is handled or not.
	 */
	handleRelaunch(options?: IRelaunchOptions): boolean;
}

export interface IRelaunchOptions {
	readonly addArgs?: string[];
	readonly removeArgs?: string[];
}

export interface ILifecycleMainService {

	readonly _serviceBrand: undefined;

	/**
	 * Will be true if the program was restarted (e.g. due to explicit request or update).
	 */
	readonly wasRestarted: boolean;

	/**
	 * Will be true if the program was requested to quit.
	 */
	readonly quitRequested: boolean;

	/**
	 * A flag indicating in what phase of the lifecycle we currently are.
	 */
	phase: LifecycleMainPhase;

	/**
	 * An event that fires when the application is about to shutdown before any window is closed.
	 * The shutdown can still be prevented by any window that vetos this event.
	 */
	readonly onBeforeShutdown: Event<void>;

	/**
	 * An event that fires after the onBeforeShutdown event has been fired and after no window has
	 * vetoed the shutdown sequence. At this point listeners are ensured that the application will
	 * quit without veto.
	 */
	readonly onWillShutdown: Event<ShutdownEvent>;

	/**
	 * An event that fires when a window is loading. This can either be a window opening for the
	 * first time or a window reloading or changing to another URL.
	 */
	readonly onWillLoadWindow: Event<WindowLoadEvent>;

	/**
	 * An event that fires before a window closes. This event is fired after any veto has been dealt
	 * with so that listeners know for sure that the window will close without veto.
	 */
	readonly onBeforeCloseWindow: Event<ICodeWindow>;

	/**
	 * Make a `ICodeWindow` known to the lifecycle main service.
	 */
	registerWindow(window: ICodeWindow): void;

	/**
	 * Make a `IAuxiliaryWindow` known to the lifecycle main service.
	 */
	registerAuxWindow(auxWindow: IAuxiliaryWindow): void;

	/**
	 * Reload a window. All lifecycle event handlers are triggered.
	 */
	reload(window: ICodeWindow, cli?: NativeParsedArgs): Promise<void>;

	/**
	 * Unload a window for the provided reason. All lifecycle event handlers are triggered.
	 */
	unload(window: ICodeWindow, reason: UnloadReason): Promise<boolean /* veto */>;

	/**
	 * Restart the application with optional arguments (CLI). All lifecycle event handlers are triggered.
	 */
	relaunch(options?: IRelaunchOptions): Promise<void>;

	/**
	 * Sets a custom handler for relaunching the application.
	 */
	setRelaunchHandler(handler: IRelaunchHandler): void;

	/**
	 * Shutdown the application normally. All lifecycle event handlers are triggered.
	 */
	quit(willRestart?: boolean): Promise<boolean /* veto */>;

	/**
	 * Forcefully shutdown the application and optionally set an exit code.
	 *
	 * This method should only be used in rare situations where it is important
	 * to set an exit code (e.g. running tests) or when the application is
	 * not in a healthy state and should terminate asap.
	 *
	 * This method does not fire the normal lifecycle events to the windows,
	 * that normally can be vetoed. Windows are destroyed without a chance
	 * of components to participate. The only lifecycle event handler that
	 * is triggered is `onWillShutdown` in the main process.
	 */
	kill(code?: number): Promise<void>;

	/**
	 * Returns a promise that resolves when a certain lifecycle phase
	 * has started.
	 */
	when(phase: LifecycleMainPhase): Promise<void>;
}

export const enum LifecycleMainPhase {

	/**
	 * The first phase signals that we are about to startup.
	 */
	Starting = 1,

	/**
	 * Services are ready and first window is about to open.
	 */
	Ready = 2,

	/**
	 * This phase signals a point in time after the window has opened
	 * and is typically the best place to do work that is not required
	 * for the window to open.
	 */
	AfterWindowOpen = 3,

	/**
	 * The last phase after a window has opened and some time has passed
	 * (2-5 seconds).
	 */
	Eventually = 4
}

export class LifecycleMainService extends Disposable implements ILifecycleMainService {

	declare readonly _serviceBrand: undefined;

	private static readonly QUIT_AND_RESTART_KEY = 'lifecycle.quitAndRestart';

	private readonly _onBeforeShutdown = this._register(new Emitter<void>());
	readonly onBeforeShutdown = this._onBeforeShutdown.event;

	private readonly _onWillShutdown = this._register(new Emitter<ShutdownEvent>());
	readonly onWillShutdown = this._onWillShutdown.event;

	private readonly _onWillLoadWindow = this._register(new Emitter<WindowLoadEvent>());
	readonly onWillLoadWindow = this._onWillLoadWindow.event;

	private readonly _onBeforeCloseWindow = this._register(new Emitter<ICodeWindow>());
	readonly onBeforeCloseWindow = this._onBeforeCloseWindow.event;

	private _quitRequested = false;
	get quitRequested(): boolean { return this._quitRequested; }

	private _wasRestarted = false;
	get wasRestarted(): boolean { return this._wasRestarted; }

	private _phase = LifecycleMainPhase.Starting;
	get phase(): LifecycleMainPhase { return this._phase; }

	private readonly windowToCloseRequest = new Set<number>();
	private oneTimeListenerTokenGenerator = 0;
	private windowCounter = 0;

	private pendingQuitPromise: Promise<boolean> | undefined = undefined;
	private pendingQuitPromiseResolve: { (veto: boolean): void } | undefined = undefined;

	private pendingWillShutdownPromise: Promise<void> | undefined = undefined;

	private readonly mapWindowIdToPendingUnload = new Map<number, Promise<boolean>>();

	private readonly phaseWhen = new Map<LifecycleMainPhase, Barrier>();

	private relaunchHandler: IRelaunchHandler | undefined = undefined;

	private beforeQuitUnlisten: UnlistenFn | undefined = undefined;
	private windowAllClosedUnlisten: UnlistenFn | undefined = undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IStateService private readonly stateService: IStateService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService
	) {
		super();

		this.resolveRestarted();
		this.when(LifecycleMainPhase.Ready).then(() => this.registerListeners());
	}

	private resolveRestarted(): void {
		this._wasRestarted = !!this.stateService.getItem(LifecycleMainService.QUIT_AND_RESTART_KEY);

		if (this._wasRestarted) {
			this.stateService.removeItem(LifecycleMainService.QUIT_AND_RESTART_KEY);
		}
	}

	private async registerListeners(): Promise<void> {

		// before-quit: an event that is fired if application quit was
		// requested but before any window was closed.
		const beforeQuitHandler = () => {
			if (this._quitRequested) {
				return;
			}

			this.trace('Lifecycle#app.on(before-quit)');
			this._quitRequested = true;

			this.trace('Lifecycle#onBeforeShutdown.fire()');
			this._onBeforeShutdown.fire();

			// macOS: can run without any window open. in that case we fire
			// the onWillShutdown() event directly because there is no veto
			// to be expected.
			if (isMacintosh && this.windowCounter === 0) {
				this.fireOnWillShutdown(ShutdownReason.QUIT);
			}
		};
		this.beforeQuitUnlisten = await listen('tauri://before-quit', beforeQuitHandler);

		// window-all-closed: when the last window was closed
		const windowAllClosedHandler = () => {
			this.trace('Lifecycle#app.on(window-all-closed)');

			// Windows/Linux: we quit when all windows have closed
			// Mac: we only quit when quit was requested
			if (this._quitRequested || !isMacintosh) {
				this.doQuitApp();
			}
		};
		this.windowAllClosedUnlisten = await listen('tauri://window-all-closed', windowAllClosedHandler);

		// will-quit: fired after all windows have been closed, but before
		// actually quitting.
		const willQuitUnlisten = await listen('tauri://will-quit', async () => {
			this.trace('Lifecycle#app.on(will-quit) - begin');

			const shutdownPromise = this.fireOnWillShutdown(ShutdownReason.QUIT);

			await shutdownPromise;

			this.trace('Lifecycle#app.on(will-quit) - after fireOnWillShutdown');

			this.resolvePendingQuitPromise(false /* no veto */);

			this.beforeQuitUnlisten?.();
			this.windowAllClosedUnlisten?.();

			this.trace('Lifecycle#app.on(will-quit) - calling app.quit()');

			this.doQuitApp();
		});
		// will-quit fires once then we clean up
		this._register({ dispose: () => willQuitUnlisten() });
	}

	private async doQuitApp(): Promise<void> {
		try {
			await invoke('quit_app');
		} catch {
			await exit(0);
		}
	}

	private fireOnWillShutdown(reason: ShutdownReason): Promise<void> {
		if (this.pendingWillShutdownPromise) {
			return this.pendingWillShutdownPromise;
		}

		const logService = this.logService;
		this.trace('Lifecycle#onWillShutdown.fire()');

		const joiners: Promise<void>[] = [];

		this._onWillShutdown.fire({
			reason,
			join(id, promise) {
				logService.trace(`Lifecycle#onWillShutdown - begin '${id}'`);
				joiners.push(promise.finally(() => {
					logService.trace(`Lifecycle#onWillShutdown - end '${id}'`);
				}));
			}
		});

		this.pendingWillShutdownPromise = (async () => {

			try {
				await Promises.settled(joiners);
			} catch (error) {
				this.logService.error(error);
			}

			try {
				await this.stateService.close();
			} catch (error) {
				this.logService.error(error);
			}
		})();

		return this.pendingWillShutdownPromise;
	}

	set phase(value: LifecycleMainPhase) {
		if (value < this.phase) {
			throw new Error('Lifecycle cannot go backwards');
		}

		if (this._phase === value) {
			return;
		}

		this.trace(`lifecycle (main): phase changed (value: ${value})`);

		this._phase = value;

		const barrier = this.phaseWhen.get(this._phase);
		if (barrier) {
			barrier.open();
			this.phaseWhen.delete(this._phase);
		}
	}

	async when(phase: LifecycleMainPhase): Promise<void> {
		if (phase <= this._phase) {
			return;
		}

		let barrier = this.phaseWhen.get(phase);
		if (!barrier) {
			barrier = new Barrier();
			this.phaseWhen.set(phase, barrier);
		}

		await barrier.wait();
	}

	registerWindow(window: ICodeWindow): void {
		const windowListeners = new DisposableStore();

		this.windowCounter++;

		// Window Will Load
		windowListeners.add(window.onWillLoad(e => this._onWillLoadWindow.fire({ window, workspace: e.workspace, reason: e.reason })));

		// Window Before Closing: Main -> Renderer
		const win = assertReturnsDefined(window.win);
		windowListeners.add(Event.fromNodeEventEmitter(win, 'close')((e: any) => {

			const windowId = window.id;
			if (this.windowToCloseRequest.delete(windowId)) {
				return;
			}

			this.trace(`Lifecycle#window.on('close') - window ID ${window.id}`);

			if (e && typeof e.preventDefault === 'function') {
				e.preventDefault();
			}
			this.unload(window, UnloadReason.CLOSE).then(veto => {
				if (veto) {
					this.windowToCloseRequest.delete(windowId);
					return;
				}

				this.windowToCloseRequest.add(windowId);

				this.trace(`Lifecycle#onBeforeCloseWindow.fire() - window ID ${windowId}`);
				this._onBeforeCloseWindow.fire(window);

				window.close();
			});
		}));
		windowListeners.add(Event.fromNodeEventEmitter(win, 'closed')(() => {
			this.trace(`Lifecycle#window.on('closed') - window ID ${window.id}`);

			this.windowCounter--;

			windowListeners.dispose();

			if (this.windowCounter === 0 && (!isMacintosh || this._quitRequested)) {
				this.fireOnWillShutdown(ShutdownReason.QUIT);
			}
		}));
	}

	registerAuxWindow(auxWindow: IAuxiliaryWindow): void {
		const win = assertReturnsDefined(auxWindow.win);

		const windowListeners = new DisposableStore();
		windowListeners.add(Event.fromNodeEventEmitter(win, 'close')((e: any) => {
			this.trace(`Lifecycle#auxWindow.on('close') - window ID ${auxWindow.id}`);

			if (this._quitRequested) {
				this.trace(`Lifecycle#auxWindow.on('close') - preventDefault() because quit requested`);

				if (e && typeof e.preventDefault === 'function') {
					e.preventDefault();
				}
			}
		}));
		windowListeners.add(Event.fromNodeEventEmitter(win, 'closed')(() => {
			this.trace(`Lifecycle#auxWindow.on('closed') - window ID ${auxWindow.id}`);

			windowListeners.dispose();
		}));
	}

	async reload(window: ICodeWindow, cli?: NativeParsedArgs): Promise<void> {

		const veto = await this.unload(window, UnloadReason.RELOAD);
		if (!veto) {
			window.reload(cli);
		}
	}

	unload(window: ICodeWindow, reason: UnloadReason): Promise<boolean /* veto */> {

		const pendingUnloadPromise = this.mapWindowIdToPendingUnload.get(window.id);
		if (pendingUnloadPromise) {
			return pendingUnloadPromise;
		}

		const unloadPromise = this.doUnload(window, reason).finally(() => {
			this.mapWindowIdToPendingUnload.delete(window.id);
		});
		this.mapWindowIdToPendingUnload.set(window.id, unloadPromise);

		return unloadPromise;
	}

	private async doUnload(window: ICodeWindow, reason: UnloadReason): Promise<boolean /* veto */> {

		if (!window.isReady) {
			return false;
		}

		this.trace(`Lifecycle#unload() - window ID ${window.id}`);

		const windowUnloadReason = this._quitRequested ? UnloadReason.QUIT : reason;
		const veto = await this.onBeforeUnloadWindowInRenderer(window, windowUnloadReason);
		if (veto) {
			this.trace(`Lifecycle#unload() - veto in renderer (window ID ${window.id})`);

			return this.handleWindowUnloadVeto(veto);
		}

		await this.onWillUnloadWindowInRenderer(window, windowUnloadReason);

		return false;
	}

	private handleWindowUnloadVeto(veto: boolean): boolean {
		if (!veto) {
			return false;
		}

		this.resolvePendingQuitPromise(true /* veto */);

		this._quitRequested = false;

		return true;
	}

	private resolvePendingQuitPromise(veto: boolean): void {
		if (this.pendingQuitPromiseResolve) {
			this.pendingQuitPromiseResolve(veto);
			this.pendingQuitPromiseResolve = undefined;
			this.pendingQuitPromise = undefined;
		}
	}

	private onBeforeUnloadWindowInRenderer(window: ICodeWindow, reason: UnloadReason): Promise<boolean /* veto */> {
		return new Promise<boolean>(resolve => {
			const oneTimeEventToken = this.oneTimeListenerTokenGenerator++;
			const okChannel = `vscode:ok${oneTimeEventToken}`;
			const cancelChannel = `vscode:cancel${oneTimeEventToken}`;

			validatedIpcMain.once(okChannel, () => {
				resolve(false);
			});

			validatedIpcMain.once(cancelChannel, () => {
				resolve(true);
			});

			window.send('vscode:onBeforeUnload', { okChannel, cancelChannel, reason });
		});
	}

	private onWillUnloadWindowInRenderer(window: ICodeWindow, reason: UnloadReason): Promise<void> {
		return new Promise<void>(resolve => {
			const oneTimeEventToken = this.oneTimeListenerTokenGenerator++;
			const replyChannel = `vscode:reply${oneTimeEventToken}`;

			validatedIpcMain.once(replyChannel, () => resolve());

			window.send('vscode:onWillUnload', { replyChannel, reason });
		});
	}

	quit(willRestart?: boolean): Promise<boolean /* veto */> {
		return this.doQuit(willRestart).then(veto => {
			if (!veto && willRestart) {
				try {
					if (isWindows) {
						const currentWorkingDir = cwd();
						if (currentWorkingDir !== process.cwd()) {
							process.chdir(currentWorkingDir);
						}
					}
				} catch (err) {
					this.logService.error(err);
				}
			}

			return veto;
		});
	}

	private doQuit(willRestart?: boolean): Promise<boolean /* veto */> {
		this.trace(`Lifecycle#quit() - begin (willRestart: ${willRestart})`);

		if (this.pendingQuitPromise) {
			this.trace('Lifecycle#quit() - returning pending quit promise');

			return this.pendingQuitPromise;
		}

		if (willRestart) {
			this.stateService.setItem(LifecycleMainService.QUIT_AND_RESTART_KEY, true);
		}

		this.pendingQuitPromise = new Promise(resolve => {

			this.pendingQuitPromiseResolve = resolve;

			this.trace('Lifecycle#quit() - calling app.quit()');
			this.doQuitApp();
		});

		return this.pendingQuitPromise;
	}

	private trace(msg: string): void {
		if (this.environmentMainService.args['enable-smoke-test-driver']) {
			this.logService.info(msg);
		} else {
			this.logService.trace(msg);
		}
	}

	setRelaunchHandler(handler: IRelaunchHandler): void {
		this.relaunchHandler = handler;
	}

	async relaunch(options?: IRelaunchOptions): Promise<void> {
		this.trace('Lifecycle#relaunch()');

		const args = process.argv.slice(1);
		if (options?.addArgs) {
			args.push(...options.addArgs);
		}

		if (options?.removeArgs) {
			for (const a of options.removeArgs) {
				const idx = args.indexOf(a);
				if (idx >= 0) {
					args.splice(idx, 1);
				}
			}
		}

		const quitUnlisten = await listen('tauri://quit', () => {
			if (!this.relaunchHandler?.handleRelaunch(options)) {
				this.trace('Lifecycle#relaunch() - calling invoke(relaunch_app)');
				invoke('relaunch_app', { args }).catch(() => {
					this.logService.error('Lifecycle#relaunch() - invoke(relaunch_app) failed');
				});
			}
		});

		const veto = await this.quit(true /* will restart */);
		if (veto) {
			quitUnlisten();
		}
	}

	async kill(code?: number): Promise<void> {
		this.trace('Lifecycle#kill()');

		await this.fireOnWillShutdown(ShutdownReason.KILL);

		// Destroy all open windows before exiting to avoid native crashes
		await Promise.race([

			timeout(1000),

			(async () => {
				const allWindows = await getAllWindows();
				for (const window of allWindows) {
					try {
						await window.destroy();
					} catch {
						// window may already be destroyed
					}
				}
			})()
		]);

		await exit(code ?? 0);
	}
}
