# Privacy

Invert colors applies color filters inside web pages. It has no telemetry, analytics, advertising, user accounts, backend service, or network synchronization. Its runtime code does not send data to an external service.

## Information used

The extension reads tab URLs and document/frame identities to choose the saved website mode, apply it to frames, and scope temporary changes to the current document. Saved website rules use exact hostnames rather than full browsing URLs. The extension does not keep a browsing-history log.

Content scripts inspect page elements, styles, and changes to the DOM to identify media and apply or restore filters. A small script in the page's main JavaScript context observes the creation of open Shadow DOM roots. It does not receive your settings. Page content is not sent to an external service or included in settings exports.

## Storage and exports

- `chrome.storage.local` holds extension settings, media preferences, and saved website hostnames and modes.
- `chrome.storage.session` holds temporary tab choices and state used to coordinate updates. Temporary choices end when their document is replaced or the browser session ends.
- **Export JSON** creates a local settings file that includes saved hostnames. Sharing that file shares those rules. **Import JSON** reads the file you select, validates it, and replaces the current settings. Temporary tab choices are not exported.

The extension does not use browser settings synchronization. Uninstalling it removes its extension storage; exported files remain wherever you saved them.

## Permissions

| Permission | Purpose |
| --- | --- |
| `storage` | Save settings and temporary session state. |
| `scripting` | Inject the filter engine into accessible pages when needed. |
| `activeTab` | Support actions on the current tab after user interaction. |
| `contextMenus` | Provide quick actions on the toolbar icon. |
| `webNavigation` | Identify documents and frames and reset temporary state after navigation. |
| HTTP, HTTPS, and file host access | Apply filters automatically to supported pages and their frames. Local files require separate file URL access to be enabled by the user. |

These permissions allow the extension to work across websites. They do not change the network behavior or privacy policies of the websites you visit.
