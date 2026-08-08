import "./storageShim.js"; // must load before App, since App calls window.storage on mount
import React from "react";
import ReactDOM from "react-dom/client";
import WorshipSlideLibrary from "./App.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <div style={{ maxWidth: 1100, margin: "32px auto", padding: "0 16px" }}>
      <WorshipSlideLibrary />
    </div>
  </React.StrictMode>
);
