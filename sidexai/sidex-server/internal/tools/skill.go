package tools

import (
	"fmt"
	"strings"

	"github.com/sidex-ai/sidex-server/internal/skills"
)

func init_skill(r *Registry) {
	r.tools["skill"] = Tool{
		Name: "skill",
		Description: `Invoke a reusable skill by name. Skills are prompt-based commands stored as markdown files that provide structured instructions for common tasks.

Built-in skills: commit, review, simplify, explain. Project-specific skills are loaded from .sidex/skills/ in the workspace root. The skill body is returned as a prompt — follow its instructions step-by-step to complete the task. Use this instead of improvising workflows for tasks that have a defined skill.`,
		Parameters: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"name": map[string]interface{}{
					"type":        "string",
					"description": "Name of the skill to invoke (e.g. 'commit', 'review')",
				},
			},
			"required": []string{"name"},
		},
	}
}

func (r *Registry) invokeSkill(args map[string]interface{}) ExecutionResult {
	name := strings.TrimSpace(str(args, "name"))
	if name == "" {
		return ExecutionResult{Error: "skill name is required"}
	}

	// Strip leading slash if the user typed "/commit" style
	name = strings.TrimPrefix(name, "/")

	allSkills := skills.BundledSkills()
	projectSkills := skills.LoadSkills(r.cwd)
	allSkills = append(allSkills, projectSkills...)

	skill := skills.FindSkill(allSkills, name)
	if skill == nil {
		var names []string
		for _, s := range allSkills {
			names = append(names, s.Name)
		}
		return ExecutionResult{
			Error: fmt.Sprintf("unknown skill %q — available: %s", name, strings.Join(names, ", ")),
		}
	}

	return ExecutionResult{
		Output: fmt.Sprintf("[skill: %s]\n\n%s", skill.Name, skill.Body),
	}
}
