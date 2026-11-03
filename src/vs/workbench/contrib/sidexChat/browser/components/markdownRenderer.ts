import { escapeHtml } from './base.js';

const SAFE_URL_PATTERN = /^(https?:\/\/|file:\/\/|\/|#|\.\/|\.\.\/)/i;

function sanitizeUrl(url: string): string {
	if (SAFE_URL_PATTERN.test(url)) {
		return url;
	}
	return '#';
}

/**
 * Escape a value for use inside a double-quoted HTML ATTRIBUTE built by this
 * renderer. On top of escapeHtml it neutralizes characters that the later
 * inline-markdown regex passes (backtick, *, _, ~) would otherwise match
 * ACROSS tag boundaries — a backtick inside data-file="..." paired with a
 * later backtick lets attacker-controlled text terminate the attribute and
 * inject arbitrary attributes (event handlers) without needing '<'.
 */
function escapeAttr(text: string): string {
	return escapeHtml(text)
		.replace(/'/g, '&#39;')
		.replace(/`/g, '&#96;')
		.replace(/\*/g, '&#42;')
		.replace(/_/g, '&#95;')
		.replace(/~/g, '&#126;');
}

export function renderMarkdown(text: string): string {
	// First escape everything
	let html = escapeHtml(text);

	// Code blocks FIRST (before other replacements touch the content)
	html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
		// Detect code citation pattern: first line is startLine:endLine:filepath
		const citationMatch = code.match(/^(\d+):(\d+):(.+)\n([\s\S]*)$/);
		if (citationMatch) {
			const startLine = citationMatch[1];
			const endLine = citationMatch[2];
			const filepath = citationMatch[3];
			const codeBody = citationMatch[4].trimEnd();
			return `<div class="sc-code-citation" data-file="${escapeAttr(filepath)}" data-start-line="${startLine}" data-end-line="${endLine}">` +
				`<div class="sc-citation-header" title="Open ${escapeAttr(filepath)}">` +
				`<span class="sc-citation-icon">📄</span> ` +
				`<span class="sc-citation-path">${escapeHtml(filepath)}</span>` +
				`<span class="sc-citation-lines">:${startLine}-${endLine}</span>` +
				`</div>` +
				`<pre class="sc-code-block sc-citation-code" style="margin:0; padding:10px; background:var(--vscode-textCodeBlock-background); font-family:var(--vscode-editor-font-family); font-size:12px; overflow-x:auto;"><code>${codeBody}</code></pre>` +
				`</div>`;
		}
		const label = lang ? `<span class="sc-code-lang">${escapeHtml(lang)}</span>` : '';
		return `<pre class="sc-code-block" style="background:var(--vscode-textCodeBlock-background);border-radius:6px;padding:10px;margin:8px 0;font-family:monospace;font-size:12px;overflow-x:auto;">${label}<code>${code.trimEnd()}</code></pre>`;
	});

	// Tables: detect lines starting with | and convert
	html = renderTables(html);

	// Headings (#### before ### before ## before #)
	html = html.replace(/^#### (.+)$/gm, '<h4 style="margin:12px 0 4px;font-weight:600;color:var(--vscode-foreground);font-size:13px;">$1</h4>');
	html = html.replace(/^### (.+)$/gm, '<h3 style="margin:12px 0 4px;font-weight:600;color:var(--vscode-foreground);font-size:14px;">$1</h3>');
	html = html.replace(/^## (.+)$/gm, '<h2 style="margin:12px 0 4px;font-weight:600;color:var(--vscode-foreground);font-size:16px;">$1</h2>');
	html = html.replace(/^# (.+)$/gm, '<h1 style="margin:12px 0 4px;font-weight:600;color:var(--vscode-foreground);font-size:18px;">$1</h1>');

	// Inline code
	html = html.replace(/`([^`]+)`/g, '<code class="sc-inline-code" style="background:var(--vscode-textCodeBlock-background);padding:1px 5px;border-radius:3px;font-family:monospace;font-size:12px;">$1</code>');

	// Bold + italic
	html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
	html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
	html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

	// Images — ![alt](src) rendered as inline <img>
	html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, src) => {
		let resolvedSrc = sanitizeUrl(src);
		if (resolvedSrc.startsWith('/')) {
			resolvedSrc = `file://${resolvedSrc}`;
		}
		const safeAlt = escapeAttr(alt);
		return `<img class="sc-inline-image" src="${escapeAttr(resolvedSrc)}" alt="${safeAlt}" title="${safeAlt}" />`;
	});

	// Links
	html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
		const safeHref = sanitizeUrl(href);
		return `<a class="sc-link" style="color:var(--vscode-textLink-foreground);text-decoration:underline;" href="${escapeAttr(safeHref)}">${label}</a>`;
	});

	// Unordered lists (- item)
	html = html.replace(/^- (.+)$/gm, '<li class="sc-li" style="margin:2px 0;">$1</li>');
	// Wrap consecutive <li> in <ul>
	html = html.replace(/((?:<li class="sc-li">.*<\/li>\n?)+)/g, '<ul class="sc-ul" style="padding-left:20px;margin:4px 0;">$1</ul>');

	// Ordered lists (1. item)
	html = html.replace(/^\d+\. (.+)$/gm, '<li class="sc-oli" style="margin:2px 0;">$1</li>');
	html = html.replace(/((?:<li class="sc-oli">.*<\/li>\n?)+)/g, '<ol class="sc-ol" style="padding-left:20px;margin:4px 0;">$1</ol>');

	// Line breaks (but not inside pre/table)
	html = html.replace(/\n/g, '<br>');
	// Clean up extra <br> after block elements
	html = html.replace(/(<\/pre>)<br>/g, '$1');
	html = html.replace(/(<\/table>)<br>/g, '$1');
	html = html.replace(/(<\/ul>)<br>/g, '$1');
	html = html.replace(/(<\/ol>)<br>/g, '$1');
	html = html.replace(/(<\/h[1-4]>)<br>/g, '$1');

	return html;
}

function renderTables(html: string): string {
	// Find blocks of lines that start with |
	const lines = html.split('\n');
	const result: string[] = [];
	let tableLines: string[] = [];

	for (const line of lines) {
		if (line.trimStart().startsWith('|')) {
			tableLines.push(line);
		} else {
			if (tableLines.length >= 2) {
				result.push(buildTable(tableLines));
			} else {
				result.push(...tableLines);
			}
			tableLines = [];
			result.push(line);
		}
	}
	if (tableLines.length >= 2) {
		result.push(buildTable(tableLines));
	} else {
		result.push(...tableLines);
	}

	return result.join('\n');
}

function buildTable(lines: string[]): string {
	const rows = lines
		.filter(l => !l.match(/^\|\s*-+/)) // skip separator rows
		.map(l => l.split('|').filter(c => c.trim() !== '').map(c => c.trim()));

	if (rows.length === 0) { return lines.join('\n'); }

	let html = '<table class="sc-table">';
	// First row is header
	html += '<thead><tr>';
	for (const cell of rows[0]) {
		html += `<th>${cell}</th>`;
	}
	html += '</tr></thead>';

	// Remaining rows are body
	if (rows.length > 1) {
		html += '<tbody>';
		for (let i = 1; i < rows.length; i++) {
			html += '<tr>';
			for (const cell of rows[i]) {
				html += `<td>${cell}</td>`;
			}
			html += '</tr>';
		}
		html += '</tbody>';
	}
	html += '</table>';
	return html;
}
