# OpenCode AI Agent Integration

This project uses OpenCode AI Agent for automated code review and issue triage.

## 🔧 Setup Instructions

### 1. Install OpenCode GitHub App

1. Go to: https://github.com/apps/opencode-agent
2. Click "Install"
3. Select "All repositories" or choose specific repositories
4. Complete the installation

### 2. Add ANTHROPIC_API_KEY Secret

The OpenCode agent requires an Anthropic API key to function:

1. Go to your repository settings: `Settings > Secrets and variables > Actions`
2. Click "New repository secret"
3. Name: `ANTHROPIC_API_KEY`
4. Value: Your Anthropic API key (get one at https://console.anthropic.com/)

### 3. Verify Setup

The workflow will automatically run on:
- **PRs**: When opened, updated, or marked ready for review
- **Issues**: When opened or edited

## 📋 Workflows

### OpenCode Review (`.github/workflows/opencode-review.yml`)

Automatically reviews pull requests with:
- CI status analysis
- Code quality checks
- Security vulnerability detection
- Performance impact assessment
- Breaking change detection

**Trigger**: `pull_request` events (opened, synchronize, reopened, ready_for_review)

### OpenCode Triage (`.github/workflows/opencode-triage.yml`)

Automatically triages new issues with:
- Issue type classification
- Priority assessment
- Component affected analysis
- Complexity estimation
- Label suggestions

**Trigger**: `issues` events (opened, edited)

## 💬 Using OpenCode Manually

### On a PR
Comment on the PR:
```
/opencode review this PR
```

### On an Issue
Comment on the issue:
```
/opencode explain this issue
```

### To Fix an Issue
Comment on the issue:
```
/opencode fix this
```

OpenCode will create a branch, implement the fix, and open a PR.

## 🔐 Security Notes

- The `ANTHROPIC_API_KEY` secret is encrypted and only accessible to GitHub Actions
- OpenCode uses the installation access token by default for GitHub operations
- All runs are logged in the Actions tab

## 📝 Configuration

You can customize the OpenCode behavior by modifying the `prompt` in each workflow file. The current prompts are optimized for:
- SideX project specifics
- Tauri + Rust backend
- VS Code fork frontend (TypeScript)
- CI/CD pipeline awareness

## 🤝 Contributing

When contributing to this project, OpenCode will automatically review your PRs. Please address any issues raised by the AI reviewer before requesting human review.

## 📚 Documentation

- [OpenCode GitHub Integration Docs](https://open-code.ai/docs/en/github)
- [OpenCode Official Site](https://opencode.ai)