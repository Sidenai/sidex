/*---------------------------------------------------------------------------------------------
 *  Subagent Card — Shows live subagent progress, click to open full chat view
 *--------------------------------------------------------------------------------------------*/

import { Component, DOM, $ } from '../base.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';

export interface SubagentInfo {
	id: string;
	description: string;
	model: string;
	status: 'running' | 'completed' | 'failed';
	prompt: string;
	toolCalls: Array<{ name: string; status: string; output?: string }>;
	output: string;
	startedAt: number;
	completedAt?: number;
}

export class SubagentCard extends Component {
	private readonly _onExpand = this._register(new Emitter<string>());
	readonly onExpand: Event<string> = this._onExpand.event;

	private _info: SubagentInfo;
	private _statusDot!: HTMLElement;
	private _statusText!: HTMLElement;
	private _toolsEl!: HTMLElement;
	private _outputEl!: HTMLElement;
	private _expanded = false;
	private _bodyEl!: HTMLElement;

	constructor(info: SubagentInfo) {
		super('div', 'sc-subagent-card');
		this._info = info;
		this._build();
	}

	get info(): SubagentInfo { return this._info; }

	private _build(): void {
		// Header row (always visible)
		const header = this.append('div', 'sc-subagent-header');
		this.on(header, 'click', () => this._toggle());

		this._statusDot = DOM.append(header, $('span.sc-subagent-dot'));
		this._statusDot.classList.add(`sc-subagent-${this._info.status}`);

		const title = DOM.append(header, $('span.sc-subagent-title'));
		title.textContent = this._info.description;

		const model = DOM.append(header, $('span.sc-subagent-meta'));
		model.textContent = this._formatModel(this._info.model);

		this._statusText = DOM.append(header, $('span.sc-subagent-status'));
		this._statusText.textContent = this._info.status === 'running' ? 'Running...' : 'Completed';

		// Body (shown on expand — like Cursor's subagent detail)
		this._bodyEl = this.append('div', 'sc-subagent-body');
		this._bodyEl.style.display = 'none';

		// Live tool calls section
		this._toolsEl = DOM.append(this._bodyEl, $('div.sc-subagent-live-tools'));

		// Output section
		this._outputEl = DOM.append(this._bodyEl, $('div.sc-subagent-live-output'));
		this._outputEl.textContent = this._info.output || '';
	}

	update(info: Partial<SubagentInfo>): void {
		if (info.status !== undefined) {
			this._info.status = info.status;
			this._statusDot.classList.remove('sc-subagent-running', 'sc-subagent-completed', 'sc-subagent-failed');
			this._statusDot.classList.add(`sc-subagent-${info.status}`);
			this._statusText.textContent = info.status === 'running' ? 'Running...' : info.status === 'completed' ? 'Completed' : 'Failed';
		}
		if (info.toolCalls) {
			this._info.toolCalls = info.toolCalls;
			this._renderTools();
		}
		if (info.output !== undefined) {
			this._info.output = info.output;
			this._outputEl.textContent = info.output;
		}
	}

	addToolCall(name: string, status: string): void {
		this._info.toolCalls.push({ name, status });
		this._renderTools();
	}

	appendOutput(text: string): void {
		this._info.output += text;
		this._outputEl.textContent = this._info.output;
		if (this._expanded) {
			this._outputEl.scrollTop = this._outputEl.scrollHeight;
		}
	}

	private _toggle(): void {
		this._expanded = !this._expanded;
		this._bodyEl.style.display = this._expanded ? 'block' : 'none';
		this.element.classList.toggle('sc-subagent-expanded', this._expanded);
		this._onExpand.fire(this._info.id);
	}

	private _renderTools(): void {
		DOM.clearNode(this._toolsEl);
		for (const tc of this._info.toolCalls) {
			const row = DOM.append(this._toolsEl, $('div.sc-subagent-tool-item'));
			const icon = DOM.append(row, $('span.sc-subagent-tool-icon'));
			icon.textContent = tc.status === 'done' ? '✓' : tc.status === 'running' ? '◑' : '✕';
			icon.classList.add(tc.status === 'done' ? 'sc-tool-done' : tc.status === 'running' ? 'sc-tool-running' : 'sc-tool-error');
			const name = DOM.append(row, $('span.sc-subagent-tool-name'));
			name.textContent = tc.name;
		}
	}

	private _formatModel(model: string): string {
		if (model.includes('opus')) {return 'Claude Opus';}
		if (model.includes('sonnet')) {return 'Claude Sonnet';}
		if (model.includes('haiku')) {return 'Claude Haiku';}
		return model.split('.').pop()?.replace(/-/g, ' ') || model;
	}
}
