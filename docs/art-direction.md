# Art direction notes

Original retro-futuristic digital archipelago: low-poly/voxel forms, 16×16 nearest-filtered pixel
textures (generated in code, no external assets), flat shading, a few emissive "circuit" accents,
one hemisphere + one directional light, no real-time shadows. Everything is procedural and
original; no franchise characters, logos, or environments are referenced.

## Palette

| Name | Use | Base / glow |
|---|---|---|
| aurum | Hermes, HQ crown, deliverables | `#f2c45a` / `#ffd76a` |
| circuit | towers, paths, portals | `#1d2a44` / `#38e1ff` |
| grass / rock | island tops / undersides | `#2f9d74` / `#4a4f6b` |
| ember | Builder | `#e8743b` |
| tide | Researcher | `#3bb6d6` |
| jade | Reviewer | `#3fcf8e` |
| violet | Designer | `#9b6cf0` |

Sky: gradient dome (deep navy → violet → teal horizon), bounded starfield (350 points), distant
dark spire silhouettes, a faint grid "data sea" far below.

## Hermes Headquarters

Floating voxel island (radius 7, tapered rock underside), central two-stage administrator tower
with an aurum crown and a beacon crystal, six glowing circuit paths, a research dome with a dish,
a worker spawning pad with a ring, an **artifact archive whose slabs equal the real number of
recorded deliverables**, and three portal rings reserved for project bridges. Light bridges run
from HQ to active project islands.

## Hermes avatar (original)

Robed, faceless figure with a cyan visor slit, a crest and halo, three stepped "digital feather" fins
per side, and an orbiting icosahedral command orb. Poses (driven by real state, see
`world-projection.hermesPose`):

| Pose | Trigger | Read |
|---|---|---|
| idle | nothing pending | slow hover, gold ring hidden |
| planning | a project is proposed/planning | orb widens orbit, cyan ring rotates |
| reviewing | a task is in review | jade scanning wedge sweeps |
| blocked | pending approval or blocked task | wings fold, amber ring, no flapping |
| alert | emergency stop or disconnected | wings flare, red ring pulsing at ≤1 Hz (steady with reduced motion) |

## Workers

| Role | Silhouette | Emblem | Prop (shown only if capability granted) |
|---|---|---|---|
| Builder | stocky block body, flat cap | glowing hex bolt disc | hammer ⇐ `writeDeliverables` |
| Researcher | tall slim column, antenna | antenna tip | lens ring ⇐ `browseWeb` |
| Reviewer | round body | gauge face | needle ⇐ `readProjectInputs` |
| Designer | tapered cone, prism head | prism | stylus ⇐ `writeDeliverables` |

Animations: idle (still), walk-to-task on assignment, work (prop swing), review (gauge spin),
blocked/error (status gem, no motion), depart (sink). A spinning status gem appears only for real
working/review/blocked/error states. Disconnected ⇒ everything idles.

## Island lifecycle

Creation (5 s): signal beam → terrain fragments converge → island rises → structures grow →
label fades in → agents arrive. Removal presets: **controlled demolition** (charge glow, one soft
pulse ≤ 0.6, outward collapse), **earthquake** (2 Hz rumble, crack, fall), **pixel dissolution**
(voxel dust drifting upward, no flash). Reduced motion (system setting or app toggle) replaces all
of these with a 0.8 s fade. Archived islands leave a dim obelisk marker labelled "archived";
destroyed islands free their slot. Island beacon colour = project state; only `working` pulses.

Timing lives in `packages/world-renderer/src/effects.ts` (pure, unit-tested) so a Unity client can
reproduce it exactly.
