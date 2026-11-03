/*---------------------------------------------------------------------------------------------
 *  Sidex Complete — Confidence scorer using token log-probabilities.
 *--------------------------------------------------------------------------------------------*/

const DEFAULT_THRESHOLD = 0.3;
const LEADING_TOKENS = 5;

export class ConfidenceScorer {

	private readonly _threshold: number;

	constructor(threshold: number = DEFAULT_THRESHOLD) {
		this._threshold = threshold;
	}

	getConfidence(logProbs: number[]): number {
		if (!logProbs || logProbs.length === 0) {
			return 0;
		}
		const window = logProbs.slice(0, LEADING_TOKENS);
		const avg = window.reduce((sum, lp) => sum + lp, 0) / window.length;
		return Math.exp(avg);
	}

	shouldShow(logProbs: number[], threshold?: number): boolean {
		return this.getConfidence(logProbs) >= (threshold ?? this._threshold);
	}
}
