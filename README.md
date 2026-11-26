# git-cl for VS Code

Manage [git-cl](https://github.com/BHFock/git-cl) changelists directly in VS Code. Organize your working changes into logical groups for focused commits — no Python dependency required.

## Features

- **Changelists in Source Control** — Each changelist appears as a group in the Source Control sidebar with file status decorations (modified, added, deleted, untracked).
- **Add files from anywhere** — Right-click files in the built-in Git Changes section or the Unassigned group to assign them to a changelist.
- **Stage, commit, diff, revert per changelist** — Inline buttons on each changelist header let you stage, commit, diff, or revert all files in the group with one click.
- **Hide & show changelists** — Temporarily take a changelist's changes off disk (a git stash, or all of them at once) and bring them back later.
- **Branch from changelist** — Create a new branch containing only the files in a specific changelist.
- **Auto-refresh** — The tree updates automatically when `cl.json` changes on disk (e.g. from the CLI tool) or when git status changes.
- **Fully interoperable** — Reads and writes the same `.git/cl.json` and `.git/cl-stashes.json` files as the Python CLI, so you can use both tools side by side.

## Installation

### From VSIX (local build)

```sh
npm install
npm run package
code --install-extension git-cl-vscode-0.0.1.vsix
```

### Development

```sh
npm install
# Press F5 in VS Code to launch the Extension Development Host
```

## Usage

Open a workspace that contains a `.git` directory. The extension activates automatically and adds a **Changelists** section to the Source Control sidebar.

### Adding files to a changelist

- Right-click a file in the built-in **Changes** list and select **Add to Changelist**.
- Or right-click a file in the **Unassigned** group under Changelists.
- Or run `git-cl: Add to Changelist` from the Command Palette.

You'll be prompted to pick an existing changelist or create a new one. Files can only belong to one changelist at a time — adding a file to a new changelist silently moves it.

### Changelist operations

Each changelist group header has inline action buttons:

| Button | Action |
|--------|--------|
| **+** | Stage all tracked files in the changelist |
| **-** | Unstage all staged files in the changelist |
| **checkmark** | Commit the changelist (prompts for message) |
| **copy** | Copy the changelist name or a review prompt for it |
| **eye** | Hide the changelist's changes from disk (stashed); click the closed eye to show them again |
| **ungroup** | Disband the changelist (files return to Unassigned, changes are kept) |

Additional operations are available via right-click on the changelist header or the Command Palette:

- **Diff Changelist** — Open diff tabs for every file in the changelist.
- **Checkout (Revert) Changelist** — Discard all changes, reverting files to HEAD.
- **Branch from Changelist** — Create a new branch with only this changelist's files.

### Hidden changelists

A hidden changelist stays in the list with a closed eye; its changes are kept in a git stash until you show them again. Disbanding a hidden changelist shows its changes again first.

## Commands

All commands are available via the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) under the `git-cl` category:

| Command | Description |
|---------|-------------|
| `git-cl: Add to Changelist` | Add files to a changelist |
| `git-cl: Remove from Changelist` | Remove files from their changelist |
| `git-cl: Disband Changelist` | Disband a changelist, keeping its changes |
| `git-cl: Disband All Changelists` | Disband all changelists, keeping their changes |
| `git-cl: Stage Changelist` | Stage tracked files in a changelist |
| `git-cl: Unstage Changelist` | Unstage files in a changelist |
| `git-cl: Commit Changelist` | Commit a changelist with a message |
| `git-cl: Diff Changelist` | Open diffs for all files in a changelist |
| `git-cl: Checkout (Revert) Changelist` | Revert files to HEAD |
| `git-cl: Show Changelist Status` | Show formatted status in the output panel |
| `git-cl: Stash All Changelists` | Stash all active changelists |
| `git-cl: Unstash All Changelists` | Restore all stashed changelists |
| `git-cl: Branch from Changelist` | Create a new branch from a changelist |

## Requirements

- VS Code 1.85+
- Git installed and available on `PATH`

## License

MIT

## Changelist board

`git-cl: Open Changelist Board` opens a board that draws the same changelists
as the Source Control tree, for every repository VS Code sees: the repository
list comes from the built-in Git extension, so it follows the same detection
settings (`git.autoRepositoryDetection`, `git.scanRepositories`, nested-repo
scan depth) as Source Control. A picker in the board's top-left switches
between them; repositories without changelists show their changes as
Unassigned.

The panel is restorable: a registered serializer brings it back after a window
restart — in the floating window it was dragged into — with the same
repository, changelist and collapsed folders. It is a webview panel, so VS Code can move it into
its own window (`Move into New Window`, or drag the tab out) — that is what
makes it usable on a second screen next to the editor.

The board is one column, because a dragged-out window is tall: the changelist
list sits on top (capped at 45% of the height, so a long list never pushes the
detail away), and the selected changelist fills everything below it — its commit
box first, then its files as the folder tree Source Control shows (single-child
chains compact, `scm.compactFolders` respected, folders collapse and remember
where you left them).

Every file shows its added/removed line counts on the right; files git cannot
count (binaries) fall back to the status letter Source Control uses.

Clicking a file opens the file's diff against HEAD in the editor group to the
right of the board as a preview tab, keeping keyboard focus in the board, so the
diff follows the file you pick. VS Code cannot open an editor inside a floating
window, so a board that lives in one sends its diffs to the main window.

## Installation

### From VSIX (local build)

```sh
npm install
npm run package
code --install-extension git-cl-vscode-0.0.1.vsix
```

### Development

```sh
npm install
# Press F5 in VS Code to launch the Extension Development Host
```

## Usage

Open a workspace that contains a `.git` directory. The extension activates automatically and adds a **Changelists** section to the Source Control sidebar.

### Adding files to a changelist

- Right-click a file in the built-in **Changes** list and select **Add to Changelist**.
- Or right-click a file in the **Unassigned** group under Changelists.
- Or run `git-cl: Add to Changelist` from the Command Palette.

You'll be prompted to pick an existing changelist or create a new one. Files can only belong to one changelist at a time — adding a file to a new changelist silently moves it.

### Changelist operations

Each changelist group header has inline action buttons:

| Button | Action |
|--------|--------|
| **+** | Stage all tracked files in the changelist |
| **-** | Unstage all staged files in the changelist |
| **checkmark** | Commit the changelist (prompts for message) |
| **copy** | Copy the changelist name or a review prompt for it |
| **eye** | Hide the changelist's changes from disk (stashed); click the closed eye to show them again |
| **ungroup** | Disband the changelist (files return to Unassigned, changes are kept) |

Additional operations are available via right-click on the changelist header or the Command Palette:

- **Diff Changelist** — Open diff tabs for every file in the changelist.
- **Checkout (Revert) Changelist** — Discard all changes, reverting files to HEAD.
- **Branch from Changelist** — Create a new branch with only this changelist's files.

### Hidden changelists

A hidden changelist stays in the list with a closed eye; its changes are kept in a git stash until you show them again. Disbanding a hidden changelist shows its changes again first.

## Commands

All commands are available via the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) under the `git-cl` category:

| Command | Description |
|---------|-------------|
| `git-cl: Add to Changelist` | Add files to a changelist |
| `git-cl: Remove from Changelist` | Remove files from their changelist |
| `git-cl: Disband Changelist` | Disband a changelist, keeping its changes |
| `git-cl: Disband All Changelists` | Disband all changelists, keeping their changes |
| `git-cl: Stage Changelist` | Stage tracked files in a changelist |
| `git-cl: Unstage Changelist` | Unstage files in a changelist |
| `git-cl: Commit Changelist` | Commit a changelist with a message |
| `git-cl: Diff Changelist` | Open diffs for all files in a changelist |
| `git-cl: Checkout (Revert) Changelist` | Revert files to HEAD |
| `git-cl: Show Changelist Status` | Show formatted status in the output panel |
| `git-cl: Stash All Changelists` | Stash all active changelists |
| `git-cl: Unstash All Changelists` | Restore all stashed changelists |
| `git-cl: Branch from Changelist` | Create a new branch from a changelist |

## Requirements

- VS Code 1.85+
- Git installed and available on `PATH`

## License

MIT

## Changelist board

`git-cl: Open Changelist Board` opens a board that draws the same changelists
as the Source Control tree, for every repository VS Code sees: the repository
list comes from the built-in Git extension, so it follows the same detection
settings (`git.autoRepositoryDetection`, `git.scanRepositories`, nested-repo
scan depth) as Source Control. A picker in the board's top-left switches
between them; repositories without changelists show their changes as
Unassigned.

The panel is restorable: a registered serializer brings it back after a window
restart — in the floating window it was dragged into — with the same
repository, changelist and collapsed folders. It is a webview panel, so VS Code can move it into
its own window (`Move into New Window`, or drag the tab out) — that is what
makes it usable on a second screen next to the editor.

The board follows its width:

- narrow — the changelist list with their files inline, like the Source Control sidebar;
- wide enough for a second column — that column holds the changelist's commit box
  at the top (always visible, however long the file list) and its files below,
  arranged as the folder tree Source Control shows (single-child chains compact,
  `scm.compactFolders` respected, folders collapse and remember where you left them).
  Each file shows its added/removed line counts on the right; files git cannot
  count (binaries) fall back to the status letter Source Control uses.

With no second column there is no commit box either; widen the panel or commit
from the tree. Rows, buttons, colors and scrollbars follow the workbench so the
board reads as part of the editor rather than as a page pasted into it.

Clicking a file opens the file's diff against HEAD **beside** the board as a
preview tab and keeps keyboard focus in the board, so the diff follows the
file you pick. All git work still runs in the extension host, which is why the
board behaves exactly like the tree (and works over Remote-SSH).
