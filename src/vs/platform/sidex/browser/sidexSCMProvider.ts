/*---------------------------------------------------------------------------------------------
 *  SideX SCM Provider
 *  High-level wrapper that routes Source Control operations through the Rust
 *  `sidex-git` crate via Tauri IPC, intended for consumers that need a
 *  simplified, typed interface without directly touching the VS Code SCM API.
 *
 *  Registration note: VS Code's ISCMService (contrib/scm/common/scm.ts) is a
 *  rich interface for repository/resource groups and is unchanged. This bridge
 *  exposes a thin string-path API via its own decorator. TODO: build an
 *  ISCMProvider adapter on top of this to replace the default git extension.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '../../../sidex-bridge.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';

export interface GitFileStatus {
	path: string;
	status: string;
	staged: boolean;
}

export interface GitBranch {
	name: string;
	current: boolean;
	remote: boolean;
	upstream: string | null;
}

export interface GitLogEntry {
	hash: string;
	shortHash: string;
	author: string;
	date: string;
	message: string;
}

export const ISideXSCMProviderService = createDecorator<ISideXSCMProviderService>('sidexSCMProviderService');

export interface ISideXSCMProviderService extends SideXSCMProvider {
	readonly _serviceBrand: undefined;
}

export class SideXSCMProvider {
	declare readonly _serviceBrand: undefined;
	async getStatus(repoRoot: string): Promise<GitFileStatus[]> {
		try {
			return ((await invoke('git_status', { repoRoot })) as GitFileStatus[]) || [];
		} catch {
			return [];
		}
	}

	async getDiff(repoRoot: string, file?: string): Promise<string> {
		try {
			return ((await invoke('git_diff', { repoRoot, file: file ?? null })) as string) || '';
		} catch {
			return '';
		}
	}

	async getLog(repoRoot: string, maxCount: number = 50): Promise<GitLogEntry[]> {
		try {
			return ((await invoke('git_log', { repoRoot, maxCount })) as GitLogEntry[]) || [];
		} catch {
			return [];
		}
	}

	async getBranches(repoRoot: string): Promise<GitBranch[]> {
		try {
			return ((await invoke('git_branches', { repoRoot })) as GitBranch[]) || [];
		} catch {
			return [];
		}
	}

	async stage(repoRoot: string, paths: string[]): Promise<void> {
		await invoke('git_add', { repoRoot, paths });
	}

	async commit(repoRoot: string, message: string): Promise<void> {
		await invoke('git_commit', { repoRoot, message });
	}

	async checkout(repoRoot: string, ref: string): Promise<void> {
		await invoke('git_checkout', { repoRoot, ref });
	}

	async push(repoRoot: string): Promise<void> {
		await invoke('git_push', { repoRoot });
	}

	async pull(repoRoot: string): Promise<void> {
		await invoke('git_pull', { repoRoot });
	}

	async isRepo(path: string): Promise<boolean> {
		try {
			return (await invoke('git_is_repo', { path })) as boolean;
		} catch {
			return false;
		}
	}
}

registerSingleton(ISideXSCMProviderService, SideXSCMProvider, InstantiationType.Delayed);
