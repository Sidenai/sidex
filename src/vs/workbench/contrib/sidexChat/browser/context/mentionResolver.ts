/*---------------------------------------------------------------------------------------------
 *  MentionResolver — resolves @ mentions to file/folder/symbol content for Sidex Chat
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';

export type MentionType = 'file' | 'folder' | 'symbol' | 'url' | 'selection' | 'codebase';

export interface MentionItem {
	type: MentionType;
	label: string;
	detail?: string;
	fullPath?: string;
	content?: string;
	iconClass?: string;
}

interface IFileSystemProvider {
	findFiles(pattern: string, maxResults: number): Promise<URI[]>;
	readFile(uri: URI): Promise<string>;
	readDirectory(uri: URI): Promise<Array<[string, 'file' | 'directory']>>;
	getWorkspaceFolderPath(): string | undefined;
}

interface ICodebaseSearchProvider {
	search(query: string, limit: number, budget: number): Promise<string>;
}

const FILE_EXTENSIONS: Record<string, string> = {
	'.ts': 'TypeScript', '.tsx': 'TypeScript React', '.js': 'JavaScript',
	'.jsx': 'JavaScript React', '.rs': 'Rust', '.go': 'Go', '.py': 'Python',
	'.java': 'Java', '.c': 'C', '.cpp': 'C++', '.h': 'C Header',
	'.css': 'CSS', '.html': 'HTML', '.json': 'JSON', '.md': 'Markdown',
	'.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML', '.sql': 'SQL',
	'.sh': 'Shell', '.bash': 'Shell', '.vue': 'Vue', '.svelte': 'Svelte',
};

const MAX_SUGGESTIONS = 10;
const MAX_FILE_LINES = 500;
const TREE_DEPTH = 2;

export class MentionResolver {
	private _fsProvider: IFileSystemProvider;
	private _codebaseProvider: ICodebaseSearchProvider | null;

	constructor(fsProvider: IFileSystemProvider, codebaseProvider?: ICodebaseSearchProvider) {
		this._fsProvider = fsProvider;
		this._codebaseProvider = codebaseProvider ?? null;
	}

	async getSuggestions(query: string): Promise<MentionItem[]> {
		const trimmed = query.trim();
		if (!trimmed) {
			return this._getDefaultSuggestions();
		}

		if (trimmed === 'codebase' || trimmed.startsWith('codebase ')) {
			return [{
				type: 'codebase',
				label: 'codebase',
				detail: 'Search the entire indexed codebase',
				iconClass: 'codicon-search',
			}];
		}

		const isFileLike = trimmed.startsWith('/') || trimmed.includes('.') || trimmed.includes('/');
		if (isFileLike) {
			return this._searchFiles(trimmed);
		}

		// Treat as general name search — match against files and folders
		return this._searchFiles(trimmed);
	}

	async resolve(item: MentionItem): Promise<string> {
		switch (item.type) {
			case 'file':
				return this._resolveFile(item);
			case 'folder':
				return this._resolveFolder(item);
			case 'codebase':
				return this._resolveCodebase(item);
			case 'selection':
				return item.content || '';
			case 'url':
				return `[URL: ${item.label}]`;
			case 'symbol':
				return item.content || `[Symbol: ${item.label}]`;
			default:
				return '';
		}
	}

	async resolveCodebaseQuery(query: string, limit = 15, budget = 6000): Promise<string> {
		if (!this._codebaseProvider) {
			return '[Codebase search unavailable — no search provider configured]';
		}
		try {
			return await this._codebaseProvider.search(query, limit, budget);
		} catch {
			return '[Codebase search failed]';
		}
	}

	private async _resolveCodebase(item: MentionItem): Promise<string> {
		const query = item.content || item.detail || '';
		if (!query) {
			return '[No codebase search query provided]';
		}
		return this.resolveCodebaseQuery(query);
	}

	private async _getDefaultSuggestions(): Promise<MentionItem[]> {
		const items: MentionItem[] = [];

		// Suggest some common files from the workspace
		try {
			const uris = await this._fsProvider.findFiles('**/*', 15);
			for (const uri of uris.slice(0, MAX_SUGGESTIONS)) {
				const wsRoot = this._fsProvider.getWorkspaceFolderPath();
				const fullPath = uri.fsPath;
				const label = wsRoot ? fullPath.replace(wsRoot + '/', '') : fullPath;
				const ext = this._getExtension(label);
				items.push({
					type: 'file',
					label,
					detail: FILE_EXTENSIONS[ext] || 'File',
					fullPath,
					iconClass: 'codicon-file',
				});
			}
		} catch {
			// workspace APIs unavailable
		}

		return items;
	}

	private async _searchFiles(query: string): Promise<MentionItem[]> {
		const items: MentionItem[] = [];

		try {
			const glob = `**/*${query}*`;
			const uris = await this._fsProvider.findFiles(glob, 30);

			const wsRoot = this._fsProvider.getWorkspaceFolderPath();

			for (const uri of uris) {
				const fullPath = uri.fsPath;
				const label = wsRoot ? fullPath.replace(wsRoot + '/', '') : fullPath;
				const ext = this._getExtension(label);

				const isDir = !ext;
				items.push({
					type: isDir ? 'folder' : 'file',
					label,
					detail: isDir ? 'Folder' : (FILE_EXTENSIONS[ext] || 'File'),
					fullPath,
					iconClass: isDir ? 'codicon-folder' : 'codicon-file',
				});

				if (items.length >= MAX_SUGGESTIONS) { break; }
			}
		} catch {
			// search failed
		}

		return items;
	}

	private async _resolveFile(item: MentionItem): Promise<string> {
		if (!item.fullPath) { return ''; }

		try {
			const uri = URI.file(item.fullPath);
			const content = await this._fsProvider.readFile(uri);
			const lines = content.split('\n');

			if (lines.length <= MAX_FILE_LINES) {
				return content;
			}

			const half = Math.floor(MAX_FILE_LINES / 2);
			const head = lines.slice(0, half).join('\n');
			const tail = lines.slice(-half).join('\n');
			return `${head}\n\n... [${lines.length - MAX_FILE_LINES} lines truncated] ...\n\n${tail}`;
		} catch {
			return `[Could not read file: ${item.label}]`;
		}
	}

	private async _resolveFolder(item: MentionItem): Promise<string> {
		if (!item.fullPath) { return ''; }

		try {
			const uri = URI.file(item.fullPath);
			const tree = await this._buildTree(uri, TREE_DEPTH, '');
			return tree;
		} catch {
			return `[Could not read folder: ${item.label}]`;
		}
	}

	private async _buildTree(uri: URI, depth: number, indent: string): Promise<string> {
		if (depth <= 0) { return ''; }

		const entries = await this._fsProvider.readDirectory(uri);
		const lines: string[] = [];

		const sorted = entries.sort((a, b) => {
			if (a[1] === b[1]) { return a[0].localeCompare(b[0]); }
			return a[1] === 'directory' ? -1 : 1;
		});

		for (const [name, type] of sorted) {
			if (name.startsWith('.') || name === 'node_modules' || name === '__pycache__') {
				continue;
			}

			const icon = type === 'directory' ? '📁' : '📄';
			lines.push(`${indent}${icon} ${name}`);

			if (type === 'directory' && depth > 1) {
				const childUri = URI.joinPath(uri, name);
				const subTree = await this._buildTree(childUri, depth - 1, indent + '  ');
				if (subTree) { lines.push(subTree); }
			}
		}

		return lines.join('\n');
	}

	private _getExtension(path: string): string {
		const idx = path.lastIndexOf('.');
		if (idx === -1) { return ''; }
		return path.slice(idx).toLowerCase();
	}
}
