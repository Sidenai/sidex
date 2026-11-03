/*---------------------------------------------------------------------------------------------
 *  Sidex Subagent System — Types, routing, and tool restrictions per agent type
 *
 *  Architecture matches Cursor exactly:
 *  - Main agent: persistent, stateful, sees full conversation + IDE state
 *  - Subagents: spawned via task tool, isolated, typed, can run in parallel
 *  - Each type has specific tool access restrictions
 *  - Subagents can be resumed by ID
 *  - Results flow back to parent agent
 *--------------------------------------------------------------------------------------------*/

export type SubagentType =
	| 'generalPurpose'  // Full tools: read, write, edit, shell, search, web, can spawn sub-subagents
	| 'explore'         // Read-only, fast: Glob, Grep, Read, SemanticSearch
	| 'shell'           // Terminal specialist: Shell, AwaitShell, Read (for output)
	| 'codeReview'      // Reviews code: Read, Grep, Glob (read-only with review focus)
	| 'ciInvestigator'  // CI failure detective: Shell (gh commands), Read
	| 'bestOfN';        // Isolated git worktree: full tools, own branch

export interface SubagentConfig {
	type: SubagentType;
	tools: string[];
	systemPrompt: string;
	readonly: boolean;
	isolated: boolean;
}

export const SUBAGENT_CONFIGS: Record<SubagentType, SubagentConfig> = {
	generalPurpose: {
		type: 'generalPurpose',
		tools: [
			'read_file', 'write_file', 'delete_file', 'edit_file', 'multi_edit', 'semantic_edit',
			'list_dir', 'tree', 'glob', 'search_files', 'file_info', 'batch_read',
			'grep', 'shell', 'git_status', 'git_log', 'git_diff_file', 'git_commit',
			'context_search', 'understand_symbol', 'lsp_diagnostics',
			'run_and_fix', 'diff_preview', 'checkpoint', 'rollback',
			'web_search', 'web_fetch',
			'task',
		],
		systemPrompt: `You are a general-purpose subagent with full tool access.
You can read, write, edit files, run shell commands, search code, and spawn your own sub-subagents.
Complete the task thoroughly. Report back with what you did and any relevant findings.`,
		readonly: false,
		isolated: false,
	},

	explore: {
		type: 'explore',
		tools: [
			'read_file', 'batch_read', 'list_dir', 'tree',
			'glob', 'search_files', 'file_info',
			'grep', 'context_search', 'understand_symbol',
			'diff_preview',
		],
		systemPrompt: `You are a fast, read-only exploration agent.
You can search and read files but CANNOT modify anything or run commands.
Find what's asked for quickly and report back with file paths, line numbers, and relevant code.`,
		readonly: true,
		isolated: false,
	},

	shell: {
		type: 'shell',
		tools: [
			'shell', 'run_and_fix', 'read_file', 'list_dir',
		],
		systemPrompt: `You are a shell/terminal specialist agent.
You can run bash commands (git, npm, cargo, etc.) and read files/output.
Execute the requested commands and report results.`,
		readonly: false,
		isolated: false,
	},

	codeReview: {
		type: 'codeReview',
		tools: [
			'read_file', 'batch_read', 'list_dir',
			'glob', 'grep', 'search_files',
			'git_diff_file', 'git_status', 'git_log',
			'understand_symbol', 'diff_preview', 'context_search',
		],
		systemPrompt: `You are a code review agent.
Review the specified code for bugs, style issues, performance problems, and security concerns.
You can read files and check git diffs but cannot modify anything.
Provide specific, actionable feedback with file paths and line numbers.`,
		readonly: true,
		isolated: false,
	},

	ciInvestigator: {
		type: 'ciInvestigator',
		tools: [
			'shell', 'read_file', 'grep', 'glob',
		],
		systemPrompt: `You are a CI failure investigator.
Diagnose why a CI check failed. Use shell commands (gh, curl) to fetch logs and read relevant files.
Return a clear root-cause summary with the failing step, error message, and suggested fix.`,
		readonly: true,
		isolated: false,
	},

	bestOfN: {
		type: 'bestOfN',
		tools: [
			'read_file', 'write_file', 'delete_file', 'edit_file', 'multi_edit', 'semantic_edit',
			'list_dir', 'tree', 'glob', 'search_files', 'file_info', 'batch_read',
			'grep', 'shell', 'git_status', 'git_log', 'git_diff_file', 'git_commit',
			'context_search', 'understand_symbol', 'lsp_diagnostics',
			'run_and_fix', 'diff_preview', 'checkpoint', 'rollback',
			'web_search', 'web_fetch',
		],
		systemPrompt: `You are an isolated experiment agent running in your own git worktree.
You have full tool access and your own branch. Changes you make don't affect the main working tree.
Implement the requested approach. Commit your work when done.`,
		readonly: false,
		isolated: true,
	},
};

export interface SubagentRequest {
	id: string;
	type: SubagentType;
	description: string;
	prompt: string;
	model: string;
	runInBackground: boolean;
	parentId: string | null;
}

export interface SubagentResult {
	id: string;
	type: SubagentType;
	description: string;
	status: 'running' | 'completed' | 'failed';
	output: string;
	toolsUsed: string[];
	startedAt: number;
	completedAt: number | null;
	model: string;
	/** Full prompt history for resume capability */
	conversationHistory: Array<{ role: string; content: string }>;
	/** Parent agent ID (null = spawned by main agent) */
	parentId: string | null;
}

/**
 * Registry of all subagents — tracks running/completed for resume capability.
 */
export class SubagentRegistry {
	private _agents: Map<string, SubagentResult> = new Map();

	register(agent: SubagentResult): void {
		this._agents.set(agent.id, agent);
	}

	get(id: string): SubagentResult | undefined {
		return this._agents.get(id);
	}

	update(id: string, update: Partial<SubagentResult>): void {
		const existing = this._agents.get(id);
		if (existing) {
			Object.assign(existing, update);
		}
	}

	getAll(): SubagentResult[] {
		return [...this._agents.values()];
	}

	getRunning(): SubagentResult[] {
		return [...this._agents.values()].filter(a => a.status === 'running');
	}

	getCompleted(): SubagentResult[] {
		return [...this._agents.values()].filter(a => a.status === 'completed');
	}

	/** Get children of a specific agent (for sub-subagent tree) */
	getChildren(parentId: string): SubagentResult[] {
		return [...this._agents.values()].filter(a => a.parentId === parentId);
	}

	/** Check if an agent can be resumed (must be completed, not running) */
	canResume(id: string): boolean {
		const agent = this._agents.get(id);
		return agent?.status === 'completed' && agent.conversationHistory.length > 0;
	}

	/** Get the conversation history for resuming an agent */
	getHistoryForResume(id: string): Array<{ role: string; content: string }> | null {
		const agent = this._agents.get(id);
		if (!agent || agent.status !== 'completed') { return null; }
		return agent.conversationHistory;
	}
}

/**
 * Get the tool restriction set for a subagent type.
 * Used by the subagent executor to filter which tool_requests to allow.
 */
export function getAllowedTools(type: SubagentType): Set<string> {
	return new Set(SUBAGENT_CONFIGS[type].tools);
}

/**
 * Build the full system prompt for a subagent including type-specific instructions.
 */
export function buildSubagentPrompt(type: SubagentType, task: string): string {
	const config = SUBAGENT_CONFIGS[type];
	return `${config.systemPrompt}
${config.readonly ? '\nIMPORTANT: You are READ-ONLY. Do not attempt to write files or make changes.' : ''}
Available tools: ${config.tools.join(', ')}
Do NOT use spawn_agents. Use the tools listed above directly.

Task: ${task}`;
}
