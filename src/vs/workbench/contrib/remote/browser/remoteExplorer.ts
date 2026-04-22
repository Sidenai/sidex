/*---------------------------------------------------------------------------------------------
 *  SideX — Remote Explorer pane.
 *
 *  Uses VS Code's standard tree-view infrastructure (WorkbenchAsyncDataTree)
 *  to show SSH hosts, WSL distros, Dev Containers, Codespaces, and Tunnels
 *  in a proper tree with collapsible sections and icon-label rows.
 *--------------------------------------------------------------------------------------------*/

import './media/remoteExplorer.css';

import { localize } from '../../../../nls.js';
import { Disposable as _Disposable } from '../../../../base/common/lifecycle.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import {
	ISideXRemoteService,
	SshHost,
	WslDistro,
	ContainerEntry,
	CodespaceEntry,
	RemoteKind
} from '../../../../platform/sidex/browser/sidexRemoteService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { localize2 } from '../../../../nls.js';
import { WorkbenchAsyncDataTree } from '../../../../platform/list/browser/listService.js';
import { IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { ITreeRenderer, ITreeNode, IAsyncDataSource } from '../../../../base/browser/ui/tree/tree.js';
import * as dom from '../../../../base/browser/dom.js';
import { IListAccessibilityProvider } from '../../../../base/browser/ui/list/listWidget.js';

// ── Tree data model ─────────────────────────────────────────────────────────

type RemoteTreeElement = RemoteSectionItem | RemoteLeafItem;

interface RemoteSectionItem {
	kind: 'section';
	id: string;
	label: string;
	icon: ThemeIcon;
	children: RemoteLeafItem[];
}

interface RemoteLeafItem {
	kind: 'leaf';
	id: string;
	label: string;
	description?: string;
	icon: ThemeIcon;
	active: boolean;
	actionLabel?: string;
	onActivate: () => void;
}

// ── Virtual delegate ────────────────────────────────────────────────────────

class RemoteTreeVirtualDelegate implements IListVirtualDelegate<RemoteTreeElement> {
	getHeight(_element: RemoteTreeElement): number {
		return 22;
	}
	getTemplateId(element: RemoteTreeElement): string {
		return element.kind === 'section' ? 'section' : 'leaf';
	}
}

// ── Section renderer ────────────────────────────────────────────────────────

interface ISectionTemplateData {
	icon: HTMLElement;
	label: HTMLElement;
}

class RemoteSectionRenderer implements ITreeRenderer<RemoteSectionItem, void, ISectionTemplateData> {
	readonly templateId = 'section';

	renderTemplate(container: HTMLElement): ISectionTemplateData {
		container.classList.add('remote-tree-section');
		const icon = dom.append(container, dom.$('.remote-tree-section-icon'));
		const label = dom.append(container, dom.$('.remote-tree-section-label'));
		return { icon, label };
	}

	renderElement(node: ITreeNode<RemoteSectionItem, void>, _index: number, templateData: ISectionTemplateData): void {
		const el = node.element;
		templateData.icon.className = 'remote-tree-section-icon ' + ThemeIcon.asClassName(el.icon);
		templateData.label.textContent = el.label;
	}

	disposeTemplate(_templateData: ISectionTemplateData): void {}
}

// ── Leaf renderer ───────────────────────────────────────────────────────────

interface ILeafTemplateData {
	container: HTMLElement;
	icon: HTMLElement;
	label: HTMLElement;
	description: HTMLElement;
	actionIcon: HTMLElement;
}

class RemoteLeafRenderer implements ITreeRenderer<RemoteLeafItem, void, ILeafTemplateData> {
	readonly templateId = 'leaf';

	renderTemplate(container: HTMLElement): ILeafTemplateData {
		container.classList.add('remote-tree-leaf');
		const icon = dom.append(container, dom.$('.remote-tree-leaf-icon'));
		const label = dom.append(container, dom.$('.remote-tree-leaf-label'));
		const description = dom.append(container, dom.$('.remote-tree-leaf-description'));
		const actionIcon = dom.append(container, dom.$('.remote-tree-leaf-action'));
		return { container, icon, label, description, actionIcon };
	}

	renderElement(node: ITreeNode<RemoteLeafItem, void>, _index: number, templateData: ILeafTemplateData): void {
		const el = node.element;
		templateData.icon.className = 'remote-tree-leaf-icon ' + ThemeIcon.asClassName(el.icon);
		templateData.label.textContent = el.label;
		templateData.label.title = el.label;
		templateData.description.textContent = el.description ?? '';
		templateData.description.title = el.description ?? '';

		if (el.active) {
			templateData.container.classList.add('active');
			templateData.actionIcon.className = 'remote-tree-leaf-action ' + ThemeIcon.asClassName(Codicon.check);
		} else {
			templateData.container.classList.remove('active');
			templateData.actionIcon.className = 'remote-tree-leaf-action ' + ThemeIcon.asClassName(Codicon.plug);
		}
		templateData.actionIcon.title = el.actionLabel ?? localize('remote.connect', 'Connect');
	}

	disposeTemplate(_templateData: ILeafTemplateData): void {}
}

// ── Data source ─────────────────────────────────────────────────────────────

class RemoteDataSource implements IAsyncDataSource<RemoteTreeElement[], RemoteTreeElement> {
	hasChildren(element: RemoteTreeElement[] | RemoteTreeElement): boolean {
		if (Array.isArray(element)) {
			return true;
		}
		return element.kind === 'section' && element.children.length > 0;
	}

	getChildren(element: RemoteTreeElement[] | RemoteTreeElement): RemoteTreeElement[] {
		if (Array.isArray(element)) {
			return element;
		}
		if (element.kind === 'section') {
			return element.children;
		}
		return [];
	}
}

// ── Accessibility ───────────────────────────────────────────────────────────

class RemoteAccessibilityProvider implements IListAccessibilityProvider<RemoteTreeElement> {
	getAriaLabel(element: RemoteTreeElement): string {
		return element.label;
	}
	getWidgetAriaLabel(): string {
		return localize('remoteExplorer', 'Remote Explorer');
	}
}

// ── View pane ───────────────────────────────────────────────────────────────

export class RemoteExplorerViewPane extends ViewPane {
	static readonly ID = 'workbench.view.remoteExplorer';
	static readonly NAME = localize2('remoteExplorer', 'Remote Explorer');

	private tree: WorkbenchAsyncDataTree<RemoteTreeElement[], RemoteTreeElement, void> | undefined;
	private treeContainer: HTMLElement | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ISideXRemoteService private readonly remoteService: ISideXRemoteService,
		@ICommandService private readonly commandService: ICommandService,
		@IQuickInputService private readonly quickInputService: IQuickInputService
	) {
		super(
			options,
			keybindingService,
			contextMenuService,
			configurationService,
			contextKeyService,
			viewDescriptorService,
			instantiationService,
			openerService,
			themeService,
			hoverService
		);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('remote-explorer-view');

		this.treeContainer = dom.append(container, dom.$('.remote-explorer-tree-container'));

		this.tree = this.instantiationService.createInstance(
			WorkbenchAsyncDataTree<RemoteTreeElement[], RemoteTreeElement, void>,
			'RemoteExplorer',
			this.treeContainer,
			new RemoteTreeVirtualDelegate(),
			[new RemoteSectionRenderer(), new RemoteLeafRenderer()],
			new RemoteDataSource(),
			{
				accessibilityProvider: new RemoteAccessibilityProvider(),
				collapseByDefault: () => false
			}
		);

		this._register(this.tree);

		this._register(
			this.tree.onDidOpen(e => {
				if (e.element && e.element.kind === 'leaf') {
					e.element.onActivate();
				}
			})
		);

		this.refresh();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.tree?.layout(height, width);
	}

	async refresh(): Promise<void> {
		if (!this.tree) {
			return;
		}

		const githubToken = await getCachedGitHubToken();

		const [sshHosts, wslDistros, containers, activeConns, codespaces] = await Promise.allSettled([
			this.remoteService.listSshHosts(),
			this.remoteService.listWslDistros(),
			this.remoteService.listContainers(),
			this.remoteService.activeConnections(),
			githubToken ? this.remoteService.listCodespaces(githubToken) : Promise.resolve([])
		]);

		const active = activeConns.status === 'fulfilled' ? activeConns.value : [];

		const sections: RemoteSectionItem[] = [];

		// --- Tunnels ---
		sections.push(this.buildTunnelSection(active, githubToken));

		// --- SSH ---
		const hosts = sshHosts.status === 'fulfilled' ? sshHosts.value : [];
		sections.push(this.buildSshSection(hosts, active));

		// --- GitHub Codespaces ---
		const spaces = codespaces.status === 'fulfilled' ? codespaces.value : [];
		sections.push(this.buildCodespacesSection(spaces, githubToken));

		// --- WSL (only if distros exist) ---
		const distros = wslDistros.status === 'fulfilled' ? wslDistros.value : [];
		if (distros.length > 0) {
			sections.push(this.buildWslSection(distros));
		}

		// --- Dev Containers ---
		const ctrs = containers.status === 'fulfilled' ? containers.value : [];
		sections.push(this.buildContainerSection(ctrs));

		await this.tree.setInput(sections);
		this.tree.expandAll();
	}

	// ── Section builders ──────────────────────────────────────────────────

	private buildTunnelSection(active: { label: string; kind: string }[], githubToken: string | null): RemoteSectionItem {
		const children: RemoteLeafItem[] = [];

		for (const t of active.filter(c => c.kind === 'tunnel')) {
			children.push({
				kind: 'leaf',
				id: `tunnel-active-${t.label}`,
				label: t.label,
				icon: Codicon.remote,
				active: true,
				onActivate: () => {}
			});
		}

		children.push({
			kind: 'leaf',
			id: 'tunnel-signin-microsoft',
			label: localize('remote.signInMicrosoft', 'Sign in with Microsoft'),
			icon: Codicon.account,
			active: false,
			description: localize('remote.tunnelsProvider', 'Remote-Tunnels'),
			actionLabel: localize('remote.signIn', 'Sign In'),
			onActivate: () => this.commandService.executeCommand('sidex.remote.signInTunnel', 'microsoft')
		});

		if (!githubToken) {
			children.push({
				kind: 'leaf',
				id: 'tunnel-signin-github',
				label: localize('remote.signInGitHub', 'Sign in with GitHub'),
				icon: Codicon.github,
				active: false,
				description: localize('remote.tunnelsProvider', 'Remote-Tunnels'),
				actionLabel: localize('remote.signIn', 'Sign In'),
				onActivate: () => this.commandService.executeCommand('sidex.remote.signInTunnel', 'github')
			});
		}

		return {
			kind: 'section',
			id: 'section-tunnels',
			label: localize('remote.tunnels', 'Tunnels'),
			icon: Codicon.remote,
			children
		};
	}

	private buildSshSection(hosts: SshHost[], active: { label: string; kind: string }[]): RemoteSectionItem {
		const children: RemoteLeafItem[] = [];

		if (hosts.length === 0) {
			children.push({
				kind: 'leaf',
				id: 'ssh-empty',
				label: localize('remote.ssh.noHosts', 'No SSH targets found in ~/.ssh/config'),
				icon: Codicon.info,
				active: false,
				onActivate: () => {}
			});
		} else {
			for (const host of hosts) {
				const label = `${host.user ? `${host.user}@` : ''}${host.host}${host.port ? `:${host.port}` : ''}`;
				const isConnected = active.some(c => c.kind === 'ssh' && c.label.includes(host.host));
				children.push({
					kind: 'leaf',
					id: `ssh-${host.host}`,
					label,
					description: host.hostname ?? undefined,
					icon: Codicon.vm,
					active: isConnected,
					onActivate: () => this.commandService.executeCommand('sidex.remote.connect', 'ssh' as RemoteKind, host)
				});
			}
		}

		return {
			kind: 'section',
			id: 'section-ssh',
			label: localize('remote.ssh', 'SSH'),
			icon: Codicon.remoteExplorer,
			children
		};
	}

	private buildCodespacesSection(spaces: CodespaceEntry[], githubToken: string | null): RemoteSectionItem {
		const children: RemoteLeafItem[] = [];

		if (!githubToken) {
			children.push({
				kind: 'leaf',
				id: 'codespace-signin',
				label: localize('remote.codespaces.signIn', 'Sign in with GitHub to see your Codespaces'),
				icon: Codicon.github,
				active: false,
				actionLabel: localize('remote.signIn', 'Sign In'),
				onActivate: () => this.commandService.executeCommand('sidex.remote.signInTunnel', 'github')
			});
		} else if (spaces.length === 0) {
			children.push({
				kind: 'leaf',
				id: 'codespace-empty',
				label: localize('remote.codespaces.empty', 'No Codespaces found'),
				icon: Codicon.info,
				active: false,
				onActivate: () => {}
			});
		} else {
			for (const space of spaces) {
				const isRunning = /available|running/i.test(space.state);
				children.push({
					kind: 'leaf',
					id: `codespace-${space.name}`,
					label: space.displayName,
					description: `${space.repository} • ${space.branch}`,
					icon: Codicon.github,
					active: isRunning,
					onActivate: async () => {
						try {
							await this.remoteService.connectCodespace(space.name, githubToken);
						} catch (err) {
							this.commandService.executeCommand('sidex.notify.error', String(err));
						}
					}
				});
			}
		}

		return {
			kind: 'section',
			id: 'section-codespaces',
			label: localize('remote.codespaces', 'GitHub Codespaces'),
			icon: Codicon.github,
			children
		};
	}

	private buildWslSection(distros: WslDistro[]): RemoteSectionItem {
		const children: RemoteLeafItem[] = distros.map(distro => ({
			kind: 'leaf' as const,
			id: `wsl-${distro.name}`,
			label: `${distro.name}${distro.isDefault ? ' (Default)' : ''}`,
			description: `WSL${distro.version} • ${distro.state}`,
			icon: Codicon.terminalLinux,
			active: false,
			onActivate: () => this.commandService.executeCommand('sidex.remote.connect', 'wsl' as RemoteKind, distro)
		}));

		return {
			kind: 'section',
			id: 'section-wsl',
			label: localize('remote.wsl', 'WSL Targets'),
			icon: Codicon.vm,
			children
		};
	}

	private buildContainerSection(ctrs: ContainerEntry[]): RemoteSectionItem {
		const children: RemoteLeafItem[] = [];

		if (ctrs.length === 0) {
			children.push({
				kind: 'leaf',
				id: 'container-empty',
				label: localize('remote.containers.noContainers', 'No running containers found'),
				icon: Codicon.info,
				active: false,
				onActivate: () => {}
			});
		} else {
			for (const ctr of ctrs) {
				const isRunning = /up|running/i.test(ctr.status);
				children.push({
					kind: 'leaf',
					id: `container-${ctr.id}`,
					label: ctr.name.replace(/^\//, ''),
					description: ctr.image,
					icon: Codicon.package,
					active: isRunning,
					onActivate: () =>
						isRunning
							? this.commandService.executeCommand('sidex.remote.connect', 'container' as RemoteKind, ctr)
							: undefined
				});
			}
		}

		return {
			kind: 'section',
			id: 'section-containers',
			label: localize('remote.containers', 'Dev Containers'),
			icon: Codicon.package,
			children
		};
	}
}

// ── Session-scoped cache for the stored GitHub token ─────────────────────────

/**
 * Caches the GitHub device-flow token for the lifetime of the window.
 * Each keychain access triggers a macOS "allow keychain access" prompt
 * on unsigned dev builds, so we read it once and reuse the value.  The
 * module-level cache is fine since the token is user-scoped and
 * cleared only on window reload (same lifecycle as the gallery service).
 */
let _githubTokenCache: { value: string | null; fetched: boolean } = { value: null, fetched: false };

export async function getCachedGitHubToken(): Promise<string | null> {
	if (_githubTokenCache.fetched) {
		return _githubTokenCache.value;
	}
	try {
		const { invoke } = await import('@tauri-apps/api/core');
		const token =
			(await invoke<string | null>('secret_get', {
				key: 'sidex.remote.github.device-flow'
			})) ?? null;
		_githubTokenCache = { value: token, fetched: true };
		return token;
	} catch {
		_githubTokenCache = { value: null, fetched: true };
		return null;
	}
}

/** Invalidate the cache — call after sign-in so the next read picks up the new token. */
export function clearCachedGitHubToken(): void {
	_githubTokenCache = { value: null, fetched: false };
}
