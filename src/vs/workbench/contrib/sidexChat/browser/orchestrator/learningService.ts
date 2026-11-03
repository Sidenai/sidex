/*---------------------------------------------------------------------------------------------
 *  Sidex Learning Service — Mines chat sessions to build workspace memory
 *
 *  Like Cursor's continual-learning plugin, but built natively:
 *  - Mines completed sessions for patterns, preferences, and facts
 *  - Stores learned context in .sidex/memory.md
 *  - Incrementally updates (doesn't rewrite) based on new sessions
 *  - Cadence-based triggers (not every session, only after N turns)
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ISidexChatService, IChatMessage } from '../sidexChatService.js';

interface LearnedFact {
	category: 'preference' | 'pattern' | 'convention' | 'architecture';
	content: string;
	confidence: number;
	source: string;
	learnedAt: number;
}

interface LearningState {
	lastRunAt: number;
	turnsSinceLastRun: number;
	processedSessionIds: string[];
}

const MIN_TURNS_BETWEEN_RUNS = 8;
const MIN_MINUTES_BETWEEN_RUNS = 30;
const MEMORY_FILE = '.sidex/memory.md';

export class SidexLearningService extends Disposable {
	private _state: LearningState = {
		lastRunAt: 0,
		turnsSinceLastRun: 0,
		processedSessionIds: [],
	};
	private _facts: LearnedFact[] = [];

	constructor(
		private readonly _chatService: ISidexChatService,
	) {
		super();
		this._loadState();
		this._register(this._chatService.onDidChangeStreaming(streaming => {
			if (!streaming) {
				this._state.turnsSinceLastRun++;
				this._checkTrigger();
			}
		}));
	}

	get facts(): readonly LearnedFact[] { return this._facts; }

	async runLearning(): Promise<void> {
		const sessions = await this._chatService.getSavedSessionsAsync();
		const unprocessed = sessions.filter(
			s => !this._state.processedSessionIds.includes(s.id)
		);

		if (unprocessed.length === 0) { return; }

		for (const session of unprocessed.slice(0, 5)) {
			await this._mineSession(session.id);
			this._state.processedSessionIds.push(session.id);
		}

		this._state.lastRunAt = Date.now();
		this._state.turnsSinceLastRun = 0;
		this._saveState();
		await this._writeMemoryFile();
	}

	private async _mineSession(sessionId: string): Promise<void> {
		await this._chatService.loadSessionAsync(sessionId);
		const messages = this._chatService.messages;

		if (messages.length < 4) { return; }

		const userMessages = messages.filter(m => m.role === 'user');
		const assistantMessages = messages.filter(m => m.role === 'assistant');

		this._extractPreferences(userMessages);
		this._extractPatterns(userMessages, assistantMessages);
		this._extractConventions(assistantMessages);
	}

	private _extractPreferences(userMessages: readonly IChatMessage[]): void {
		for (const msg of userMessages) {
			const text = msg.content.toLowerCase();

			// Detect explicit preferences
			if (text.includes('always') || text.includes('never') || text.includes('prefer')) {
				this._addFact({
					category: 'preference',
					content: msg.content.slice(0, 200),
					confidence: 0.8,
					source: 'explicit',
					learnedAt: Date.now(),
				});
			}

			// Detect style corrections
			if (text.includes('no,') || text.includes('not like that') || text.includes('instead')) {
				this._addFact({
					category: 'preference',
					content: `User correction: ${msg.content.slice(0, 150)}`,
					confidence: 0.9,
					source: 'correction',
					learnedAt: Date.now(),
				});
			}
		}
	}

	private _extractPatterns(
		userMessages: readonly IChatMessage[],
		assistantMessages: readonly IChatMessage[],
	): void {
		// Detect repeated file paths (frequently worked-on areas)
		const pathMentions = new Map<string, number>();
		for (const msg of [...userMessages, ...assistantMessages]) {
			const paths = msg.content.match(/(?:src|lib|crates|packages)\/[\w\-/.]+/g) || [];
			for (const p of paths) {
				pathMentions.set(p, (pathMentions.get(p) || 0) + 1);
			}
		}

		for (const [path, count] of pathMentions) {
			if (count >= 3) {
				this._addFact({
					category: 'pattern',
					content: `Frequently referenced: ${path}`,
					confidence: Math.min(0.5 + count * 0.1, 1.0),
					source: 'frequency',
					learnedAt: Date.now(),
				});
			}
		}
	}

	private _extractConventions(assistantMessages: readonly IChatMessage[]): void {
		for (const msg of assistantMessages) {
			// Look for tool calls that reveal project structure
			if (msg.toolCalls) {
				for (const tc of msg.toolCalls) {
					if (tc.name === 'read_file' && tc.output) {
						try {
							const args = JSON.parse(tc.input);
							if (args.path?.includes('package.json') || args.path?.includes('Cargo.toml')) {
								this._addFact({
									category: 'architecture',
									content: `Project config at ${args.path}`,
									confidence: 1.0,
									source: 'observation',
									learnedAt: Date.now(),
								});
							}
						} catch { /* ignore */ }
					}
				}
			}
		}
	}

	private _addFact(fact: LearnedFact): void {
		const exists = this._facts.some(f =>
			f.category === fact.category &&
			f.content === fact.content
		);
		if (!exists) {
			this._facts.push(fact);
		}
	}

	private _checkTrigger(): void {
		const minMs = MIN_MINUTES_BETWEEN_RUNS * 60 * 1000;
		const elapsed = Date.now() - this._state.lastRunAt;

		if (this._state.turnsSinceLastRun >= MIN_TURNS_BETWEEN_RUNS && elapsed >= minMs) {
			this.runLearning().catch(() => { });
		}
	}

	private async _writeMemoryFile(): Promise<void> {
		const invoke = this._getInvoke();
		if (!invoke || this._facts.length === 0) { return; }

		const sections: Record<string, string[]> = {
			preference: [],
			pattern: [],
			convention: [],
			architecture: [],
		};

		for (const fact of this._facts) {
			sections[fact.category]?.push(`- ${fact.content}`);
		}

		let content = '# Sidex Workspace Memory\n\n';
		content += '*Auto-generated from chat sessions. Do not edit manually.*\n\n';

		if (sections.preference.length > 0) {
			content += '## User Preferences\n\n';
			content += sections.preference.join('\n') + '\n\n';
		}
		if (sections.architecture.length > 0) {
			content += '## Architecture\n\n';
			content += sections.architecture.join('\n') + '\n\n';
		}
		if (sections.pattern.length > 0) {
			content += '## Patterns\n\n';
			content += sections.pattern.join('\n') + '\n\n';
		}
		if (sections.convention.length > 0) {
			content += '## Conventions\n\n';
			content += sections.convention.join('\n') + '\n\n';
		}

		try {
			await invoke('write_file', { path: MEMORY_FILE, contents: content });
		} catch { /* ignore write failures */ }
	}

	private _loadState(): void {
		try {
			const raw = localStorage.getItem('sidex.learning.state');
			if (raw) { this._state = JSON.parse(raw); }
			const facts = localStorage.getItem('sidex.learning.facts');
			if (facts) { this._facts = JSON.parse(facts); }
		} catch { /* use defaults */ }
	}

	private _saveState(): void {
		try {
			localStorage.setItem('sidex.learning.state', JSON.stringify(this._state));
			localStorage.setItem('sidex.learning.facts', JSON.stringify(this._facts));
		} catch { /* ignore */ }
	}

	private _getInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
		const g = globalThis as unknown as {
			__TAURI_INVOKE__?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
			__TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
		};
		return g.__TAURI_INVOKE__ ?? g.__TAURI_INTERNALS__?.invoke ?? null;
	}
}
