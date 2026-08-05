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
