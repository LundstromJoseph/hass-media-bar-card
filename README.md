# Media Bar Card

A slim Lovelace card for Home Assistant media players. Auto-switches between a full media mode (artwork, track info, volume bar) and a compact mode (device name, volume bar).

## Installation

Add as a custom repository in HACS → Frontend, then add the resource and use `custom:media-bar-card` in your dashboard.

## Config

```yaml
type: custom:media-bar-card
entity: media_player.living_room
name: Living Room        # optional, overrides friendly_name
compact_when: switch.speaker_group  # optional — force compact mode when this entity is "on"
```

## Modes

**Media mode** — shown when `media_title` is set (or `compact_when` entity is off):
```
[ART]  Device Name
[ART]  Title · Artist
[████████████░░░░░]  65%
```

**Compact mode** — shown when no media info, or `compact_when` entity is on:
```
DEVICE NAME
[████████████░░░░░]  65%
```
