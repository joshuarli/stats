import { render } from "@solidjs/web";
import { App } from "./App";
import "./style.css";

const root = document.getElementById("app");
if (root === null) throw new Error("The dashboard root element is missing.");

root.replaceChildren();
const dispose = render(() => <App />, root);
window.addEventListener("pagehide", () => dispose(), { once: true });
if (import.meta.hot) import.meta.hot.dispose(() => dispose());
