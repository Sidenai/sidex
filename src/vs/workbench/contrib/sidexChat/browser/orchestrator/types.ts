/*---------------------------------------------------------------------------------------------
 *  Sidex Orchestrator — Protocol types for multi-agent task coordination
 *
 *  Inspired by Cursor SDK streaming + orchestrate plugin patterns, but built
 *  natively into Sidex's WebSocket architecture with improvements:
 *  - Typed event discriminated unions (exhaustive switch safety)
 *  - Built-in backpressure via RAF-throttled consumers
 *  - Cancellation propagates down the task tree
 *  - Handoffs carry structured diffs, not just text
 *  - Verifier verdicts gate merges automatically
 *--------------------------------------------------------------------------------------------*/

// ─── Node Roles ────────────────────────────────────────────────────────────────

export type TaskNodeType = 'planner' | 'subplanner' | 'worker' | 'verifier';

export type TaskStatus =
	| 'pending'
	| 'queued'
	| 'running'
	| 'completed'
	| 'failed'
	| 'cancelled'
	| 'blocked';

export type VerifierVerdict = 'pass' | 'fail' | 'partial';

// ─── Task Definition ───────────────────────────────────────────────────────────

export interface TaskNode {
	id: string;
	name: string;
	type: TaskNodeType;
	status: TaskStatus;
	scopedGoal: string;
	parentId: string | null;

	/** Paths this task is allowed to modify (empty = unrestricted) */
	pathsAllowed: string[];
	/** Paths this task must NOT modify */
	pathsForbidden: string[];
	/** Task IDs that must complete before this can start */
	dependsOn: string[];
	/** For verifiers: which task ID this verifies */
	verifies: string | null;
	/** Acceptance criteria (used by verifiers and workers) */
	acceptance: string[];

	/** Runtime metadata */
	agentRunId: string | null;
	branch: string | null;
	startedAt: number | null;
	completedAt: number | null;
	attempts: number;
	maxAttempts: number;

	/** Measurements to validate after completion */
	measurements: TaskMeasurement[];
}

export interface TaskMeasurement {
	label: string;
	command: string;
	expected: string;
	actual?: string;
	passed?: boolean;
}

// ─── Plan ──────────────────────────────────────────────────────────────────────

export interface OrchestrationPlan {
	id: string;
	goal: string;
	summary: string;
	baseBranch: string;
	model: string;
	tasks: TaskNode[];
	createdAt: number;
	updatedAt: number;
	status: 'planning' | 'running' | 'converging' | 'completed' | 'failed' | 'cancelled';
}

// ─── Handoffs ──────────────────────────────────────────────────────────────────

export interface TaskHandoff {
	taskId: string;
	taskName: string;
	type: TaskNodeType;
	status: 'success' | 'failure' | 'partial';
	summary: string;
	branch: string | null;
	filesChanged: string[];
	verdict?: VerifierVerdict;
	verdictReason?: string;
	measurements?: TaskMeasurement[];
	/** Structured diff summary for the planner to reason about */
	diffStats?: { additions: number; deletions: number; filesChanged: number };
	timestamp: number;
}

// ─── Streaming Events ──────────────────────────────────────────────────────────
// Discriminated union — exhaustive matching in switch statements

export type OrchestratorEvent =
	| OrchestratorPlanEvent
	| OrchestratorTaskStatusEvent
	| OrchestratorTaskTextEvent
	| OrchestratorTaskThinkingEvent
	| OrchestratorTaskToolCallEvent
	| OrchestratorHandoffEvent
	| OrchestratorVerifyEvent
	| OrchestratorErrorEvent
	| OrchestratorProgressEvent
	| OrchestratorCancelledEvent
	| OrchestratorCompleteEvent;

export interface OrchestratorPlanEvent {
	type: 'plan';
	plan: OrchestrationPlan;
}

export interface OrchestratorTaskStatusEvent {
	type: 'task_status';
	taskId: string;
	taskName: string;
	status: TaskStatus;
	message?: string;
}

export interface OrchestratorTaskTextEvent {
	type: 'task_text';
	taskId: string;
	text: string;
}

export interface OrchestratorTaskThinkingEvent {
	type: 'task_thinking';
	taskId: string;
	text: string;
}

export interface OrchestratorTaskToolCallEvent {
	type: 'task_tool_call';
	taskId: string;
	callId: string;
	toolName: string;
	status: 'running' | 'completed' | 'error';
	args?: unknown;
	result?: unknown;
}

export interface OrchestratorHandoffEvent {
	type: 'handoff';
	handoff: TaskHandoff;
}

export interface OrchestratorVerifyEvent {
	type: 'verify';
	taskId: string;
	targetTaskId: string;
	verdict: VerifierVerdict;
	reason: string;
}

export interface OrchestratorErrorEvent {
	type: 'error';
	taskId?: string;
	error: string;
	recoverable: boolean;
}

export interface OrchestratorProgressEvent {
	type: 'progress';
	completedTasks: number;
	totalTasks: number;
	runningTasks: string[];
	elapsedMs: number;
}

export interface OrchestratorCancelledEvent {
	type: 'cancelled';
	taskId?: string;
	reason: string;
}

export interface OrchestratorCompleteEvent {
	type: 'complete';
	plan: OrchestrationPlan;
	handoffs: TaskHandoff[];
	totalElapsedMs: number;
}

// ─── Spawn Request (sent to server) ───────────────────────────────────────────

export interface SpawnTaskRequest {
	planId: string;
	task: TaskNode;
	parentBranch: string;
	model: string;
	systemPrompt: string;
	workspace: string;
}

// ─── Configuration ─────────────────────────────────────────────────────────────

export interface OrchestratorConfig {
	maxParallelWorkers: number;
	maxParallelVerifiers: number;
	autoVerify: boolean;
	model: string;
	plannerModel: string;
	workerModel: string;
	verifierModel: string;
	timeoutMs: number;
	retryOnFailure: boolean;
	maxRetries: number;
}

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
	maxParallelWorkers: 4,
	maxParallelVerifiers: 2,
	autoVerify: true,
	model: 'anthropic/claude-sonnet-4.6',
	plannerModel: 'anthropic/claude-sonnet-4.6',
	workerModel: 'anthropic/claude-sonnet-4.6',
	verifierModel: 'anthropic/claude-sonnet-4.6',
	timeoutMs: 600_000, // 10 minutes per task
	retryOnFailure: true,
	maxRetries: 2,
};
