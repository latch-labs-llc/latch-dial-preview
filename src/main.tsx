import "./polyfill"; // MUST stay the first import — see polyfill.ts

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ToastHost } from "./components/ui";
import { DataProvider } from "./lib/data";
import { loadLocal } from "./lib/store";
import { Wallets } from "./lib/wallet";
import "./styles/app.css";

loadLocal().finally(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <Wallets>
        <DataProvider>
          <ToastHost>
            <App />
          </ToastHost>
        </DataProvider>
      </Wallets>
    </React.StrictMode>,
  );
});
