import React, { useEffect } from "react";

interface Props {
  activeSessionId: string | undefined;
  containerRef: React.RefObject<HTMLDivElement | null>;
  terminalApi: {
    focus: () => void;
    clearAndWrite: (data: string) => void;
    write: (data: string) => void;
    clear: () => void;
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
      requestAnimationFrame(() => terminalApi.focus());
    }
  }, [activeSessionId, terminalApi]);

  useEffect(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const findBox = document.getElementById("findBox");
        if (findBox && findBox.classList.contains("visible")) {
          e.preventDefault();
          e.stopPropagation();
          findBox.classList.remove("visible");
          terminalApi?.focus();
        }
      }
    };
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [terminalApi]);

  if (!activeSessionId) return null;

  return (
    <div className="terminalInline active">
      <div ref={containerRef} id="terminal" style={{ height: "100%" }} />
    </div>
  );
}
