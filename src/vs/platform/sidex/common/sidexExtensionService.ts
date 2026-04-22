/*---------------------------------------------------------------------------------------------
 *  SideX - Marketplace + installed-extension bridge.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '../../../sidex-bridge.js';

export interface MarketplaceExtensionResult {
	id: string;
	name: string;
	displayName: string;
	description: string;
	version: string;
	publisher: string;
	installCount: number;
	rating: number;
	iconUrl?: string;
	downloadUrl: string;
}

interface CachedSearch {
	results: MarketplaceExtensionResult[];
	fetchedAt: number;
}

const TS_CACHE_TTL_MS = 30_000;
const DEFAULT_DEBOUNCE_MS = 150;

export class SideXExtensionService {
	private readonly _cache = new Map<string, CachedSearch>();
	private readonly _inflight = new Map<string, Promise<MarketplaceExtensionResult[]>>();
	private _debounceTimer: ReturnType<typeof setTimeout> | undefined;

	async searchMarketplace(query: string, page = 0): Promise<MarketplaceExtensionResult[]> {
		const trimmed = query.trim();
		if (!trimmed) {
			return [];
		}
		const key = `${trimmed}|${page}`;
		const cached = this._cache.get(key);
		if (cached && Date.now() - cached.fetchedAt < TS_CACHE_TTL_MS) {
			return cached.results;
		}
		const pending = this._inflight.get(key);
		if (pending) {
			return pending;
		}
		const fetchPromise = (async () => {
			try {
				const raw = await invoke<unknown[]>('extension_search_marketplace', {
					query: trimmed,
					page
				});
				const results = (raw ?? []) as MarketplaceExtensionResult[];
				this._cache.set(key, { results, fetchedAt: Date.now() });
				if (this._cache.size > 128) {
					const oldestKey = [...this._cache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0]?.[0];
					if (oldestKey) {
						this._cache.delete(oldestKey);
					}
				}
				return results;
			} catch {
				return [];
			} finally {
				this._inflight.delete(key);
			}
		})();
		this._inflight.set(key, fetchPromise);
		return fetchPromise;
	}

	/** Keystroke-friendly variant. Resolves with the results for the
	 * *final* paused query; earlier invocations resolve with `[]`. */
	async debouncedSearch(query: string, page = 0, delayMs = DEFAULT_DEBOUNCE_MS): Promise<MarketplaceExtensionResult[]> {
		return new Promise(resolve => {
			if (this._debounceTimer) {
				clearTimeout(this._debounceTimer);
			}
			this._debounceTimer = setTimeout(async () => {
				const results = await this.searchMarketplace(query, page);
				resolve(results);
			}, delayMs);
		});
	}

	async getInstalled(): Promise<unknown[]> {
		try {
			return (await invoke<unknown[]>('list_installed_extensions')) || [];
		} catch {
			return [];
		}
	}

	async install(id: string): Promise<void> {
		return invoke('install_extension', { extensionId: id });
	}

	async uninstall(id: string): Promise<void> {
		return invoke('uninstall_extension', { extensionId: id });
	}
}
