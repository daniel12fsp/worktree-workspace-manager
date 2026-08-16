import React from "react";
import type { AppState } from "../App";
import type { useTerminal } from "../hooks/useTerminal";
import { FindBox } from "./FindBox";
import { TerminalEmbed } from "./TerminalEmbed";
import { TreeSelector } from "./TreeSelector";

interface AppLayoutProps {
  state: AppState;
  terminalPanePercent: number;
  splitContainerRef: React.RefObject<HTMLDivElement | null>;
  terminalContainerRef: React.RefObject<HTMLDivElement | null>;
  terminalApi: ReturnType<typeof useTerminal>;
  handleResizeMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  treeProps: Omit<React.ComponentProps<typeof TreeSelector>, "state">;
}

export function AppLayout(props: AppLayoutProps): React.JSX.Element {
  const terminalPane = (
    <section
      className="terminalPane"
      aria-label="Terminal panel"
      style={{ flex: `0 0 ${String(props.terminalPanePercent)}%` }}
    >
      <TerminalEmbed
        activeSessionId={props.state.activeSessionId}
        containerRef={props.terminalContainerRef}
        terminalApi={props.terminalApi}
      />
    </section>
  );
  const resizeHandle = (
    <div
      className="resizeHandle"
      role="separator"
      aria-label="Resize terminal and tree panels"
      aria-orientation="vertical"
      onMouseDown={props.handleResizeMouseDown}
      style={{ flex: "0 0 6px" }}
    />
  );
  const selectorPane = (
    <TreeSelector state={props.state} {...props.treeProps} />
  );
  const panes =
    props.state.terminalsLayoutOrder === "selectorFirst"
      ? [selectorPane, resizeHandle, terminalPane]
      : [terminalPane, resizeHandle, selectorPane];
  return (
    <div className="root">
      <FindBox />
      <div ref={props.splitContainerRef} className="splitLayout">
        {panes.map((pane, index) => React.cloneElement(pane, { key: index }))}
      </div>
    </div>
  );
}
