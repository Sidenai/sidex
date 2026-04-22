/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export * from 'semver';

export declare const SEMVER_SPEC_VERSION: '2.0.0';

export type ReleaseType = 'major' | 'premajor' | 'minor' | 'preminor' | 'patch' | 'prepatch' | 'prerelease';

export interface Options {
	loose?: boolean;
	includePrerelease?: boolean;
}

export interface CoerceOptions extends Options {
	rtl?: boolean;
}

export function parse(version: string | SemVer | null | undefined, optionsOrLoose?: boolean | Options): SemVer | null;
export function valid(version: string | SemVer | null | undefined, optionsOrLoose?: boolean | Options): string | null;
export function coerce(version: string | number | SemVer | null | undefined, options?: CoerceOptions): SemVer | null;
export function clean(version: string, optionsOrLoose?: boolean | Options): string | null;
export function inc(
	version: string | SemVer,
	release: ReleaseType,
	optionsOrLoose?: boolean | Options,
	identifier?: string
): string | null;
export function inc(version: string | SemVer, release: ReleaseType, identifier?: string): string | null;
export function major(version: string | SemVer, optionsOrLoose?: boolean | Options): number;
export function minor(version: string | SemVer, optionsOrLoose?: boolean | Options): number;
export function patch(version: string | SemVer, optionsOrLoose?: boolean | Options): number;
export function prerelease(version: string | SemVer, optionsOrLoose?: boolean | Options): ReadonlyArray<string> | null;

export function gt(v1: string | SemVer, v2: string | SemVer, optionsOrLoose?: boolean | Options): boolean;
export function gte(v1: string | SemVer, v2: string | SemVer, optionsOrLoose?: boolean | Options): boolean;
export function lt(v1: string | SemVer, v2: string | SemVer, optionsOrLoose?: boolean | Options): boolean;
export function lte(v1: string | SemVer, v2: string | SemVer, optionsOrLoose?: boolean | Options): boolean;
export function eq(v1: string | SemVer, v2: string | SemVer, optionsOrLoose?: boolean | Options): boolean;
export function neq(v1: string | SemVer, v2: string | SemVer, optionsOrLoose?: boolean | Options): boolean;
export function cmp(
	v1: string | SemVer,
	operator: Operator,
	v2: string | SemVer,
	optionsOrLoose?: boolean | Options
): boolean;
export type Operator = '===' | '!==' | '' | '=' | '==' | '!=' | '>' | '>=' | '<' | '<=';
export function compare(v1: string | SemVer, v2: string | SemVer, optionsOrLoose?: boolean | Options): 1 | 0 | -1;
export function rcompare(v1: string | SemVer, v2: string | SemVer, optionsOrLoose?: boolean | Options): 1 | 0 | -1;
export function compareIdentifiers(a: string | null | undefined, b: string | null | undefined): 1 | 0 | -1;
export function rcompareIdentifiers(a: string | null | undefined, b: string | null | undefined): 1 | 0 | -1;
export function compareBuild(a: string | SemVer, b: string | SemVer): 1 | 0 | -1;
export function sort<T extends string | SemVer>(list: T[], optionsOrLoose?: boolean | Options): T[];
export function rsort<T extends string | SemVer>(list: T[], optionsOrLoose?: boolean | Options): T[];
export function diff(v1: string | SemVer, v2: string | SemVer, optionsOrLoose?: boolean | Options): ReleaseType | null;

export function validRange(range: string | Range | null | undefined, optionsOrLoose?: boolean | Options): string;
export function satisfies(version: string | SemVer, range: string | Range, optionsOrLoose?: boolean | Options): boolean;
export function maxSatisfying<T extends string | SemVer>(
	versions: ReadonlyArray<T>,
	range: string | Range,
	optionsOrLoose?: boolean | Options
): T | null;
export function minSatisfying<T extends string | SemVer>(
	versions: ReadonlyArray<T>,
	range: string | Range,
	optionsOrLoose?: boolean | Options
): T | null;
export function minVersion(range: string | Range, optionsOrLoose?: boolean | Options): SemVer | null;
export function gtr(version: string | SemVer, range: string | Range, optionsOrLoose?: boolean | Options): boolean;
export function ltr(version: string | SemVer, range: string | Range, optionsOrLoose?: boolean | Options): boolean;
export function outside(
	version: string | SemVer,
	range: string | Range,
	hilo: '>' | '<',
	optionsOrLoose?: boolean | Options
): boolean;
export function intersects(range1: string | Range, range2: string | Range, optionsOrLoose?: boolean | Options): boolean;

export class SemVer {
	constructor(version: string | SemVer, optionsOrLoose?: boolean | Options);

	raw: string;
	loose: boolean;
	options: Options;
	format(): string;
	inspect(): string;

	major: number;
	minor: number;
	patch: number;
	version: string;
	build: ReadonlyArray<string>;
	prerelease: ReadonlyArray<string | number>;

	compare(other: string | SemVer): 1 | 0 | -1;
	compareMain(other: string | SemVer): 1 | 0 | -1;
	comparePre(other: string | SemVer): 1 | 0 | -1;
	compareBuild(other: string | SemVer): 1 | 0 | -1;
	inc(release: ReleaseType, identifier?: string): SemVer;
}

export class Comparator {
	constructor(comp: string | Comparator, optionsOrLoose?: boolean | Options);

	semver: SemVer;
	operator: '' | '=' | '<' | '>' | '<=' | '>=';
	value: string;
	loose: boolean;
	options: Options;
	parse(comp: string): void;
	test(version: string | SemVer): boolean;
	intersects(comp: Comparator, optionsOrLoose?: boolean | Options): boolean;
}

export class Range {
	constructor(range: string | Range, optionsOrLoose?: boolean | Options);

	range: string;
	raw: string;
	loose: boolean;
	options: Options;
	includePrerelease: boolean;
	format(): string;
	inspect(): string;

	set: ReadonlyArray<ReadonlyArray<Comparator>>;
	parseRange(range: string): ReadonlyArray<Comparator>;
	test(version: string | SemVer): boolean;
	intersects(range: Range, optionsOrLoose?: boolean | Options): boolean;
}
