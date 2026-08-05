# ElecSense

ElecSense is an AI-assisted fault detection and localization platform for radial electricity distribution networks. It ingests telemetry from field devices, detects outages, localizes probable fault locations, generates operator-ready incidents, and provides AI-assisted dispatch notes for field crews.

---

# Features

- Real-time telemetry ingestion
- Automatic fault detection
- Span, DT, and feeder fault localization
- Scheduled outage suppression
- Dead sensor detection
- Automatic incident lifecycle management
- AI-generated dispatch notes
- Interactive operator dashboard
- Fault simulator
- Grid health monitoring
- Leaflet network visualization
- Dockerized deployment

---

# Tech Stack

### Frontend

- React
- Vite
- Leaflet
- CSS

### Backend

- Node.js
- Express
- Drizzle ORM

### Database

- PostgreSQL

### AI

- Google Gemini

### DevOps

- Docker
- Docker Compose

---

# Project Structure

```text
ElecSense
│
├── api
│   ├── src
│   ├── simulator
│   ├── services
│   └── db
│
├── web
│   ├── src
│   ├── public
│   └── assets
│
├── docker-compose.yml
└── README.md
```

---

# Quick Start

## Clone

```bash
git clone https://github.com/<your-username>/ElecSense.git
cd ElecSense
```

## Run Using Docker

```bash
docker compose up --build
```

Frontend:

```text
http://localhost:5173
```

Backend:

```text
http://localhost:3000
```

---

# Simulator Endpoints

Simulator endpoints are intentionally unauthenticated for demo and review workflows.

- `GET /api/simulator/network` returns the current network plus simulator topology context.
- `POST /api/simulator/span-fault` with `{ "dtId": "DT-001", "atPoleId": "P-024431" }` injects a downstream span fault.
- `POST /api/simulator/dt-fault` with `{ "dtId": "DT-001" }` injects a full DT outage.
- `POST /api/simulator/feeder-fault` with `{ "feederId": "F-01" }` injects a feeder outage.
- `POST /api/simulator/dead-sensor` with `{ "poleId": "P-024431" }` silences one sensor without sending `power_lost`.
- `POST /api/simulator/scheduled-outage` with `{ "scope": "dt", "targetId": "DT-001" }` or `{ "scope": "feeder", "targetId": "F-01" }` creates an active maintenance window and injects dark telemetry.
- `POST /api/simulator/duplicate-telemetry` with `{ "poleId": "P-024431" }` sends the same packet twice to demonstrate telemetry deduplication.
- `POST /api/simulator/out-of-order-telemetry` with `{ "poleId": "P-024431" }` sends a higher sequence packet before a lower sequence packet to demonstrate sequence ordering.
- `POST /api/simulator/repair/:incidentId` sends `boot` and `power_restored` telemetry for an incident's affected poles.

---

# Incident Lifecycle

```text
Detected

↓

Acknowledged

↓

Crew Assigned

↓

Resolved

↓

Verified

↓

Closed
```

---

# Fault Types Supported

- Span Fault
- Distribution Transformer (DT) Fault
- Feeder Fault
- Dead Sensor
- Scheduled Outage / Maintenance Window
- Duplicate Telemetry Packet
- Out-of-Order Telemetry Packet

---

# AI Dispatch Notes

`POST /api/incidents/:id/dispatch-note` generates and stores a crew-ready field dispatch note from an already-localized incident record.

The backend uses the Google Gemini API with `gemini-2.5-flash` by default. Set `GEMINI_API_KEY` to enable LLM notes. If the provider request fails or times out, the API stores a deterministic template fallback note instead.

The LLM receives structured incident fields only, not raw telemetry.

---

# Dashboard

The operator dashboard provides:

- Live network visualization
- Active incident monitoring
- Incident timeline
- Grid health metrics
- Fault simulator
- AI dispatch notes

---

# Design Decisions

Design decision documentation can be added in a future `DECISIONS.md` file.

---

# Known Limitations

- No frontend marker clustering
- Fixed-interval detection loop
- Single-instance topology cache
- Scheduled outage cancellation UI is not implemented
- Leaflet assets are loaded externally

---

# Future Improvements

- Marker clustering
- Event-driven detection
- Distributed cache
- Better outage cancellation handling
- Offline Leaflet assets

---

# License

For educational purposes only.
