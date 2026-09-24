import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("access-map"),
  component: () =>
    import("./access-map-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-access-map-page></openclaw-access-map-page>`,
    })),
});
