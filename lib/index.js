// Node half of dsh-desktop-web-reload.
//
// This plugin is a **Client** plugin: everything it does happens in the browser
// half (`lib/client.js`), which injects the 「刷新」 button into the DSH Desktop
// Windows caption menubar. But the interaction lives in the Electron **preload**
// (`app.asar!/lib/preload-app.cjs`, `installWindowsMenu`), not in a Cordis Slot:
// the preload builds a `<div data-windows-menu>` with an OPEN shadow root holding
// the 「应用」/「编辑」 buttons, and no Slot exposes that shadow tree. So the
// browser half reaches the caption through the DOM instead of through a Slot —
// which is the only seam that exists for that row.
//
// The Node half therefore has no work of its own. It exists so the loader row in
// `cordis.patch.yml` targets a real module, exactly like every other bundle in
// this profile. It deliberately imports nothing: a plugin whose host half is
// empty cannot break the Host, and this one must stay loadable in a plain
// `dsh web` / headless deployment too, where its browser half simply installs
// nothing (there is no caption menubar to extend).

/**
 * Mount the plugin on the Host. Intentionally empty: the plugin has no Host-side
 * behaviour, and an empty `apply` is a valid Cordis plugin.
 */
export function apply() {}
