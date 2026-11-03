/*---------------------------------------------------------------------------------------------
 *  SideX auto-update workbench contribution.
 *
 *  Delivers the Cursor-style update experience on top of SidexUpdateService:
 *    - checks for updates on startup (5s delay) and every 4 hours
 *    - accepts immediate server-pushed update notifications via WebSocket
 *    - when an update is available, prompts the user with "Install Now" or "Later"
 *    - when an update is downloaded and ready, prompts "Restart to Update" or "Later"
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IUpdateService, StateType, State } from '../../../../platform/update/common/update.js';
import { INotificationService, Severity, INotificationHandle } from '../../../../platform/notification/common/notification.js';

const INITIAL_CHECK_DELAY = 5 * 1000; // Check 5s after startup (Cursor style)
const RECHECK_INTERVAL = 4 * 60 * 60 * 1000; // Check every 4 hours

export class SidexUpdateContribution extends Disposable {

	private _notification: INotificationHandle | undefined;
	private _notifiedVersion: string | undefined;
	private _notifiedState: StateType | undefined;

	constructor(
		@IUpdateService private readonly updateService: IUpdateService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();

		this._register(this.updateService.onStateChange(state => this._onState(state)));

		// Startup check, then periodic recheck.
		const initial = setTimeout(() => this.updateService.checkForUpdates(false), INITIAL_CHECK_DELAY);
		const interval = setInterval(() => {
			this.updateService.checkForUpdates(false);
			// Reset notification state each cycle so reminders can re-surface if dismissed.
			this._notifiedVersion = undefined;
			this._notifiedState = undefined;
			this._onState(this.updateService.state);
		}, RECHECK_INTERVAL);
		this._register({ dispose: () => { clearTimeout(initial); clearInterval(interval); } });
	}

	private _onState(state: State): void {
		switch (state.type) {
			case StateType.AvailableForDownload:
				// An update is available: prompt the user to download/install now or later.
				this._showAvailableNotification(state.update.productVersion ?? state.update.version);
				break;

			case StateType.Downloaded:
				// win32 setup flow: apply the update to stage it.
				this.updateService.applyUpdate();
				break;

			case StateType.Ready:
				// The update is staged and ready: prompt to restart.
				this._showReadyNotification(state.update.productVersion ?? state.update.version);
				break;

			default:
				break;
		}
	}

	private _showAvailableNotification(version: string): void {
		if (this._notifiedVersion === version && this._notifiedState === StateType.AvailableForDownload) {
			return;
		}
		this._notifiedVersion = version;
		this._notifiedState = StateType.AvailableForDownload;
		this._notification?.close();

		this._notification = this.notificationService.notify({
			severity: Severity.Info,
			message: `An update to SideX ${version} is available.`,
			sticky: true,
			actions: {
				primary: [
					{
						id: 'sidex.update.download',
						label: 'Install Now',
						tooltip: 'Download and install the update in the background',
						class: undefined,
						enabled: true,
						run: () => {
							this._notification?.close();
							this.updateService.downloadUpdate(false);
						},
					},
					{
						id: 'sidex.update.later',
						label: 'Later',
						tooltip: 'Remind me later',
						class: undefined,
						enabled: true,
						run: () => {
							this._notification?.close();
						},
					}
				],
			},
		});
		this._register({ dispose: () => this._notification?.close() });
	}

	private _showReadyNotification(version: string): void {
		if (this._notifiedVersion === version && this._notifiedState === StateType.Ready) {
			return;
		}
		this._notifiedVersion = version;
		this._notifiedState = StateType.Ready;
		this._notification?.close();

		this._notification = this.notificationService.notify({
			severity: Severity.Info,
			message: `SideX ${version} has been successfully downloaded and is ready to install.`,
			sticky: true,
			actions: {
				primary: [
					{
						id: 'sidex.update.restart',
						label: 'Restart to Update',
						tooltip: 'Relaunch SideX to apply the update',
						class: undefined,
						enabled: true,
						run: () => {
							this._notification?.close();
							this.updateService.quitAndInstall();
						},
					},
					{
						id: 'sidex.update.ready_later',
						label: 'Later',
						tooltip: 'Apply on next restart',
						class: undefined,
						enabled: true,
						run: () => {
							this._notification?.close();
						},
					}
				],
			},
		});
		this._register({ dispose: () => this._notification?.close() });
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(SidexUpdateContribution, LifecyclePhase.Restored);
