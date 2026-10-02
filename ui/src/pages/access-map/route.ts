import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import { shellLayoutTraits } from "../../app/shell-layout-traits.ts";

export const page = definePage({
  ...routePageSpec("access-map"),
  component: () =>
    import("./access-map-page.ts").then(() => ({
      header: true,
      render: () =>
        html`<openclaw-access-map-page
          ${shellLayoutTraits({ accessMapPage: true })}
        ></openclaw-access-map-page>`,
    })),
});
