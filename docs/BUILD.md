npm install
npm run compile
vsce package
code --install-extension worktree-workspace-manager-0.0.2.vsix

To reset a VSCode extension on Linux:

### 1. Uninstall/reinstall extension

```bash
  code --uninstall-extension publisher.extensionName
  code --install-extension publisher.extensionName
```

List installed extensions:

```bash
  code --list-extensions
```

### 2. Clear extension global storage

Most extension state is here:

```bash
  rm -rf ~/.config/Code/User/globalStorage/<publisher.extensionName>
```

For VSCode Insiders:

```bash
  rm -rf ~/.config/Code\ -\ Insiders/User/globalStorage/<publisher.extensionName>
```

### 3. Clear workspace-specific storage

```bash
  rm -rf ~/.config/Code/User/workspaceStorage
```

Careful: this resets workspace storage for all extensions.

### 4. Reset extension settings

Open VSCode settings JSON:

```bash
  code ~/.config/Code/User/settings.json
```

Remove keys related to the extension.

For this project, likely remove:

```json
  "worktreeManager.repositories": [],
  "worktreeManager.colors": {},
  "worktreeManager.tasks": {}
```

### 5. Reload VSCode

Press:

```text
  Ctrl+Shift+P → Developer: Reload Window
```
