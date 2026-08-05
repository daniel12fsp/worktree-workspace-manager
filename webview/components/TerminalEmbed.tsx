import React, { useEffect, useRef } from "react";

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

  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeSessionId) return;

    let frame = 0;
    const updateHeight = () => {
      const wrapper = wrapperRef.current;
      if (!wrapper) return;

      const availableHeight = Math.max(
        160,
        Math.floor(
          window.innerHeight - wrapper.getBoundingClientRect().top - 8,
        ),
      );
      wrapper.style.setProperty(
        "--terminal-inline-height",
        `${availableHeight}px`,
      );
      terminalApi?.resize();
    };
    const scheduleUpdate = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateHeight);
    };

    scheduleUpdate();
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleUpdate);
    };
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
    <div ref={wrapperRef} className="terminalInline active">
      <div ref={containerRef} id="terminal" style={{ height: "100%" }} />
    </div>
  );
}
