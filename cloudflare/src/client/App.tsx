import type { JSX } from "@solidjs/web";
import { Router } from "./router";
import { Shell } from "./Shell";

export function App(): JSX.Element {
  return (
    <Router>
      {(props) => <Shell>{props.children}</Shell>}
    </Router>
  );
}
