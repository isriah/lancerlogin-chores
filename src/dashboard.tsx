// Dashboard contribution. It imports only the module SDK, React and the plugin's own files; the composed dashboard provides
// one shared copy of each. Core renders the settings page and the setup screen inside the module root that scopes the stylesheet.
import { defineDashboardModule } from "@lancerlogin/module-sdk/dashboard";
import { ChoresSettings } from "./dashboard/chores-settings";
import { ChoresSetup } from "./dashboard/chores-setup";
// Imported after the components so these rules follow the Core stylesheets those components load.
import "./chores.css";

const dashboard = defineDashboardModule({
  moduleId: "chores",
  // Not marked `operator`, so Core shows it only to Admins. The settings routes behind it also require an Admin.
  settingsPages: [{ path: "/settings/chores", render: ({ openSetup }) => <ChoresSettings openSetup={openSetup} /> }],
  setup: ChoresSetup,
});

export default dashboard;
