/*---------------------------------------------------------------------------------------------
 *  Sidex Complete — Tracks recent edits across all open models for context assembly.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelContentChangedEvent } from '../../../../editor/common/textModelEvents.js';

const MAX_EDITS = 20;
const EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CHANGE_TEXT_LENGTH = 500;

interface IRecentEdit {
	file: string;
	before: string;
	after: string;
	timestamp: number;
}

export const IRecentEditTracker = createDecorator<IRecentEditTracker>('sidexRecentEditTracker');

export interface IRecentEditTracker {
	readonly _serviceBrand: undefined;
	getRecentEdits(limit: number): string[];
}

export class RecentEditTracker extends Disposable implements IRecentEditTracker {
	declare readonly _serviceBrand: undefined;

	private readonly _edits: IRecentEdit[] = [];
	private readonly _modelListeners = new Map<string, DisposableStore>();

	constructor(
		@IModelService private readonly _modelService: IModelService,
	) {
		super();

		for (const model of this._modelService.getModels()) {
			this._watchModel(model);
		}

		this._register(this._modelService.onModelAdded((model) => this._watchModel(model)));
		this._register(this._modelService.onModelRemoved((model) => this._unwatchModel(model)));
	}

	getRecentEdits(limit: number): string[] {
		this._expireOldEdits();
		const count = Math.min(limit, this._edits.length);
		const result: string[] = [];
		for (let i = this._edits.length - count; i < this._edits.length; i++) {
			const edit = this._edits[i];
			result.push(`--- ${edit.file}\n-${edit.before}\n+${edit.after}`);
		}
		return result;
	}

	private _watchModel(model: ITextModel): void {
		const key = model.uri.toString();
		if (this._modelListeners.has(key)) {
			return;
		}

		const store = new DisposableStore();
		store.add(model.onDidChangeContent((e) => this._onModelContentChanged(model, e)));
		this._modelListeners.set(key, store);
	}

	private _unwatchModel(model: ITextModel): void {
		const key = model.uri.toString();
		const store = this._modelListeners.get(key);
		if (store) {
			store.dispose();
			this._modelListeners.delete(key);
		}
	}

	private _onModelContentChanged(model: ITextModel, event: IModelContentChangedEvent): void {
		if (event.isFlush || event.isEolChange) {
			return;
		}

		for (const change of event.changes) {
			const before = change.rangeLength > 0
				? `[${change.rangeLength} chars @ L${change.range.startLineNumber}:${change.range.startColumn}]`
				: '';
			const after = change.text.slice(0, MAX_CHANGE_TEXT_LENGTH);

			if (!before && !after) {
				continue;
			}

			this._edits.push({
				file: model.uri.fsPath,
				before,
				after,
				timestamp: Date.now(),
			});
		}

		while (this._edits.length > MAX_EDITS) {
			this._edits.shift();
		}
	}

	private _expireOldEdits(): void {
		const cutoff = Date.now() - EXPIRY_MS;
		while (this._edits.length > 0 && this._edits[0].timestamp < cutoff) {
			this._edits.shift();
		}
	}

	override dispose(): void {
		for (const store of this._modelListeners.values()) {
			store.dispose();
		}
		this._modelListeners.clear();
		super.dispose();
	}
}

registerSingleton(IRecentEditTracker, RecentEditTracker, InstantiationType.Delayed);
