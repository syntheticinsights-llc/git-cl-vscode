# git-cl for VS Code

Manage [git-cl](https://github.com/BHFock/git-cl) changelists directly in VS Code. Organize your working changes into logical groups for focused commits — no Python dependency required.

## Features

- **Dual-pane Changelists view** — Dedicated view container with a flat **Changelists** list paired with a **Files** tree for the selected group. Lives in the bottom Panel by default (side-by-side: changelists on the left, files on the right), and can be dragged into the Primary or Secondary Side Bar where VS Code automatically stacks them top-to-bottom.
- **Drag and drop across views** — Drag files or folders from the **Files** view onto any changelist (or **Unassigned**) in the **Changelists** view to reassign them.
- **Add files from anywhere** — Right-click files in the built-in Git Changes section or in **Unassigned** to assign them to a changelist.
- **Stage, commit, diff, revert per changelist** — Inline buttons on each changelist row let you copy, stage, unstage, commit, hide/show, or disband with one click.
- **Hide & show changelists** — Temporarily take a changelist's changes off disk (a git stash, or all of them at once) and bring them back later.
- **Branch from changelist** — Create a new branch containing only the files in a specific changelist.
- **Auto-refresh** — Updates automatically when `cl.json` changes on disk (e.g. from the CLI tool) or when git status changes.
- **Fully interoperable** — Reads and writes the same `.git/cl.json` and `.git/cl-stashes.json` files as the CLI, so you can use both tools side by side.

## Installation

### From VSIX (local build)

```sh
pnpm install
pnpm run package
code --install-extension git-cl-vscode-0.1.34.vsix
```

### Development

```sh
pnpm install
# Press F5 in VS Code to launch the Extension Development Host
```

## Usage

Open a workspace that contains a `.git` directory. The extension activates automatically and adds a **Changelists** container to the bottom Panel (drag its tab into either Side Bar anytime if you prefer vertical stacking).

### Adding files to a changelist

- Right-click a file in the built-in **Changes** list and select **Add to Changelist**.
- Or select **Unassigned** in the **Changelists** view and right-click (or drag) files from the **Files** view.
- Or run `git-cl: Add to Changelist` from the Command Palette.

You'll be prompted to pick an existing changelist or create a new one. Files can only belong to one changelist at a time — adding a file to a new changelist silently moves it.

### Changelist operations

Each changelist row has inline action buttons:

| Button | Action |
|--------|--------|
| **copy** | Copy the changelist name or a review prompt for it |
| **+** | Stage all tracked files in the changelist |
| **-** | Unstage all staged files in the changelist |
| **checkmark** | Commit the changelist (prompts for message) |
| **eye** | Hide the changelist's changes from disk (stashed); click the closed eye to show them again |
| **ungroup** | Disband the changelist (files return to Unassigned, changes are kept) |

Additional operations are available via right-click on the changelist row or the Command Palette:

- **Prune Unchanged Files** — Drop files that no longer have git changes from the changelist.
- **Diff Changelist** — Open diff tabs for every file in the changelist.
- **Checkout (Revert) Changelist** — Discard all changes, reverting files to HEAD.
- **Branch from Changelist** — Create a new branch with only this changelist's files.

### Hidden changelists

A hidden changelist stays in the list with a closed eye; its changes are kept in a git stash until you show them again. Disbanding a hidden changelist shows its changes again first.

## Commands

All commands are available via the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) under the `git-cl` category:

| Command | Description |
|---------|-------------|
| `git-cl: Switch Repository` | Switch which detected repository the views display |
| `git-cl: Add to Changelist` | Add files to a changelist |
| `git-cl: Remove from Changelist` | Remove files from their changelist |
| `git-cl: Disband Changelist` | Disband a changelist, keeping its changes |
| `git-cl: Disband All Changelists` | Disband all changelists, keeping their changes |
| `git-cl: Prune Unchanged Files` | Remove unchanged files from a changelist |
| `git-cl: Stage Changelist` | Stage tracked files in a changelist |
| `git-cl: Unstage Changelist` | Unstage files in a changelist |
| `git-cl: Commit Changelist` | Commit a changelist with a message |
| `git-cl: Diff Changelist` | Open diffs for all files in a changelist |
| `git-cl: Checkout (Revert) Changelist` | Revert files to HEAD |
| `git-cl: Show Changelist Status` | Show formatted status in the output panel |
| `git-cl: Stash All Changelists` | Stash all active changelists |
| `git-cl: Unstash All Changelists` | Restore all stashed changelists |
| `git-cl: Branch from Changelist` | Create a new branch from a changelist |
| `git-cl: Copy from Changelist…` | Copy changelist name or review prompt |
| `git-cl: Edit Review Prompt Template` | Open or create the review prompt template |

## Requirements

- VS Code 1.107+
- Git installed and available on `PATH`

## License

MIT
