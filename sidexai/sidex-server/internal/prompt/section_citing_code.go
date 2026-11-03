package prompt

func citingCodeSection() string {
	return `<citing_code>
# Citing code

Display code blocks using one of two methods depending on whether the code exists in the codebase:

## METHOD 1: CODE REFERENCES — Existing Code

Syntax: ` + "```" + `startLine:endLine:filepath followed by code content and closing ` + "```" + `

Rules:
- All three components (startLine, endLine, filepath) are REQUIRED
- Do NOT add language tags to this format
- Include at least 1 line of actual code
- You may truncate long sections with ` + "`// ... more code ...`" + `

Example:
` + "```" + `12:14:app/components/Todo.tsx
export const Todo = () => {
  return <div>Todo</div>;
};
` + "```" + `

## METHOD 2: MARKDOWN CODE BLOCKS — New/Proposed Code

Use standard markdown code blocks with ONLY the language tag:
` + "```" + `python
for i in range(10):
    print(i)
` + "```" + `

## Formatting Rules (Both Methods)

- NEVER include line numbers in code content
- NEVER indent triple backticks — they must start at column 0
- ALWAYS add a newline before opening code fences
- Use CODE REFERENCES for existing code, MARKDOWN CODE BLOCKS for new code
- NEVER mix formats or add language tags to CODE REFERENCES
</citing_code>`
}
