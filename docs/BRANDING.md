# Orbit branding

The approved identity is a purple planet with one lilac orbital ring and a lowercase wordmark. Keep a visible gap on both sides of the foreground ring where it crosses the planet.

The supplied assets preserve the approved artwork. The sidebar uses separate dark and light lockups, and switches to the planet mark when the sidebar collapses. The mark also appears while the library opens.

| Asset | Use |
| --- | --- |
| `assets/branding/orbit-logo-dark.png` | Full wordmark on dark surfaces |
| `assets/branding/orbit-logo-light.png` | Full wordmark on light surfaces |
| `assets/branding/orbit-mark-dark.png` | Compact sidebar and startup mark on dark surfaces |
| `assets/branding/orbit-mark-light.png` | Compact sidebar mark on light surfaces |
| `assets/icon.png` | 1024px desktop icon, used by Electron, macOS and Linux packaging |
| `assets/icon.ico` | Windows icon with 16, 32, 48, 64, 128 and 256px entries |

The PNG assets are indexed, cropped and resized for their display sizes. They have opaque backgrounds; the UI blends them with the corresponding theme surface. The failed transparent image exports are not included. The purple identity stays fixed when the user changes the interface accent color.
