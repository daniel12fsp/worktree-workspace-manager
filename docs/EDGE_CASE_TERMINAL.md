Better Reproduction Steps

### Repro A: device attribute leak

In embedded terminal:

```sh
  printf '\033[>c'
```

If the terminal response leaks to the shell, you may see something  
 like:

```text
  0;276;0c
```

or:

```text
  ^[[>0;276;0c
```

### Repro B: stale mouse mode

In embedded terminal:

```sh
  printf '\033[?1003h\033[?1006h'
```

Move the mouse over the embedded terminal.

If stale mouse tracking is active, you may see sequences like:

```text
  ^[[<35;10;5M
```

Reset:

```sh
  printf '\033[?1000l\033[?1002l\033[?1003l\033[?1006l'
```

### Repro C: closer to real bug with Vim

1.  Open embedded terminal.
2.  Run:

```sh
  vim
```

3.  In Vim, enable mouse if needed:

```vim
  :set mouse=a
```

4.  Exit Vim.
5.  Collapse/reselect/switch the embedded terminal so captured output
    is replayed.
6.  Move mouse over terminal.
7.  Check for visible garbage like 0;276;0c or mouse escape  
    sequences.

### Expected results

- A live device-attribute query may generate an xterm response, and that
  response is forwarded to the PTY.
- A query restored from historical terminal state must not write a response
  into the live PTY.
- Live mouse tracking works while an application requests it.
- After Vim exits, `terminal.modes.mouseTrackingMode` remains `none` across
  session switches and view hide/show cycles.
- Restoring a recreated webview must not print device responses or mouse
  reports into the shell.
