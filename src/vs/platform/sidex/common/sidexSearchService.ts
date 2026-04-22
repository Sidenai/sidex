import { invoke } from '../../../sidex-bridge.js';

export interface SearchMatch {
	path: string;
	lineNumber: number;
	lineText: string;
	matchStart: number;
	matchEnd: number;
}

export interface SearchResult {
	path: string;
	matches: SearchMatch[];
}

export class SideXSearchService {
	async searchText(
		directory: string,
		query: string,
		options?: {
			caseSensitive?: boolean;
			wholeWord?: boolean;
			regex?: boolean;
			include?: string;
			exclude?: string;
			maxResults?: number;
		}
	): Promise<SearchResult[]> {
		try {
			return (
				(await invoke('search_text', {
					dir: directory,
					query,
					caseSensitive: options?.caseSensitive ?? false,
					wholeWord: options?.wholeWord ?? false,
					regex: options?.regex ?? false,
					include: options?.include ?? null,
					exclude: options?.exclude ?? null,
					maxResults: options?.maxResults ?? 1000
				})) || []
			);
		} catch (e) {
			console.warn('[SideX] search failed:', e);
			return [];
		}
	}

	async searchFiles(directory: string, pattern: string): Promise<string[]> {
		try {
			return (await invoke('search_files', { dir: directory, pattern })) || [];
		} catch {
			return [];
		}
	}
}
