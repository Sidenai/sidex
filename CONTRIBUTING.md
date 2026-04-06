# Contributing to SideX

Thanks for your interest. SideX was released early specifically so the community can help build it out.

## Quick Start

```bash
git clone https://github.com/Sidenai/sidex.git
cd sidex
npm install
npm run tauri dev
```

See the [README](./README.md) for full prerequisites.

## How to Contribute

1. **Fork** the repo
2. **Create a branch** — `git checkout -b my-fix`
3. **Make your changes** and test with `npm run tauri dev`
4. **Submit a PR** with a clear description of what you changed and why

PRs get reviewed as fast as we can. If your change gets merged, you'll be added as a contributor.

## What to Work On

Check [Issues](https://github.com/Sidenai/sidex/issues) for open tasks. If you don't see an issue for what you want to fix, just open a PR — we're not strict about process.

## Code Guidelines

### TypeScript
- Follow the existing VSCode patterns in the codebase
- Use `.js` extensions on imports (ES modules)
- Use VSCode's DI pattern with `@inject` decorators

### Rust
- Commands go in `src-tauri/src/commands/`
- Register new commands in `src-tauri/src/lib.rs`
- Use `Result<T, String>` for command return types
- Use `tokio` for async work

### General
- Keep PRs focused — one feature or fix per PR when possible
- If you're making a big architectural change, open an issue first to discuss

## Project Layout

- `src/vs/` — The VSCode workbench (TypeScript)
- `src-tauri/src/` — Rust backend replacing Electron
- `ARCHITECTURE.md` — How VSCode's architecture maps to Tauri

## Questions?

Join the Discord if you need help getting set up or want to coordinate: [discord.gg/8CUCnEAC4J](https://discord.gg/8CUCnEAC4J)

You can also reach out at kendall@siden.ai or [@ImRazshy](https://x.com/ImRazshy) on X.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
