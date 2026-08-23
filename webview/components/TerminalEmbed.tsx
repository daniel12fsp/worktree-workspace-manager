import React, { useCallback, useEffect, useRef } from "react";
import { hideTerminalFindBox } from "../hooks/useTerminal";

interface Props {
  activeSessionId: string | undefined;
  containerRef: React.RefObject<HTMLDivElement | null>;
  terminalApi: {
    focus: () => void;
    replay: (
      id: string,
      data: string,
      delta?: string,
      outputOffset?: number,
    ) => void;
    write: (id: string, data: string, outputOffset?: number) => void;
    clear: (id: string) => void;
    resize: () => void;
  } | null;
}

export function TerminalEmbed({
  activeSessionId,
  containerRef,
  terminalApi,
}: Props) {
  useEffect(() => {
    if (activeSessionId && terminalApi) {
      requestAnimationFrame(() => {
        terminalApi.focus();
      });
    }
  }, [activeSessionId, terminalApi]);

  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeSessionId) return;

    let frame = 0;
    const scheduleResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => terminalApi?.resize());
    };

    scheduleResize();
    window.addEventListener("resize", scheduleResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleResize);
    };
  }, [activeSessionId, terminalApi]);

  const handleFocusTerminal = useCallback(() => {
    terminalApi?.focus();
  }, [terminalApi]);

  useEffect(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && hideTerminalFindBox()) {
        e.preventDefault();
        e.stopPropagation();
        terminalApi?.focus();
      }
    };
    window.addEventListener("keydown", handleKeydown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [terminalApi]);

  return (
    <div
      ref={wrapperRef}
      className={`terminalInline${activeSessionId ? " active" : ""}`}
      aria-hidden={!activeSessionId}
      onMouseDown={handleFocusTerminal}
      onClick={handleFocusTerminal}
    >
      <div
        ref={containerRef}
        id="terminal"
        className="terminalSessions"
        style={{ height: "100%" }}
      />
    </div>
  );
}
