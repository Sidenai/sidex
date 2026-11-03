/*---------------------------------------------------------------------------------------------
 *  Sidex Orchestration UI — Enhanced task tree with detail panel and streaming logs
 *--------------------------------------------------------------------------------------------*/

import './orchestration.css';
import { Component, DOM, $ } from '../components/base.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import type {
	OrchestrationPlan,
	TaskNode,
	TaskStatus,
	OrchestratorEvent,
	TaskHandoff,
} from './types.js';

const STATUS_ICONS: Record<TaskStatus, string> = {
	pending: '○',
	queued: '◔',
	running: '◑',
	completed: '●',
	failed: '✕',
	cancelled: '⊘',
	blocked: '◫',
};

const STATUS_CLASSES: Record<TaskStatus, string> = {
	pending: 'orch-status-pending',
	queued: 'orch-status-queued',
	running: 'orch-status-running',
	completed: 'orch-status-completed',
	failed: 'orch-status-failed',
	cancelled: 'orch-status-cancelled',
	blocked: 'orch-status-blocked',
};

export class OrchestrationView extends Component {
	private readonly _onCancel = this._register(new Emitter<void>());
	readonly onCancel: Event<void> = this._onCancel.event;

	private _headerEl!: HTMLElement;
	private _progressEl!: HTMLElement;
	private _treeEl!: HTMLElement;
	private _detailEl!: HTMLElement;
	private _statusEl!: HTMLElement;
	private _plan: OrchestrationPlan | null = null;
	private _taskElements: Map<string, HTMLElement> = new Map();
	private _taskLogs: Map<string, string[]> = new Map();
	private _selectedTaskId: string | null = null;

	constructor() {
		super('div', 'orch-view');
		this._build();
	}

	private _build(): void {
		this._headerEl = this.append('div', 'orch-header');

		const titleRow = DOM.append(this._headerEl, $('div.orch-title-row'));
		const titleLeft = DOM.append(titleRow, $('div.orch-title-left'));
		DOM.append(titleLeft, $('span.orch-icon')).textContent = '⬡';
		DOM.append(titleLeft, $('span.orch-title')).textContent = 'Orchestration';

		const actions = DOM.append(titleRow, $('div.orch-actions'));
		const cancelBtn = DOM.append(actions, $('button.orch-cancel-btn'));
		cancelBtn.textContent = 'Stop';
		this.on(cancelBtn, 'click', () => this._onCancel.fire());

		this._progressEl = this.append('div', 'orch-progress');
		this._statusEl = DOM.append(this._progressEl, $('div.orch-status-text'));
		const barWrap = DOM.append(this._progressEl, $('div.orch-progress-bar-wrap'));
		DOM.append(barWrap, $('div.orch-progress-bar'));

		const body = this.append('div', 'orch-body');
		this._treeEl = DOM.append(body, $('div.orch-tree'));
		this._detailEl = DOM.append(body, $('div.orch-detail'));
		this._detailEl.style.display = 'none';
	}

	setPlan(plan: OrchestrationPlan): void {
		this._plan = plan;
		this._statusEl.textContent = plan.summary || truncate(plan.goal, 80);
		this._renderTree();
	}

	handleEvent(event: OrchestratorEvent): void {
		switch (event.type) {
			case 'plan':
				this.setPlan(event.plan);
				break;
			case 'task_status':
				this._updateTask(event.taskId, event.status);
				this._appendLog(event.taskId, `[${event.status}] ${event.message || ''}`);
				break;
			case 'task_text':
				this._appendLog(event.taskId, event.text);
				break;
			case 'task_tool_call':
				this._appendLog(event.taskId, `⚡ ${event.toolName} (${event.status})`);
				break;
			case 'progress':
				this._updateProgress(event.completedTasks, event.totalTasks, event.elapsedMs);
				break;
			case 'handoff':
				this._showHandoff(event.handoff);
				break;
			case 'verify':
				this._showVerdict(event.taskId, event.verdict as string, event.reason);
				break;
			case 'complete':
				this._showComplete(event.totalElapsedMs);
				break;
			case 'cancelled':
				this._showCancelled(event.reason);
				break;
			case 'error':
				if (event.taskId) {
					this._showTaskError(event.taskId, event.error);
					this._appendLog(event.taskId, `❌ ${event.error}`);
				}
				break;
		}
	}

	private _renderTree(): void {
		if (!this._plan) { return; }
		DOM.clearNode(this._treeEl);
		this._taskElements.clear();

		const roots = this._plan.tasks.filter(t => !t.parentId);
		for (const task of roots) {
			this._renderTaskNode(task, this._treeEl, 0);
		}
	}

	private _renderTaskNode(task: TaskNode, parent: HTMLElement, depth: number): void {
		const row = DOM.append(parent, $('div.orch-task-row'));
		row.style.paddingLeft = `${12 + depth * 16}px`;
		row.dataset.taskId = task.id;
		this._taskElements.set(task.id, row);

		const statusIcon = DOM.append(row, $('span.orch-task-icon'));
		statusIcon.textContent = STATUS_ICONS[task.status];
		statusIcon.classList.add(STATUS_CLASSES[task.status]);

		const typeTag = DOM.append(row, $('span.orch-task-type'));
		typeTag.textContent = task.type;
		typeTag.classList.add(`orch-type-${task.type}`);

		const nameEl = DOM.append(row, $('span.orch-task-name'));
		nameEl.textContent = task.name;

		const goalEl = DOM.append(row, $('span.orch-task-goal'));
		goalEl.textContent = truncate(task.scopedGoal, 50);

		this.on(row, 'click', () => this._selectTask(task.id));

		// Children
		const children = this._plan!.tasks.filter(t => t.parentId === task.id);
		if (children.length > 0) {
			const childContainer = DOM.append(parent, $('div.orch-task-children'));
			for (const child of children) {
				this._renderTaskNode(child, childContainer, depth + 1);
			}
		}
	}

	private _selectTask(taskId: string): void {
		// Deselect previous
		if (this._selectedTaskId) {
			const prev = this._taskElements.get(this._selectedTaskId);
			if (prev) { prev.classList.remove('orch-task-selected'); }
		}

		this._selectedTaskId = taskId;
		const row = this._taskElements.get(taskId);
		if (row) { row.classList.add('orch-task-selected'); }

		this._showDetail(taskId);
	}

	private _showDetail(taskId: string): void {
		this._detailEl.style.display = 'flex';
		DOM.clearNode(this._detailEl);

		const task = this._plan?.tasks.find(t => t.id === taskId);
		const headerEl = DOM.append(this._detailEl, $('div.orch-detail-header'));
		DOM.append(headerEl, $('span.orch-detail-name')).textContent = task?.name || taskId;

		const closeBtn = DOM.append(headerEl, $('button.orch-detail-close'));
		closeBtn.textContent = '×';
		this.on(closeBtn, 'click', () => {
			this._detailEl.style.display = 'none';
			this._selectedTaskId = null;
		});

		if (task) {
			const metaEl = DOM.append(this._detailEl, $('div.orch-detail-meta'));
			DOM.append(metaEl, $('div.orch-detail-goal')).textContent = task.scopedGoal;
			if (task.acceptance.length > 0) {
				const accEl = DOM.append(metaEl, $('div.orch-detail-acceptance'));
				DOM.append(accEl, $('strong')).textContent = 'Acceptance:';
				for (const a of task.acceptance) {
					DOM.append(accEl, $('div.orch-detail-criterion')).textContent = `• ${a}`;
				}
			}
		}

		const logEl = DOM.append(this._detailEl, $('div.orch-detail-log'));
		const logs = this._taskLogs.get(taskId) || [];
		for (const line of logs.slice(-100)) {
			DOM.append(logEl, $('div.orch-log-line')).textContent = line;
		}
		logEl.scrollTop = logEl.scrollHeight;
	}

	private _appendLog(taskId: string, text: string): void {
		if (!this._taskLogs.has(taskId)) {
			this._taskLogs.set(taskId, []);
		}
		const logs = this._taskLogs.get(taskId)!;
		logs.push(text);
		if (logs.length > 500) { logs.splice(0, logs.length - 500); }

		// If this task is selected, append to detail view
		if (this._selectedTaskId === taskId) {
			const logEl = this._detailEl.querySelector('.orch-detail-log');
			if (logEl) {
				const line = document.createElement('div');
				line.className = 'orch-log-line';
				line.textContent = text;
				logEl.appendChild(line);
				logEl.scrollTop = logEl.scrollHeight;
			}
		}
	}

	private _updateTask(taskId: string, status: TaskStatus): void {
		const row = this._taskElements.get(taskId);
		if (!row) { return; }

		const icon = row.querySelector('.orch-task-icon') as HTMLElement;
		if (icon) {
			for (const cls of Object.values(STATUS_CLASSES)) {
				icon.classList.remove(cls);
			}
			icon.textContent = STATUS_ICONS[status];
			icon.classList.add(STATUS_CLASSES[status]);
		}

		row.classList.toggle('orch-task-active', status === 'running');
	}

	private _updateProgress(completed: number, total: number, elapsedMs: number): void {
		const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
		const bar = this._progressEl.querySelector('.orch-progress-bar') as HTMLElement;
		if (bar) { bar.style.width = `${pct}%`; }
		this._statusEl.textContent = `${completed}/${total} tasks • ${formatElapsed(elapsedMs)}`;
	}

	private _showHandoff(handoff: TaskHandoff): void {
		const row = this._taskElements.get(handoff.taskId);
		if (!row) { return; }
		const badge = document.createElement('span');
		badge.className = `orch-handoff-badge orch-handoff-${handoff.status}`;
		badge.textContent = handoff.status === 'success' ? '✓' : '✕';
		badge.title = handoff.summary;
		row.appendChild(badge);
	}

	private _showVerdict(taskId: string, verdict: string, reason: string): void {
		const row = this._taskElements.get(taskId);
		if (!row) { return; }
		const badge = document.createElement('span');
		badge.className = `orch-verdict-badge orch-verdict-${verdict}`;
		badge.textContent = verdict === 'pass' ? '✓' : verdict === 'partial' ? '~' : '✕';
		badge.title = reason;
		row.appendChild(badge);
	}

	private _showComplete(elapsedMs: number): void {
		this._headerEl.classList.add('orch-complete');
		this._statusEl.textContent = `Complete • ${formatElapsed(elapsedMs)}`;
		const bar = this._progressEl.querySelector('.orch-progress-bar') as HTMLElement;
		if (bar) { bar.style.width = '100%'; }
	}

	private _showCancelled(reason: string): void {
		this._headerEl.classList.add('orch-cancelled');
		this._statusEl.textContent = `Stopped: ${reason}`;
	}

	private _showTaskError(taskId: string, _error: string): void {
		const row = this._taskElements.get(taskId);
		if (row) { row.classList.add('orch-task-error'); }
	}
}

function truncate(s: string, max: number): string {
	return s.length > max ? s.slice(0, max) + '…' : s;
}

function formatElapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) { return `${s}s`; }
	const m = Math.floor(s / 60);
	return `${m}m ${s % 60}s`;
}
