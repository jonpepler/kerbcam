import "./styles.css";
import { BrowserKerbcastTransport, KerbcastClient } from "@ksp-gonogo/kerbcast";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { loadLocalMediabunnyTrimmer } from "./mediabunnyAsset";

async function bootstrap() {
  let client: KerbcastClient;

  // If mock=1 in query string, dynamically import the mock driver which
  // constructs and returns a MockSidecar-backed client.
  if (new URLSearchParams(location.search).get("mock") === "1") {
    const { createMockClient } = await import("./mock/driver");
    client = await createMockClient();
  } else {
    const host = location.hostname;
    const port = location.port ? Number(location.port) : 8088;
    client = new KerbcastClient(
      { host, port, recording: { loadTrimmer: loadLocalMediabunnyTrimmer } },
      new BrowserKerbcastTransport(),
    );
  }

  const root = document.getElementById("root");
  if (!root) throw new Error("No #root element");

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App client={client} />
    </React.StrictMode>,
  );
}

void bootstrap();
