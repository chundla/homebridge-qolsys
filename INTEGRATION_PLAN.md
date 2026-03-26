# ha-qolsys-panel → homebridge-qolsys Integration Plan

## Current State

- `homebridge-qolsys` uses Qolsys **Control4 TLS API** (`INFO`, `ZONE_EVENT`, `ARMING`) over panel token auth.
- `ha-qolsys-panel` uses `qolsys-controller` (Python) with **IQ Remote pairing + PKI + MQTT**.
- Most advanced HA features (automation devices, weather, TTS, scenes, locks/lights/climate/cover/valve/siren) come from the MQTT/PKI path, not the legacy C4 API.

## Key Constraint

Feature parity is **not feasible** by extending only the current C4 transport in Homebridge. The transport layer must be expanded/replaced.

## Proposed Architecture

### Option A (recommended first): Node plugin + Python bridge process

- Keep Homebridge plugin in TypeScript.
- Add a local bridge process using `qolsys-controller` (Python) to handle:
  - pairing (autodiscovery + PKI)
  - state subscription
  - command execution
- Homebridge communicates with bridge via local IPC/WebSocket/HTTP JSON.

Pros:
- Fastest path to real feature parity.
- Reuses proven protocol implementation.

Cons:
- Adds Python runtime dependency.

### Option B: Native TypeScript port of qolsys-controller

Pros:
- Single runtime.

Cons:
- Large reverse-engineering effort.
- Slower and higher risk.

## Scope Phases

### Phase 1: Transport foundation
- Add `transportMode` config (`c4` default, `pki` experimental).
- Implement bridge manager in Homebridge.
- Add health/status diagnostics and reconnection logic.

### Phase 2: Device model sync
- Introduce normalized internal model:
  - panel
  - partitions
  - zones
  - automation devices
  - weather
- Build ID mapping from Qolsys objects to stable HomeKit UUIDs.

### Phase 3: HomeKit surface expansion
- Existing + new services where supported by HomeKit:
  - security system
  - contact/motion/leak/smoke/co
  - lock
  - light/switch/outlet
  - thermostat
  - garage/door cover
  - valve
  - siren/alarm switch
  - weather sensor subset

### Phase 4: Commands and services
- Arm/disarm + advanced arming options.
- Lock/unlock, lighting, thermostat setpoints/modes.
- Siren trigger/stop.
- Optional panel TTS endpoint exposure.

### Phase 5: UX and migration
- Config UI for pairing method and PKI paths.
- Migration guide from current token-based setup.
- Backward compatibility with existing C4 users.

## Immediate Next Tasks

1. Add new config schema fields for transport and bridge endpoint/runtime.
2. Add TypeScript interfaces for normalized panel/device events.
3. Scaffold bridge client and event dispatcher in `src/`.
4. Keep existing C4 behavior untouched when `transportMode = c4`.

## Testing Strategy

- Unit tests for model normalization and event mapping.
- Replay tests with captured event payloads.
- Manual integration tests on IQ4 with both transports.
- Verify HomeKit accessory stability across restarts.

## Open Questions

1. Are we OK introducing Python as an optional dependency for `pki` mode?
2. Should first milestone target read-only state parity before write/control?
3. Which device classes are highest priority after security + sensors (locks/lights/climate)?
