package apply

import (
	"strings"
)

// DetectEditIntent examines the reasoning model's tool call and determines
// if it can be routed through fast-apply instead of exact matching.
func DetectEditIntent(toolName string, args map[string]any) *EditIntent {
	switch toolName {
	case "edit_file":
		return detectFromEditFile(args)
	case "multi_edit":
		return detectFromMultiEdit(args)
	case "write_file":
		return detectFromWriteFile(args)
	default:
		return nil
	}
}

func detectFromEditFile(args map[string]any) *EditIntent {
	oldStr, _ := args["old_string"].(string)
	newStr, _ := args["new_string"].(string)
	path, _ := args["path"].(string)

	if oldStr == "" || path == "" {
		return nil
	}

	// Only use fast-apply for edits where the old_str is substantial enough
	// that exact matching might fail due to whitespace drift.
	lines := strings.Count(oldStr, "\n") + 1
	if lines < 5 {
		return nil
	}

	return &EditIntent{
		FilePath: path,
		OldCode:  oldStr,
		NewCode:  newStr,
	}
}

func detectFromMultiEdit(args map[string]any) *EditIntent {
	path, _ := args["path"].(string)
	edits, ok := args["edits"].([]any)
	if !ok || path == "" || len(edits) == 0 {
		return nil
	}

	// For multi-edit, only route through fast-apply if there's a single
	// large edit (batches of small edits are better handled directly).
	if len(edits) > 1 {
		return nil
	}

	edit, ok := edits[0].(map[string]any)
	if !ok {
		return nil
	}

	oldStr, _ := edit["old"].(string)
	newStr, _ := edit["new"].(string)

	lines := strings.Count(oldStr, "\n") + 1
	if lines < 5 {
		return nil
	}

	return &EditIntent{
		FilePath: path,
		OldCode:  oldStr,
		NewCode:  newStr,
	}
}

func detectFromWriteFile(args map[string]any) *EditIntent {
	path, _ := args["path"].(string)
	content, _ := args["content"].(string)

	if path == "" || content == "" {
		return nil
	}

	// write_file is only interesting for fast-apply when it's rewriting an
	// existing file (vs creating new). The caller must check file existence.
	return &EditIntent{
		FilePath:    path,
		Description: "Full file rewrite via write_file",
		NewCode:     content,
	}
}

// ShouldUseFastApply determines if a given edit should use the fast model.
func ShouldUseFastApply(intent *EditIntent, config ApplyConfig) bool {
	if intent == nil || !config.Enabled {
		return false
	}

	if config.FastModel == "" {
		return false
	}

	// Skip very large new code blocks (likely full file writes that don't need merging).
	if intent.OldCode == "" && len(intent.NewCode) > config.MaxFileSize {
		return false
	}

	// Only use fast-apply when there's actual merge work to do.
	if intent.OldCode == "" && intent.Description == "" {
		return false
	}

	return true
}

// IntentFromFailedEdit creates an EditIntent from an edit_file call that
// failed exact matching — suitable for FuzzyApply retry.
func IntentFromFailedEdit(path, oldStr, newStr string) EditIntent {
	return EditIntent{
		FilePath:    path,
		Description: "Apply edit (exact match failed, using fuzzy apply)",
		OldCode:     oldStr,
		NewCode:     newStr,
	}
}
