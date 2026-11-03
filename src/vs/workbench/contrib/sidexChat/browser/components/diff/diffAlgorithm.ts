/*---------------------------------------------------------------------------------------------
 *  Line-based diff algorithm using Myers' O(ND) approach.
 *  Produces DiffLine[] and groups them into DiffHunk[] with configurable context.
 *--------------------------------------------------------------------------------------------*/

export interface DiffLine {
	type: 'context' | 'added' | 'removed';
	content: string;
	oldLineNo?: number;
	newLineNo?: number;
}

export interface DiffHunk {
	id: number;
	startLineOld: number;
	startLineNew: number;
	oldLines: string[];
	newLines: string[];
	contextBefore: DiffLine[];
	contextAfter: DiffLine[];
	lines: DiffLine[];
	status: 'pending' | 'accepted' | 'rejected';
}

/**
 * Myers diff — computes the shortest edit script between two string arrays.
 * Returns an array of operations: 0 = equal, -1 = removed, 1 = added.
 * Time complexity: O(ND) where N = total length, D = edit distance.
 */
function myersDiff(a: string[], b: string[]): Array<{ op: 0 | -1 | 1; value: string }> {
	const n = a.length;
	const m = b.length;
	const max = n + m;

	if (max === 0) {
		return [];
	}

	// Optimisation: handle identical prefix/suffix
	let prefixLen = 0;
	while (prefixLen < n && prefixLen < m && a[prefixLen] === b[prefixLen]) {
		prefixLen++;
	}
	let suffixLen = 0;
	while (
		suffixLen < n - prefixLen &&
		suffixLen < m - prefixLen &&
		a[n - 1 - suffixLen] === b[m - 1 - suffixLen]
	) {
		suffixLen++;
	}

	const aSlice = a.slice(prefixLen, n - suffixLen);
	const bSlice = b.slice(prefixLen, m - suffixLen);

	const result: Array<{ op: 0 | -1 | 1; value: string }> = [];

	for (let i = 0; i < prefixLen; i++) {
		result.push({ op: 0, value: a[i] });
	}

	const innerResult = myersDiffCore(aSlice, bSlice);
	result.push(...innerResult);

	for (let i = n - suffixLen; i < n; i++) {
		result.push({ op: 0, value: a[i] });
	}

	return result;
}

function myersDiffCore(a: string[], b: string[]): Array<{ op: 0 | -1 | 1; value: string }> {
	const n = a.length;
	const m = b.length;

	if (n === 0 && m === 0) { return []; }
	if (n === 0) { return b.map(v => ({ op: 1 as const, value: v })); }
	if (m === 0) { return a.map(v => ({ op: -1 as const, value: v })); }

	const max = n + m;
	const vSize = 2 * max + 1;
	const v = new Int32Array(vSize);
	const trace: Int32Array[] = [];

	const offset = max;

	for (let d = 0; d <= max; d++) {
		const snap = new Int32Array(v);
		trace.push(snap);

		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
				x = v[k + 1 + offset];
			} else {
				x = v[k - 1 + offset] + 1;
			}
			let y = x - k;

			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}

			v[k + offset] = x;

			if (x >= n && y >= m) {
				return buildResult(trace, a, b, offset, d);
			}
		}
	}

	// Fallback (shouldn't reach here)
	return [
		...a.map(v => ({ op: -1 as const, value: v })),
		...b.map(v => ({ op: 1 as const, value: v })),
	];
}

function buildResult(
	trace: Int32Array[],
	a: string[],
	b: string[],
	offset: number,
	d: number
): Array<{ op: 0 | -1 | 1; value: string }> {
	// Backtrack through the trace to recover the edit script directly.
	// Each step from d back to 0 represents one edit (insert or delete),
	// potentially followed by diagonal moves (equals).
	const ops: Array<{ op: 0 | -1 | 1; value: string }> = [];

	let x = a.length;
	let y = b.length;

	for (let dd = d; dd > 0; dd--) {
		const vPrev = trace[dd - 1];
		const k = x - y;

		let prevK: number;
		if (k === -dd || (k !== dd && vPrev[k - 1 + offset] < vPrev[k + 1 + offset])) {
			prevK = k + 1;
		} else {
			prevK = k - 1;
		}

		const prevX = vPrev[prevK + offset];
		const prevY = prevX - prevK;

		// Diagonal moves after the edit (equals) — collected in reverse
		while (x > prevX + (k - prevK === 1 ? 1 : 0) && y > prevY + (k - prevK === -1 ? 1 : 0)) {
			x--;
			y--;
			ops.push({ op: 0, value: a[x] });
		}

		// The edit step itself
		if (prevK - k === 1) {
			// k decreased by 1 → came from prevK = k+1 → this was an insert (y advanced)
			y--;
			ops.push({ op: 1, value: b[y] });
		} else {
			// k increased by 1 → came from prevK = k-1 → this was a delete (x advanced)
			x--;
			ops.push({ op: -1, value: a[x] });
		}
	}

	// Remaining diagonal at the start (d=0 prefix equals)
	while (x > 0 && y > 0) {
		x--;
		y--;
		ops.push({ op: 0, value: a[x] });
	}

	ops.reverse();
	return ops;
}

/**
 * Compute line-level diff between two text strings.
 * Each DiffLine carries its type and original line numbers.
 */
export function computeDiff(oldText: string, newText: string): DiffLine[] {
	const oldLines = oldText.length === 0 ? [] : oldText.split('\n');
	const newLines = newText.length === 0 ? [] : newText.split('\n');

	const ops = myersDiff(oldLines, newLines);
	const result: DiffLine[] = [];

	let oldNo = 1;
	let newNo = 1;

	for (const op of ops) {
		switch (op.op) {
			case 0:
				result.push({ type: 'context', content: op.value, oldLineNo: oldNo++, newLineNo: newNo++ });
				break;
			case -1:
				result.push({ type: 'removed', content: op.value, oldLineNo: oldNo++ });
				break;
			case 1:
				result.push({ type: 'added', content: op.value, newLineNo: newNo++ });
				break;
		}
	}

	return result;
}

/**
 * Group a flat DiffLine[] into hunks with surrounding context lines.
 * Adjacent changes within (2 * contextLines) of each other are merged.
 */
export function groupIntoHunks(lines: DiffLine[], contextLines: number = 3): DiffHunk[] {
	const changeIndices: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].type !== 'context') {
			changeIndices.push(i);
		}
	}

	if (changeIndices.length === 0) {
		return [];
	}

	// Group change indices into ranges (merging nearby ones)
	const groups: Array<{ start: number; end: number }> = [];
	let groupStart = changeIndices[0];
	let groupEnd = changeIndices[0];

	for (let i = 1; i < changeIndices.length; i++) {
		if (changeIndices[i] - groupEnd <= contextLines * 2) {
			groupEnd = changeIndices[i];
		} else {
			groups.push({ start: groupStart, end: groupEnd });
			groupStart = changeIndices[i];
			groupEnd = changeIndices[i];
		}
	}
	groups.push({ start: groupStart, end: groupEnd });

	const hunks: DiffHunk[] = [];

	for (let i = 0; i < groups.length; i++) {
		const g = groups[i];
		const ctxStart = Math.max(0, g.start - contextLines);
		const ctxEnd = Math.min(lines.length - 1, g.end + contextLines);

		const hunkLines = lines.slice(ctxStart, ctxEnd + 1);
		const contextBefore = lines.slice(ctxStart, g.start).filter(l => l.type === 'context');
		const contextAfter = lines.slice(g.end + 1, ctxEnd + 1).filter(l => l.type === 'context');

		const oldLns: string[] = [];
		const newLns: string[] = [];
		for (let j = g.start; j <= g.end; j++) {
			if (lines[j].type === 'removed') { oldLns.push(lines[j].content); }
			if (lines[j].type === 'added') { newLns.push(lines[j].content); }
		}

		const startOld = hunkLines[0]?.oldLineNo ?? 1;
		const startNew = hunkLines[0]?.newLineNo ?? 1;

		hunks.push({
			id: i,
			startLineOld: startOld,
			startLineNew: startNew,
			oldLines: oldLns,
			newLines: newLns,
			contextBefore,
			contextAfter,
			lines: hunkLines,
			status: 'pending',
		});
	}

	return hunks;
}
