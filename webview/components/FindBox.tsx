import React from "react";

export function FindBox() {
  const handleSearch = (previous: boolean) => {
    const findInput = document.getElementById(
      "findInput",
    ) as HTMLInputElement | null;
    if (!findInput) return;
    // Search is handled by the terminal hook's searchAddon
    window.dispatchEvent(
      new CustomEvent("terminal-search", {
        detail: { query: findInput.value, previous },
      }),
    );
  };

  return (
    <div id="findBox" className="findBox" aria-label="Find in active terminal">
      <input
        id="findInput"
        type="text"
        placeholder="Find in terminal"
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            handleSearch(Boolean(e.shiftKey));
          } else if (e.key === "Escape") {
            e.preventDefault();
            const findBox = document.getElementById("findBox");
            if (findBox) findBox.classList.remove("visible");
          }
        }}
        onInput={() => handleSearch(false)}
      />
      <span id="findResult" className="findResult" />
      <button onClick={() => handleSearch(true)} title="Previous match">
        ↑
      </button>
      <button onClick={() => handleSearch(false)} title="Next match">
        ↓
      </button>
      <button
        onClick={() => {
          const findBox = document.getElementById("findBox");
          if (findBox) findBox.classList.remove("visible");
        }}
        title="Close find"
      >
        ×
      </button>
    </div>
  );
}
