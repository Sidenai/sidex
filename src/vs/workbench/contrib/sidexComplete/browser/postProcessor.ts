/*---------------------------------------------------------------------------------------------
 *  Sidex Complete — Post-processor that cleans raw model completions before display.
 *--------------------------------------------------------------------------------------------*/

const SPECIAL_TOKENS = /(<\|endoftext\|>|<\[fim-[a-z]+\]>)/g;
const MAX_MULTILINE_LINES = 10;
const MAX_SINGLELINE_CHARS = 200;
const DUPLICATE_SCAN_LINES = 50;

const BRACKET_PAIRS: ReadonlyMap<string, string> = new Map([
	['(', ')'],
	['[', ']'],
	['{', '}'],
]);
const CLOSE_TO_OPEN: ReadonlyMap<string, string> = new Map([
	[')', '('],
	[']', '['],
	['}', '{'],
]);

export interface PostProcessContext {
	readonly language: string;
	readonly prefix: string;
	readonly suffix: string;
}

export class CompletionPostProcessor {

	process(completion: string, context: PostProcessContext): string | null {
		let result = this._stripSpecialTokens(completion);

		if (!result || !result.trim()) {
			return null;
		}

		result = this._trimIncompleteLines(result);
		if (!result) {
			return null;
		}

		result = this._enforceMaxLength(result);
		result = this._balanceBrackets(result);
		result = this._normalizeIndentation(result, context.prefix);
		result = this._applyLanguageRules(result, context);

		if (!result || !result.trim()) {
			return null;
		}

		if (this._isDuplicate(result, context.prefix, context.suffix)) {
			return null;
		}

		return result;
	}

	private _stripSpecialTokens(text: string): string {
		return text.replace(SPECIAL_TOKENS, '');
	}

	private _isDuplicate(completion: string, prefix: string, suffix: string): boolean {
		const trimmed = completion.trim();
		if (!trimmed) {
			return true;
		}

		const prefixLines = prefix.split('\n');
		const suffixLines = suffix.split('\n');
		const nearbyText = [
			...prefixLines.slice(-DUPLICATE_SCAN_LINES),
			...suffixLines.slice(0, DUPLICATE_SCAN_LINES),
		].join('\n');

		return nearbyText.includes(trimmed);
	}

	private _trimIncompleteLines(text: string): string {
		const lines = text.split('\n');
		if (lines.length <= 1) {
			return text;
		}

		const lastLine = lines[lines.length - 1];
		if (this._isIncomplete(lastLine)) {
			lines.pop();
		}

		while (lines.length > 0 && !lines[lines.length - 1].trim()) {
			lines.pop();
		}
		return lines.join('\n');
	}

	private _isIncomplete(line: string): boolean {
		const trimmed = line.trimEnd();
		if (!trimmed) {
			return false;
		}
		// Ends mid-string
		const singleQuotes = (trimmed.match(/'/g) || []).length;
		const doubleQuotes = (trimmed.match(/"/g) || []).length;
		if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0) {
			return true;
		}
		// Ends with an operator suggesting continuation
		if (/[+\-*/=,&|^~]$/.test(trimmed) && !/[+\-]{2}$/.test(trimmed)) {
			return true;
		}
		return false;
	}

	private _enforceMaxLength(text: string): string {
		const lines = text.split('\n');
		if (lines.length === 1) {
			return text.length > MAX_SINGLELINE_CHARS
				? text.slice(0, MAX_SINGLELINE_CHARS)
				: text;
		}
		if (lines.length > MAX_MULTILINE_LINES) {
			return lines.slice(0, MAX_MULTILINE_LINES).join('\n');
		}
		return text;
	}

	private _balanceBrackets(text: string): string {
		const stack: string[] = [];
		const inString = { active: false, char: '' };

		for (let i = 0; i < text.length; i++) {
			const ch = text[i];

			if (inString.active) {
				if (ch === inString.char && text[i - 1] !== '\\') {
					inString.active = false;
				}
				continue;
			}

			if (ch === '"' || ch === '\'' || ch === '`') {
				inString.active = true;
				inString.char = ch;
				continue;
			}

			if (BRACKET_PAIRS.has(ch)) {
				stack.push(ch);
			} else if (CLOSE_TO_OPEN.has(ch)) {
				const expected = CLOSE_TO_OPEN.get(ch)!;
				if (stack.length > 0 && stack[stack.length - 1] === expected) {
					stack.pop();
				} else {
					// Unmatched closing bracket — trim from here
					return text.slice(0, i);
				}
			}
		}

		// Close any unclosed brackets
		let result = text;
		for (let i = stack.length - 1; i >= 0; i--) {
			result += BRACKET_PAIRS.get(stack[i])!;
		}
		return result;
	}

	private _normalizeIndentation(text: string, prefix: string): string {
		const prefixLines = prefix.split('\n');
		const useTabs = this._detectIndentStyle(prefixLines);
		const lines = text.split('\n');

		if (lines.length <= 1) {
			return text;
		}

		return lines.map((line) => {
			if (!line.trim()) {
				return line;
			}
			const stripped = line.replace(/^[\t ]+/, '');
			const leadingWhitespace = line.slice(0, line.length - stripped.length);

			if (useTabs && leadingWhitespace.includes(' ')) {
				const spaceCount = (leadingWhitespace.match(/ /g) || []).length;
				const tabEquiv = Math.round(spaceCount / 4);
				const existingTabs = (leadingWhitespace.match(/\t/g) || []).length;
				return '\t'.repeat(existingTabs + tabEquiv) + stripped;
			}
			if (!useTabs && leadingWhitespace.includes('\t')) {
				const tabCount = (leadingWhitespace.match(/\t/g) || []).length;
				const spaceEquiv = tabCount * 4;
				const existingSpaces = (leadingWhitespace.match(/ /g) || []).length;
				return ' '.repeat(existingSpaces + spaceEquiv) + stripped;
			}
			return line;
		}).join('\n');
	}

	private _detectIndentStyle(lines: string[]): boolean {
		let tabs = 0;
		let spaces = 0;
		const sample = lines.slice(-20);
		for (const line of sample) {
			if (line.startsWith('\t')) {
				tabs++;
			} else if (line.startsWith('  ')) {
				spaces++;
			}
		}
		return tabs > spaces;
	}

	private _applyLanguageRules(text: string, context: PostProcessContext): string {
		switch (context.language) {
			case 'python':
				return this._validatePythonIndent(text);
			case 'javascript':
			case 'typescript':
			case 'javascriptreact':
			case 'typescriptreact':
				return this._matchSemicolonStyle(text, context.prefix);
			default:
				return text;
		}
	}

	private _validatePythonIndent(text: string): string {
		const lines = text.split('\n');
		const validLines: string[] = [];

		for (const line of lines) {
			if (!line.trim()) {
				validLines.push(line);
				continue;
			}
			const indent = line.match(/^( *)/)?.[1].length ?? 0;
			if (indent % 4 !== 0 && indent % 2 !== 0) {
				break;
			}
			validLines.push(line);
		}

		return validLines.join('\n');
	}

	private _matchSemicolonStyle(text: string, prefix: string): string {
		const prefixLines = prefix.split('\n').slice(-30);
		let semiCount = 0;
		let stmtCount = 0;

		for (const line of prefixLines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed === '{' || trimmed === '}') {
				continue;
			}
			stmtCount++;
			if (trimmed.endsWith(';')) {
				semiCount++;
			}
		}

		if (stmtCount < 3) {
			return text;
		}

		const usesSemicolons = semiCount / stmtCount > 0.5;
		const completionLines = text.split('\n');

		return completionLines.map((line) => {
			const trimmed = line.trimEnd();
			if (!trimmed || trimmed.endsWith('{') || trimmed.endsWith('}') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
				return line;
			}

			if (usesSemicolons && !trimmed.endsWith(';') && !trimmed.endsWith(',') && !trimmed.endsWith('(') && !trimmed.endsWith(':')) {
				const isStatement = /^(const |let |var |return |import |export |throw |await )/.test(trimmed.trim())
					|| /[)}\]]$/.test(trimmed);
				if (isStatement) {
					return line.trimEnd() + ';';
				}
			} else if (!usesSemicolons && trimmed.endsWith(';')) {
				return line.slice(0, -1);
			}
			return line;
		}).join('\n');
	}
}
