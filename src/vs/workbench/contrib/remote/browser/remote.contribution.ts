/*---------------------------------------------------------------------------------------------
 *  SideX — Remote workbench contribution.`
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import {
	IViewContainersRegistry,
	IViewsRegistry,
	ViewContainerLocation,
	Extensions as ViewContainerExtensions
} from '../../../common/views.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { RemoteExplorerViewPane, getCachedGitHubToken, clearCachedGitHubToken } from './remoteExplorer.js';
import { registerAction2, Action2, MenuId } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import {
	IStatusbarService,
	StatusbarAlignment,
	IStatusbarEntry,
	IStatusbarEntryAccessor
} from '../../../services/statusbar/browser/statusbar.js';
import {
	IWorkbenchContributionsRegistry,
	Extensions as WorkbenchExtensions,
	IWorkbenchContribution
} from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import {
	ISideXRemoteService,
	SshHost,
	WslDistro,
	ContainerEntry,
	RemoteKind
} from '../../../../platform/sidex/browser/sidexRemoteService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { URI } from '../../../../base/common/uri.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';

// ── Icons ─────────────────────────────────────────────────────────────────────

const remoteExplorerViewIcon = registerIcon(
	'remote-explorer-view-icon',
	Codicon.remoteExplorer,
	localize('remoteExplorerViewIcon', 'View icon of the Remote Explorer view.')
);

// ── View container ────────────────────────────────────────────────────────────

export const REMOTE_EXPLORER_VIEWLET_ID = 'workbench.view.remote';

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);

const remoteViewContainer = viewContainerRegistry.registerViewContainer(
	{
		id: REMOTE_EXPLORER_VIEWLET_ID,
		title: localize2('remoteExplorer', 'Remote Explorer'),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [
			REMOTE_EXPLORER_VIEWLET_ID,
			{ mergeViewWithContainerWhenSingleView: true }
		]),
		storageId: 'workbench.remote.views.state',
		icon: remoteExplorerViewIcon,
		order: 4,
		hideIfEmpty: false,
		viewOrderDelegate: {
			getOrder: (group?: string) => {
				if (!group) {
					return;
				}

				let matches = /^targets@(\d+)$/.exec(group);
				if (matches) {
					return -1000;
				}

				matches = /^details(@(\d+))?$/.exec(group);
				if (matches) {
					return -500 + Number(matches[2]);
				}

				matches = /^help(@(\d+))?$/.exec(group);
				if (matches) {
					return -10;
				}

				return;
			}
		}
	},
	ViewContainerLocation.Sidebar
);

// ── View ──────────────────────────────────────────────────────────────────────

const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

viewsRegistry.registerViews(
	[
		{
			id: RemoteExplorerViewPane.ID,
			name: RemoteExplorerViewPane.NAME,
			ctorDescriptor: new SyncDescriptor(RemoteExplorerViewPane),
			containerIcon: remoteExplorerViewIcon,
			order: 0,
			canToggleVisibility: false,
			canMoveView: false,
			focusCommand: {
				id: 'workbench.remote.focus',
				keybindings: {
					primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.F5
				}
			}
		}
	],
	remoteViewContainer
);

// ── Commands ──────────────────────────────────────────────────────────────────

registerAction2(
	class RefreshRemoteExplorer extends Action2 {
		constructor() {
			super({
				id: 'sidex.remote.refresh',
				title: localize2('sidex.remote.refresh', 'Refresh Remote Explorer'),
				icon: Codicon.refresh,
				menu: [
					{
						id: MenuId.ViewTitle,
						group: 'navigation',
						order: 1,
						when: ContextKeyExpr.equals('view', RemoteExplorerViewPane.ID)
					}
				]
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const viewsService = accessor.get(IViewsService);
			const view = viewsService.getActiveViewWithId<RemoteExplorerViewPane>(RemoteExplorerViewPane.ID);
			await view?.refresh();
		}
	}
);

registerAction2(
	class ConnectRemote extends Action2 {
		constructor() {
			super({ id: 'sidex.remote.connect', title: localize2('sidex.remote.connect', 'Connect to Remote') });
		}
		async run(
			accessor: ServicesAccessor,
			type: RemoteKind,
			payload: SshHost | WslDistro | ContainerEntry | { name: string }
		): Promise<void> {
			const remoteService = accessor.get(ISideXRemoteService);
			const notifications = accessor.get(INotificationService);
			try {
				if (type === 'ssh') {
					const host = payload as SshHost;
					await remoteService.connectSsh(host.host, host.user ?? 'root', host.port ?? undefined, { kind: 'agent' });
				}
				// WSL / containers: fire and forget with a notification for now
				else {
					notifications.notify({
						severity: Severity.Info,
						message: localize('remote.notImplemented', 'Remote connect for {0} coming soon', type)
					});
				}
			} catch (err) {
				notifications.error(String(err));
			}
		}
	}
);

registerAction2(
	class OpenRemoteExplorer extends Action2 {
		constructor() {
			super({
				id: 'sidex.remote.openExplorer',
				title: localize2('sidex.remote.openExplorer', 'Remote Explorer'),
				menu: [{ id: MenuId.CommandPalette }]
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const viewsService = accessor.get(IViewsService);
			await viewsService.openView(RemoteExplorerViewPane.ID, true);
		}
	}
);

registerAction2(
	class OpenRemoteWindow extends Action2 {
		constructor() {
			super({
				id: 'sidex.remote.openWindow',
				title: localize2('sidex.remote.openWindow', 'Connect to…'),
				menu: [{ id: MenuId.CommandPalette }]
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const quickInput = accessor.get(IQuickInputService);
			const commandService = accessor.get(ICommandService);
			const remoteService = accessor.get(ISideXRemoteService);
			const notifications = accessor.get(INotificationService);

			interface RemoteOption extends IQuickPickItem {
				action: () => void | Promise<void>;
			}

			const picks: RemoteOption[] = [
				{
					label: '$(remote) ' + localize('remote.pick.connectToTunnel', 'Connect to Tunnel…'),
					description: localize('remote.pick.tunnelsProvider', 'Remote-Tunnels'),
					action: () => commandService.executeCommand('sidex.remote.signInTunnel', 'github')
				},
				{
					label: '$(terminal-cmd) ' + localize('remote.pick.connectToHost', 'Connect to Host…'),
					description: localize('remote.pick.sshProvider', 'Remote-SSH'),
					action: () => pickAndConnectSsh(quickInput, notifications, remoteService)
				},
				{
					label: '$(terminal-linux) ' + localize('remote.pick.wsl', 'Connect to WSL…'),
					description: localize('remote.pick.wslProvider', 'Remote-WSL'),
					action: () => pickAndConnectWsl(quickInput, notifications, remoteService)
				},
				{
					label: '$(package) ' + localize('remote.pick.container', 'Open Folder in Container…'),
					description: localize('remote.pick.containerProvider', 'Dev Containers'),
					action: () => pickAndAttachContainer(quickInput, notifications, remoteService)
				},
				{
					label: '$(github) ' + localize('remote.pick.codespace', 'Connect to Codespace…'),
					description: localize('remote.pick.codespaceProvider', 'GitHub Codespaces'),
					action: async () => {
						// Session-cached token — avoids triggering a macOS
						// keychain authorization prompt on every invocation.
						let token = await getCachedGitHubToken();
						if (!token) {
							token =
								(await quickInput.input({
									prompt: localize('remote.codespace.tokenPrompt', 'GitHub personal access token with codespace scope'),
									password: true
								})) ?? null;
						}
						if (!token) {
							return;
						}

						try {
							const spaces = await remoteService.listCodespaces(token);
							if (!spaces.length) {
								notifications.info(localize('remote.codespace.none', 'No Codespaces found for this account.'));
							} else {
								const pick = await quickInput.pick(
									spaces.map(s => ({
										label: s.displayName,
										description: `${s.repository} • ${s.branch}`,
										detail: `${s.state} • ${s.machineType}`,
										codespace: s
									})),
									{ placeHolder: localize('remote.codespace.pick', 'Select a Codespace') }
								);
								if (pick) {
									try {
										await remoteService.connectCodespace(pick.codespace.name, token);
										notifications.info(
											localize('remote.codespace.connected', 'Connected to Codespace: {0}', pick.label)
										);
									} catch (err) {
										notifications.error(
											localize('remote.codespace.failed', 'Codespace connect failed: {0}', String(err))
										);
									}
								}
							}
						} catch (err) {
							notifications.error(String(err));
						}
					}
				}
			];

			const selected = await quickInput.pick(picks, {
				placeHolder: localize('remote.pick.placeholder', 'Select an option to open a Remote Window')
			});
			if (selected) {
				await (selected as RemoteOption).action();
			}
		}
	}
);

registerAction2(
	class SignInTunnel extends Action2 {
		constructor() {
			super({
				id: 'sidex.remote.signInTunnel',
				title: localize2('sidex.remote.signInTunnel', 'Sign in to Remote Tunnels')
			});
		}

		async run(accessor: ServicesAccessor, provider: 'microsoft' | 'github'): Promise<void> {
			const opener = accessor.get(IOpenerService);
			const notifications = accessor.get(INotificationService);
			const clipboardService = accessor.get(IClipboardService);

			if (provider !== 'github') {
				await opener.open(URI.parse('https://aka.ms/vscode-remote/tunnels'));
				return;
			}

			try {
				const deviceRes = await tauriProxyJson<{
					device_code: string;
					user_code: string;
					verification_uri: string;
					expires_in: number;
					interval: number;
				}>('https://github.com/login/device/code', 'POST', {
					client_id: GITHUB_CLIENT_ID,
					scope: 'codespace read:user'
				});

				await clipboardService.writeText(deviceRes.user_code);
				notifications.notify({
					severity: Severity.Info,
					message: localize(
						'remote.github.code',
						'Code {0} copied to clipboard. Paste it on GitHub to sign in.',
						deviceRes.user_code
					)
				});
				await opener.open(URI.parse(deviceRes.verification_uri));

				const token = await pollForGitHubToken(deviceRes.device_code, deviceRes.interval, deviceRes.expires_in);
				if (!token) {
					notifications.warn(localize('remote.github.timeout', 'GitHub sign-in timed out.'));
					return;
				}

				await storeGitHubToken(token);
				clearCachedGitHubToken();
				notifications.info(
					localize('remote.github.success', 'Signed in to GitHub. You can now list Codespaces and tunnels.')
				);
			} catch (err) {
				notifications.error(String(err));
			}
		}
	}
);

// ── Remote-type connect flows ────────────────────────────────────────────────

async function pickAndConnectSsh(
	quickInput: IQuickInputService,
	notifications: INotificationService,
	remoteService: ISideXRemoteService
): Promise<void> {
	const hosts = await remoteService.listSshHosts();

	interface HostItem extends IQuickPickItem {
		host?: SshHost;
		manual?: boolean;
	}

	const items: HostItem[] = [
		...hosts.map(h => ({
			label: `$(vm) ${h.host}`,
			description: `${h.user ?? 'root'}@${h.hostname ?? h.host}${h.port ? `:${h.port}` : ''}`,
			host: h
		})),
		{ label: '', kind: 'separator' } as HostItem,
		{
			label: `$(add) ${localize('remote.ssh.manual', 'Add New SSH Host…')}`,
			description: localize('remote.ssh.manualHint', 'user@hostname[:port]'),
			manual: true
		}
	];

	const pick = await quickInput.pick(items, {
		placeHolder: hosts.length
			? localize('remote.ssh.pick', 'Select an SSH host from ~/.ssh/config')
			: localize('remote.ssh.empty', 'No SSH targets in ~/.ssh/config — add one below')
	});
	if (!pick) {
		return;
	}

	let user: string;
	let host: string;
	let port: number | undefined;

	if (pick.manual) {
		const raw = await quickInput.input({
			prompt: localize('remote.ssh.enter', 'Enter user@host[:port]'),
			placeHolder: 'root@example.com:22'
		});
		if (!raw) {
			return;
		}
		const match = raw.match(/^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/);
		if (!match) {
			notifications.error(localize('remote.ssh.invalid', 'Invalid host format'));
			return;
		}
		user = match[1] ?? 'root';
		host = match[2];
		port = match[3] ? Number(match[3]) : undefined;
	} else {
		host = pick.host!.host;
		user = pick.host!.user ?? 'root';
		port = pick.host!.port ?? undefined;
	}

	try {
		await remoteService.connectSsh(host, user, port, { kind: 'agent' });
		notifications.info(localize('remote.ssh.connected', 'Connected to {0}@{1}', user, host));
	} catch (err) {
		notifications.error(localize('remote.ssh.failed', 'SSH connection failed: {0}', String(err)));
	}
}

async function pickAndConnectWsl(
	quickInput: IQuickInputService,
	notifications: INotificationService,
	remoteService: ISideXRemoteService
): Promise<void> {
	const distros = await remoteService.listWslDistros();
	if (!distros.length) {
		notifications.info(
			localize(
				'remote.wsl.unavailable',
				'WSL is not available on this machine. WSL requires Windows 10/11 with WSL installed.'
			)
		);
		return;
	}

	const pick = await quickInput.pick(
		distros.map(d => ({
			label: `$(terminal-linux) ${d.name}`,
			description: d.isDefault ? localize('remote.wsl.default', '(default)') : '',
			detail: `${d.state} • WSL${d.version}`,
			distro: d
		})),
		{ placeHolder: localize('remote.wsl.pick', 'Select a WSL distribution') }
	);
	if (!pick) {
		return;
	}

	try {
		await remoteService.connectWsl(pick.distro.name);
		notifications.info(localize('remote.wsl.connected', 'Connected to WSL: {0}', pick.distro.name));
	} catch (err) {
		notifications.error(localize('remote.wsl.failed', 'WSL connect failed: {0}', String(err)));
	}
}

async function pickAndAttachContainer(
	quickInput: IQuickInputService,
	notifications: INotificationService,
	remoteService: ISideXRemoteService
): Promise<void> {
	const containers = await remoteService.listContainers();

	interface ContainerItem extends IQuickPickItem {
		container?: ContainerEntry;
		configPath?: string;
	}

	const items: ContainerItem[] = [];

	// Running containers first
	if (containers.length) {
		for (const c of containers) {
			items.push({
				label: `$(package) ${c.name.replace(/^\//, '')}`,
				description: c.image,
				detail: `${c.status}${c.ports ? ` • ${c.ports}` : ''}`,
				container: c
			});
		}
	}

	items.push({ label: '', kind: 'separator' } as ContainerItem);
	items.push({
		label: `$(file) ${localize('remote.container.openConfig', 'Open Folder with devcontainer.json…')}`,
		description: localize('remote.container.configHint', 'Enter the path to a devcontainer.json file'),
		configPath: ''
	});

	if (!containers.length) {
		notifications.info(
			localize(
				'remote.container.noRunning',
				'No running containers found. Start one with Docker/Podman or pick a devcontainer.json file below.'
			)
		);
	}

	const pick = await quickInput.pick(items, {
		placeHolder: localize('remote.container.pick', 'Select a running container or devcontainer.json')
	});
	if (!pick) {
		return;
	}

	let configPath: string;
	if (pick.container) {
		configPath = pick.container.name.replace(/^\//, '');
	} else {
		const typed = await quickInput.input({
			prompt: localize('remote.container.enterPath', 'Path to devcontainer.json'),
			placeHolder: '/path/to/.devcontainer/devcontainer.json'
		});
		if (!typed) {
			return;
		}
		configPath = typed;
	}

	try {
		await remoteService.connectContainer(configPath);
		notifications.info(localize('remote.container.connected', 'Connected to container: {0}', configPath));
	} catch (err) {
		notifications.error(localize('remote.container.failed', 'Container connect failed: {0}', String(err)));
	}
}

// ── GitHub OAuth helpers ─────────────────────────────────────────────────────

const GITHUB_CLIENT_ID = 'Ov23liCQ4Z5wGSG73N6F';

async function tauriProxyJson<T>(
	url: string,
	method: 'GET' | 'POST',
	body: Record<string, string> | undefined
): Promise<T> {
	const { invoke } = await import('@tauri-apps/api/core');
	const bodyStr = body ? new URLSearchParams(body).toString() : null;
	const result = await invoke<{ status: number; headers: Record<string, string>; body_b64: string }>(
		'proxy_request_full',
		{
			url,
			method,
			headers: {
				accept: 'application/json',
				'content-type': 'application/x-www-form-urlencoded'
			},
			body: bodyStr
		}
	);
	if (result.status < 200 || result.status >= 300) {
		throw new Error(`GitHub ${method} ${url} → ${result.status}`);
	}
	const bodyBytes = Uint8Array.from(atob(result.body_b64), c => c.charCodeAt(0));
	const text = new TextDecoder().decode(bodyBytes);
	return JSON.parse(text) as T;
}

async function pollForGitHubToken(
	deviceCode: string,
	intervalSecs: number,
	expiresInSecs: number
): Promise<string | null> {
	const deadline = Date.now() + expiresInSecs * 1000;
	let delay = Math.max(5, intervalSecs) * 1000;

	while (Date.now() < deadline) {
		await new Promise(r => setTimeout(r, delay));
		let res: { access_token?: string; error?: string; interval?: number };
		try {
			res = await tauriProxyJson<typeof res>('https://github.com/login/oauth/access_token', 'POST', {
				client_id: GITHUB_CLIENT_ID,
				device_code: deviceCode,
				grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
			});
		} catch {
			continue;
		}
		if (res.access_token) {
			return res.access_token;
		}
		if (res.error === 'slow_down' && res.interval) {
			delay = res.interval * 1000;
		}
		if (res.error === 'access_denied' || res.error === 'expired_token') {
			return null;
		}
	}
	return null;
}

async function storeGitHubToken(token: string): Promise<void> {
	const { invoke } = await import('@tauri-apps/api/core');
	await invoke('secret_set', {
		key: 'sidex.remote.github.device-flow',
		value: token
	});
}

// ── Status bar `><` indicator ─────────────────────────────────────────────────

class RemoteStatusBarIndicator extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.remoteStatusBar';

	private entry: IStatusbarEntryAccessor | undefined;

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@ISideXRemoteService private readonly remoteService: ISideXRemoteService
	) {
		super();
		this.entry = this._register(
			this.statusbarService.addEntry(
				this.buildEntry(null),
				'status.host',
				StatusbarAlignment.LEFT,
				Number.MAX_SAFE_INTEGER
			)
		);
		this.updateFromConnections();
	}

	private buildEntry(label: string | null): IStatusbarEntry {
		const text = label ? `$(remote) ${label}` : '$(remote)';
		const ariaLabel = label
			? localize('remote.statusbar.ariaConnected', 'Remote — connected to {0}', label)
			: localize('remote.statusbar.aria', 'Open a remote window');
		return {
			name: localize('remote.statusbar.name', 'Open a Remote Window'),
			kind: label ? 'remote' : undefined,
			text,
			ariaLabel,
			tooltip: localize('remote.statusbar.tooltip', 'Open a Remote Window'),
			command: 'sidex.remote.openWindow'
		};
	}

	private async updateFromConnections(): Promise<void> {
		const conns = await this.remoteService.activeConnections().catch(() => []);
		if (!this.entry) {
			return;
		}
		const first = conns[0];
		this.entry.update(this.buildEntry(first?.label ?? null));
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	RemoteStatusBarIndicator,
	LifecyclePhase.Restored
);
