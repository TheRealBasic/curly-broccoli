# Voice Chat + Screen Share Improvement Plan

## Goal
Deliver a more reliable, low-latency voice experience and add secure, channel-scoped screen sharing with clear moderation controls.

## Phase 1 — Stabilize Current Voice Chat
1. **Connection reliability hardening**
   - Add heartbeat + reconnect backoff tuning for voice signaling sockets.
   - Add explicit ICE restart handling on peer connection failures.
   - Add per-peer state metrics (`connecting`, `connected`, `failed`, `restarting`).
2. **Audio quality upgrades**
   - Enable user controls for input gain and output volume per participant.
   - Add default browser audio constraints (echo cancellation, noise suppression, AGC).
   - Display active speaking indicators using audio level detection.
3. **Operational visibility**
   - Add server/client logs for join/leave/signal failure categories.
   - Add dashboards for join success rate, median setup time, and disconnect causes.

## Phase 2 — Screen Share MVP
1. **Protocol additions**
   - Extend shared event contracts for screen share lifecycle:
     - `screen:share-start`
     - `screen:share-stop`
     - `screen:signal`
     - `screen:viewer-joined`
     - `screen:viewer-left`
2. **Client UX**
   - Add "Start screen share" / "Stop sharing" controls in the voice panel.
   - Show currently shared stream in the chat panel with presenter label.
   - Add "You are sharing" persistent banner and easy stop affordance.
3. **WebRTC flow**
   - Use `getDisplayMedia()` for presenter capture.
   - Reuse signaling channel with stream-type metadata (`audio`, `screen`).
   - Support single presenter per channel for MVP (later expand to multi-share).

## Phase 3 — Permissions, Safety, and Moderation
1. **Access control**
   - Restrict share start to members with voice access to the channel.
   - Add optional role gate: "Can share screen".
2. **Moderation controls**
   - Add server-side ability to force-stop a user share.
   - Emit moderation audit events for share start/stop/force-stop.
3. **Privacy/consent UX**
   - Show explicit browser and in-app consent states.
   - Warn users when sharing entire display vs single window.

## Phase 4 — Performance and Scalability
1. **Resource controls**
   - Default frame-rate and bitrate presets for screen content types.
   - Dynamic bitrate adaptation based on packet loss and RTT.
2. **Topology improvements**
   - Keep P2P for small channels; define threshold for SFU migration.
   - Document phased SFU plan for larger voice rooms.

## Phase 5 — QA and Rollout
1. **Automated tests**
   - Add unit tests for new protocol validation in shared types.
   - Add API tests for permission checks and share lifecycle.
   - Add end-to-end web tests for start/stop share and viewer rendering.
2. **Staged rollout**
   - Feature-flag screen share (internal -> beta channels -> full rollout).
   - Track error budgets and rollback criteria.

## Definition of Done
- Voice reconnect failure rate reduced and measured.
- Users can start/stop screen share in-channel with reliable viewer playback.
- Role-based permissions and moderation controls are active.
- Metrics and alerts exist for voice/screen share reliability.

## Immediate Next Actions
1. Finalize shared event schema changes in `packages/shared`.
2. Implement API signaling handlers and permission checks in `apps/api`.
3. Implement web UI controls + stream rendering in `apps/web`.
4. Add tests for schema, server handlers, and UI happy paths.

I’ll do it.
