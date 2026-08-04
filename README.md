# Overview

ElecSense is a fault detection and localization demo for a radial electricity
distribution network.

# Quick Start

Simulator endpoints are intentionally unauthenticated for take-home review:

- `GET /api/simulator/network` returns the current network plus real ground-truth topology.
- `POST /api/simulator/span-fault` with `{ "dtId": "DT-001", "atPoleId": "P-024431" }` injects a downstream span fault.
- `POST /api/simulator/dt-fault` with `{ "dtId": "DT-001" }` injects a full DT outage.
- `POST /api/simulator/feeder-fault` with `{ "feederId": "F-01" }` injects a feeder outage.
- `POST /api/simulator/dead-sensor` with `{ "poleId": "P-024431" }` silences one sensor without sending `power_lost`.
- `POST /api/simulator/scheduled-outage` with `{ "dtId": "DT-001" }` creates an active planned outage and injects dark telemetry.
- `POST /api/simulator/repair/:incidentId` sends `boot` + `power_restored` telemetry for an incident's affected poles.

# Docs
