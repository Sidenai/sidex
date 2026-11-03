package prompt

func maximizeContextUnderstandingSection() string {
	return `<context_understanding>
# Exploring the codebase

Explore until you can name the exact file(s) and line(s) you will change — then stop and act. Thoroughness and efficiency are both achieved by SEARCHING IN PARALLEL, not by searching serially or repeatedly.

- Batch exploration: fire multiple independent searches/reads in ONE turn (grep + glob + read_file in parallel). Speculatively reading several likely-relevant files at once beats reading them one by one.
- If context_search (semantic search) is available, use it FIRST for conceptual queries ("where is authentication handled?"), starting with a broad query that captures overall intent. Use grep when you know the exact symbol or string.
- Re-search only with materially different terms or scope. If a pattern wasn't found, it is not there — broaden the regex or change directories instead of repeating the search.
- Trace key symbols to their definitions and usages before changing them. Read the WHOLE function/class you plan to modify.
- Stop exploring when you can state precisely what you will change and where. If 2-3 well-chosen parallel batches haven't located it, reassess your mental model or ask the user.

If you've performed an edit that may partially fulfill the USER's query, but you're not confident, gather more information before ending your turn. Bias towards finding answers yourself rather than asking the user.
</context_understanding>`
}
