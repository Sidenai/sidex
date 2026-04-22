/*---------------------------------------------------------------------------------------------
 *  SideX — Remote development service.
 *  Thin TypeScript wrapper over the Tauri commands backed by the
 *  `sidex-remote` crate (SSH, WSL, Dev Containers, Codespaces).
 *
 *  Registration note: VS Code's IRemoteAgentService is already served by the
 *  `NullRemoteAgentService` (workbench/services/remote/browser/
 *  nullRemoteAgentService.ts) which delegates remote listing to this bridge.
 *  We additionally expose this bridge under its own decorator so UI code can
 *  access SSH / WSL / container / codespace management directly.
 *--------------------------------------------------------------------------------------------*/

import { invoke, isTauri } from '../../../sidex-bridge.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';

export type RemoteKind = 'ssh' | 'wsl' | 'container' | 'codespace' | 'tunnel';

export interface SshHost {
	host: string;
	hostname: string | null;
	port: number | null;
	user: string | null;
	identityFile: string | null;
}

export interface WslDistro {
	name: string;
	isDefault: boolean;
	version: number;
	state: string;
}

export interface ContainerEntry {
	id: string;
	name: string;
	image: string;
	status: string;
	ports: string;
}

export interface CodespaceEntry {
	name: string;
	displayName: string;
	repository: string;
	branch: string;
	machineType: string;
	state: string;
	createdAt: string;
	lastUsed: string;
}

export interface RemoteConnection {
	id: number;
	kind: RemoteKind;
	label: string;
	connectedSecs: number;
}

export interface RemoteExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export type SshAuth =
	| { kind: 'password'; password: string }
	| { kind: 'keyfile'; path: string; passphrase?: string }
	| { kind: 'agent' };

interface RawSshHost {
	host: string;
	hostname: string | null;
	port: number | null;
	user: string | null;
	identity_file: string | null;
}

interface RawWslDistro {
	name: string;
	is_default: boolean;
	version: number;
	state: string;
}

interface RawCodespace {
	name: string;
	display_name: string;
	repository: string;
	branch: string;
	machine_type: string;
	state: string;
	created_at: string;
	last_used: string;
}

interface RawConnection {
	id: number;
	kind: string;
	label: string;
	connected_secs: number;
}

interface RawExec {
	stdout: string;
	stderr: string;
	exit_code: number;
}

function toHost(r: RawSshHost): SshHost {
	return {
		host: r.host,
		hostname: r.hostname,
		port: r.port,
		user: r.user,
		identityFile: r.identity_file
	};
}

function toDistro(r: RawWslDistro): WslDistro {
	return { name: r.name, isDefault: r.is_default, version: r.version, state: r.state };
}

function toCodespace(r: RawCodespace): CodespaceEntry {
	return {
		name: r.name,
		displayName: r.display_name,
		repository: r.repository,
		branch: r.branch,
		machineType: r.machine_type,
		state: r.state,
		createdAt: r.created_at,
		lastUsed: r.last_used
	};
}

function toConnection(r: RawConnection): RemoteConnection {
	return {
		id: r.id,
		kind: r.kind as RemoteKind,
		label: r.label,
		connectedSecs: r.connected_secs
	};
}

export const ISideXRemoteService = createDecorator<ISideXRemoteService>('sidexRemoteService');

export interface ISideXRemoteService extends SideXRemoteService {
	readonly _serviceBrand: undefined;
}

export class SideXRemoteService {
	declare readonly _serviceBrand: undefined;
	async listSshHosts(): Promise<SshHost[]> {
		if (!isTauri()) {
			return [];
		}
		const raw = (await invoke<RawSshHost[]>('remote_list_ssh_hosts')) ?? [];
		return raw.map(toHost);
	}

	async connectSsh(host: string, user: string, port: number | undefined, auth: SshAuth): Promise<RemoteConnection> {
		const raw = await invoke<RawConnection>('remote_connect_ssh', {
			host,
			user,
			port: port ?? null,
			auth
		});
		return toConnection(raw);
	}

	async connectWsl(distro: string): Promise<RemoteConnection> {
		const raw = await invoke<RawConnection>('remote_connect_wsl', { distro });
		return toConnection(raw);
	}

	async connectContainer(configPath: string): Promise<RemoteConnection> {
		const raw = await invoke<RawConnection>('remote_connect_container', { configPath });
		return toConnection(raw);
	}

	async connectCodespace(name: string, githubToken: string): Promise<RemoteConnection> {
		const raw = await invoke<RawConnection>('remote_connect_codespace', { name, githubToken });
		return toConnection(raw);
	}

	async execSsh(connectionId: number, command: string): Promise<RemoteExecResult> {
		const raw = await invoke<RawExec>('remote_exec_ssh', { connectionId, command });
		return { stdout: raw.stdout, stderr: raw.stderr, exitCode: raw.exit_code };
	}

	async listWslDistros(): Promise<WslDistro[]> {
		if (!isTauri()) {
			return [];
		}
		const raw = (await invoke<RawWslDistro[]>('remote_list_wsl_distros')) ?? [];
		return raw.map(toDistro);
	}

	async listContainers(): Promise<ContainerEntry[]> {
		if (!isTauri()) {
			return [];
		}
		return (await invoke<ContainerEntry[]>('remote_list_containers')) ?? [];
	}

	async listCodespaces(githubToken: string): Promise<CodespaceEntry[]> {
		const raw = (await invoke<RawCodespace[]>('remote_codespaces_list', { githubToken })) ?? [];
		return raw.map(toCodespace);
	}

	async disconnect(connectionId: number): Promise<void> {
		await invoke('remote_disconnect', { connectionId });
	}

	async activeConnections(): Promise<RemoteConnection[]> {
		if (!isTauri()) {
			return [];
		}
		const raw = (await invoke<RawConnection[]>('remote_active_connections')) ?? [];
		return raw.map(toConnection);
	}
}

let _instance: SideXRemoteService | null = null;

export function getSideXRemoteService(): SideXRemoteService {
	if (!_instance) {
		_instance = new SideXRemoteService();
	}
	return _instance;
}

registerSingleton(ISideXRemoteService, SideXRemoteService, InstantiationType.Delayed);
