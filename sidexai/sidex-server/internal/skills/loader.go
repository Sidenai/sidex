package skills

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/sidex-ai/sidex-server/internal/paths"
)

// Skill represents a loaded skill definition.
type Skill struct {
	Name          string   `json:"name"`
	Description   string   `json:"description"`
	Body          string   `json:"body"`
	AllowedTools  []string `json:"allowed_tools,omitempty"`
	UserInvocable bool     `json:"user_invocable"`
	Path          string   `json:"path"`
	Source        string   `json:"source"` // "bundled", "global", "project"
}

// LoadAllSkills returns skills from all sources, in priority order:
//  1. Bundled (always available, lowest priority)
//  2. User-global (~/.sidex/skills/)
//  3. Project-local (<project>/.sidex/skills/) — highest priority, can override
func LoadAllSkills(projectDir string) []Skill {
	seen := make(map[string]struct{})
	var out []Skill

	// Project skills (highest priority — loaded first, wins on name conflicts)
	for _, s := range loadFromDir(paths.InRepoSkillsDir(projectDir), "project") {
		seen[s.Name] = struct{}{}
		out = append(out, s)
	}

	// User-global skills
	for _, s := range loadFromDir(paths.GlobalSkillsDir(), "global") {
		if _, exists := seen[s.Name]; exists {
			continue
		}
		seen[s.Name] = struct{}{}
		out = append(out, s)
	}

	// Bundled skills (lowest priority)
	for _, s := range BundledSkills() {
		if _, exists := seen[s.Name]; exists {
			continue
		}
		s.Source = "bundled"
		out = append(out, s)
	}

	return out
}

// LoadSkills reads skill files from <projectDir>/.sidex/skills/ only (legacy API).
func LoadSkills(projectDir string) []Skill {
	return loadFromDir(paths.InRepoSkillsDir(projectDir), "project")
}

// FindSkill returns the skill with the given name, or nil.
func FindSkill(skills []Skill, name string) *Skill {
	for i := range skills {
		if skills[i].Name == name {
			return &skills[i]
		}
	}
	return nil
}

func loadFromDir(skillsDir, source string) []Skill {
	info, err := os.Stat(skillsDir)
	if err != nil || !info.IsDir() {
		return nil
	}

	entries, err := os.ReadDir(skillsDir)
	if err != nil {
		return nil
	}

	var out []Skill
	for _, e := range entries {
		full := filepath.Join(skillsDir, e.Name())
		if e.IsDir() {
			skillFile := filepath.Join(full, "SKILL.md")
			if s := parseSkillFile(skillFile); s != nil {
				s.Source = source
				out = append(out, *s)
			}
		} else if strings.HasSuffix(e.Name(), ".md") {
			if s := parseSkillFile(full); s != nil {
				s.Source = source
				out = append(out, *s)
			}
		}
	}
	return out
}

func parseSkillFile(path string) *Skill {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	fm, body := splitFrontmatter(string(data))

	name := fm["name"]
	if name == "" {
		base := filepath.Base(path)
		name = strings.TrimSuffix(base, filepath.Ext(base))
	}

	var allowedTools []string
	if raw, ok := fm["allowed-tools"]; ok && raw != "" {
		for _, t := range strings.Split(raw, ",") {
			t = strings.TrimSpace(t)
			if t != "" {
				allowedTools = append(allowedTools, t)
			}
		}
	}

	return &Skill{
		Name:          name,
		Description:   fm["description"],
		Body:          body,
		AllowedTools:  allowedTools,
		UserInvocable: fm["user-invocable"] == "true",
		Path:          path,
	}
}

func splitFrontmatter(content string) (map[string]string, string) {
	content = strings.TrimLeft(content, " \t\r\n")
	fm := make(map[string]string)

	if !strings.HasPrefix(content, "---") {
		return fm, content
	}

	rest := content[3:]
	idx := strings.Index(rest, "\n---")
	if idx < 0 {
		return fm, content
	}

	fmText := rest[:idx]
	body := strings.TrimLeft(rest[idx+4:], " \t\r\n")

	for _, line := range strings.Split(fmText, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		fm[strings.TrimSpace(key)] = strings.TrimSpace(value)
	}
	return fm, body
}
