# Media Bar Card

A slim Lovelace card for Home Assistant that manages a pool of grouping-capable media players. Shows a unified group row when speakers are joined, individual rows when they're not, and a dialog to edit group membership.

## Installation

Add as a custom repository in HACS → Frontend, then add the resource and use `custom:media-bar-card` in your dashboard.

## Config

```yaml
type: custom:media-bar-card
entities:
  - media_player.living_room
  - media_player.kitchen
  - media_player.office
title: Speakers          # optional — shown in top bar
group_label: Grouped     # optional — appended to master name when grouped (default: "Grouped")
names:                   # optional — override friendly names
  media_player.living_room: Vardagsrum
  media_player.kitchen: Kök
```

## Features

- **Group row** — shown when speakers are joined; displays master metadata, album art, and an absolute group volume slider
- **Solo rows** — individual volume sliders for ungrouped speakers
- **Per-speaker volume** — expand chevron on group row reveals individual sliders
- **Membership editor** — link icon in the top bar opens a modal dialog; check/uncheck speakers and press Apply
- Works with any `media_player` that supports the HA grouping feature (`media_player.join` / `media_player.unjoin`)
