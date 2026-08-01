import React from "react";
import { useVsCode } from "../hooks/useVsCode";

interface Props {
  message: string;
}

export function Welcome({ message }: Props) {
  const vscode = useVsCode();

  return (
    <div className="welcome">
      <strong>{message}</strong>
      <button onClick={() => vscode.postMessage({ type: "openMenu" })}>
        Open Worktree Manager Menu
      </button>
    </div>
  );
}
