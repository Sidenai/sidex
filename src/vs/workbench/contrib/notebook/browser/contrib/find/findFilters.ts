/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';

export class NotebookFindFilters extends Disposable {
	private _markupInput: boolean;
	private _markupPreview: boolean;
	private _codeInput: boolean;
	private _codeOutput: boolean;
	private _findScope: any;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	get markupInput(): boolean {
		return this._markupInput;
	}
	set markupInput(value: boolean) {
		this._markupInput = value;
		this._onDidChange.fire();
	}

	get markupPreview(): boolean {
		return this._markupPreview;
	}
	set markupPreview(value: boolean) {
		this._markupPreview = value;
		this._onDidChange.fire();
	}

	get codeInput(): boolean {
		return this._codeInput;
	}
	set codeInput(value: boolean) {
		this._codeInput = value;
		this._onDidChange.fire();
	}

	get codeOutput(): boolean {
		return this._codeOutput;
	}
	set codeOutput(value: boolean) {
		this._codeOutput = value;
		this._onDidChange.fire();
	}

	get findScope(): any {
		return this._findScope;
	}
	set findScope(value: any) {
		this._findScope = value;
		this._onDidChange.fire();
	}

	constructor(markupInput: boolean, markupPreview: boolean, codeInput: boolean, codeOutput: boolean, findScope?: any) {
		super();
		this._markupInput = markupInput;
		this._markupPreview = markupPreview;
		this._codeInput = codeInput;
		this._codeOutput = codeOutput;
		this._findScope = findScope;
	}

	isModified(): boolean {
		return false;
	}

	update(markupInput: boolean, markupPreview: boolean, codeInput: boolean, codeOutput: boolean): void {
		this._markupInput = markupInput;
		this._markupPreview = markupPreview;
		this._codeInput = codeInput;
		this._codeOutput = codeOutput;
		this._onDidChange.fire();
	}
}
